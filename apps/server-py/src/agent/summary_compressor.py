"""SummaryCompressor —— 会话摘要压缩器。

在对话超过阈值时，通过 LLM 将旧消息压缩为摘要，
存入 ConversationMemory 表，供 ContextBuilder 注入。

压缩模式:
    - 首次压缩：取超出 RAW_WINDOW 的旧消息 → LLM → 摘要
    - 增量压缩：已有摘要 + 新消息 → LLM → 合并摘要

策略:
    - 异步非阻塞：压缩失败不影响 Agent 主流程
    - 幂等：covered_until_message_id 保证不重复压缩

TODO: 生产环境应改用 Redis Queue (arq) 替代 asyncio.create_task，
       以支持多 worker 部署时的任务持久化。
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.chat import ConversationMemory, Message
from src.providers.registry import get_provider, resolve_model
from src.schemas.chat import ChatMessage

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────────
RAW_WINDOW = 10
COMPRESSION_THRESHOLD = 20
SUMMARY_MAX_TOKENS = 300
COMPRESSION_MODEL = "gpt-4o-mini"  # 摘要用便宜模型

COMPRESSION_PROMPT = """将以下对话历史压缩为一段简洁摘要（中文），保留关键信息：
- 用户的核心问题和需求
- AI 给出的重要结论和建议
- 未解决的事项（如果有）
- 关键实体（产品名、订单号、错误码等）

请控制在 {max_tokens} token 以内，用自然段落形式组织。

对话历史：
{conversation_text}"""

MERGE_PROMPT = """以下是已有的对话摘要和新增的对话消息，请将它们合并为一段更新后的简洁摘要（中文）。

已有摘要：
{existing_summary}

新增对话：
{new_messages}

请保留所有关键信息，控制在 {max_tokens} token 以内。"""


class SummaryCompressor:
    """会话摘要压缩器。

    用法:
        compressor = SummaryCompressor(db)
        await compressor.compress(conversation_id)
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def compress(self, conversation_id: str) -> None:
        """检查并执行压缩。

        幂等：如果不需要压缩（消息数不足或已覆盖），直接返回。
        失败：catch + log，不抛异常。
        """
        try:
            # ── 1. 检查是否需要压缩 ──
            total = await self._count_messages(conversation_id)
            if total <= COMPRESSION_THRESHOLD:
                return

            # ── 2. 加载已有的 ConversationMemory ──
            memory = await self._get_memory(conversation_id)

            if memory and memory.summary:
                # ── 增量压缩 ──
                await self._incremental_compress(conversation_id, memory)
            else:
                # ── 首次压缩 ──
                await self._initial_compress(conversation_id, total)

        except Exception as exc:
            logger.warning(
                "Summary compression failed for conversation %s: %s",
                conversation_id, exc,
            )

    async def _count_messages(self, conversation_id: str) -> int:
        result = await self._db.execute(
            select(func.count(Message.id)).where(
                Message.conversation_id == conversation_id
            )
        )
        return result.scalar() or 0

    async def _get_memory(self, conversation_id: str) -> ConversationMemory | None:
        result = await self._db.execute(
            select(ConversationMemory).where(
                ConversationMemory.conversation_id == conversation_id
            )
        )
        return result.scalar_one_or_none()

    async def _initial_compress(
        self, conversation_id: str, total: int
    ) -> None:
        """首次压缩：取超出 RAW_WINDOW 的旧消息，生成摘要。"""
        # 取除最近 RAW_WINDOW 条之外的所有消息
        skip_count = total - RAW_WINDOW
        if skip_count <= 0:
            return

        result = await self._db.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
            .limit(skip_count)
        )
        old_messages = result.scalars().all()

        if not old_messages:
            return

        # 格式化对话文本
        conversation_text = self._format_messages(old_messages)
        prompt = COMPRESSION_PROMPT.format(
            max_tokens=SUMMARY_MAX_TOKENS,
            conversation_text=conversation_text,
        )

        # 调用 LLM
        summary = await self._call_llm(prompt)
        if not summary:
            return

        # 写入 ConversationMemory
        covered_until_id = old_messages[-1].id
        await self._upsert_memory(
            conversation_id, summary, covered_until_id
        )

        logger.info(
            "Initial compression done for conversation %s: %d messages → summary (%d chars), covered until %s",
            conversation_id, skip_count, len(summary), covered_until_id,
        )

    async def _incremental_compress(
        self, conversation_id: str, memory: ConversationMemory
    ) -> None:
        """增量压缩：已有摘要 + 上次压缩之后的新消息 → 合并摘要。"""
        if not memory.covered_until_message_id:
            return

        # 取 covered_until 之后的所有消息
        result = await self._db.execute(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.created_at > (
                    select(Message.created_at).where(
                        Message.id == memory.covered_until_message_id
                    ).scalar_subquery()
                ),
            )
            .order_by(Message.created_at.asc())
        )
        new_messages = result.scalars().all()

        if not new_messages:
            return

        # 只保留超出 RAW_WINDOW 的部分（最近 RAW_WINDOW 条保持原始）
        total = await self._count_messages(conversation_id)
        raw_count = len(new_messages)
        compress_count = max(0, raw_count - RAW_WINDOW)

        if compress_count <= 0:
            return

        messages_to_compress = new_messages[:compress_count]
        prompt = MERGE_PROMPT.format(
            existing_summary=memory.summary,
            new_messages=self._format_messages(messages_to_compress),
            max_tokens=SUMMARY_MAX_TOKENS,
        )

        # 调用 LLM
        summary = await self._call_llm(prompt)
        if not summary:
            return

        # 更新 ConversationMemory
        covered_until_id = messages_to_compress[-1].id
        await self._upsert_memory(
            conversation_id, summary, covered_until_id
        )

        logger.info(
            "Incremental compression done for conversation %s: new summary (%d chars), covered until %s",
            conversation_id, len(summary), covered_until_id,
        )

    async def _upsert_memory(
        self,
        conversation_id: str,
        summary: str,
        covered_until_message_id: str,
    ) -> None:
        """写入或更新 ConversationMemory 记录。"""
        import uuid

        existing = await self._get_memory(conversation_id)
        token_count = len(summary) // 2  # 粗略估算

        if existing:
            existing.summary = summary
            existing.covered_until_message_id = covered_until_message_id
            existing.token_count = token_count
            existing.updated_at = datetime.now(timezone.utc)
            self._db.add(existing)
        else:
            mem = ConversationMemory(
                id=str(uuid.uuid4()),
                conversation_id=conversation_id,
                summary=summary,
                covered_until_message_id=covered_until_message_id,
                token_count=token_count,
                memory_type="summary",
            )
            self._db.add(mem)

        await self._db.commit()

    async def _call_llm(self, prompt: str) -> str | None:
        """调用 LLM 生成摘要。非流式，返回完整结果。"""
        try:
            resolved = resolve_model(COMPRESSION_MODEL)
            provider = get_provider(resolved["provider_name"])

            result = await provider.chat_sync(
                messages=[ChatMessage(role="user", content=prompt)],
                model=resolved["model_id"],
                temperature=0.3,  # 低温度，保证摘要稳定
                max_tokens=SUMMARY_MAX_TOKENS,
            )
            return result.content
        except Exception as exc:
            logger.warning("LLM compression call failed: %s", exc)
            return None

    @staticmethod
    def _format_messages(messages: list[Message]) -> str:
        """格式化消息列表为对话文本。"""
        lines: list[str] = []
        for m in messages:
            role_label = {"user": "用户", "assistant": "AI", "system": "系统"}.get(
                m.role, m.role
            )
            # 截断过长消息
            content = m.content if len(m.content) <= 500 else m.content[:500] + "..."
            lines.append(f"[{role_label}]: {content}")
        return "\n".join(lines)
