"""ContextBuilder —— Agent 上下文组装器。

负责将 DB 中的历史消息 + 摘要记忆组装为 LangChain messages，
供 AgentExecutor 直接消费。

Pipeline:
    Collect → Rank → Budget → Compress(Summary) → Assemble

核心职责:
    1. Token 预算管理 —— 不是按条数，而是按 token 数截断
    2. 滑动窗口 —— 最近 N 条保持原始，旧消息用摘要替代
    3. 摘要注入 —— 摘要放入 SystemMessage（背景知识），而非对话消息
"""

import logging
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.chat import Conversation, ConversationMemory, Message

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────────
MAX_CONTEXT_TOKENS = 4000      # Agent 上下文总 token 预算（不含 system prompt）
RAW_WINDOW = 10                # 最近保持原始的消息条数
SUMMARY_MAX_TOKENS = 300       # 压缩摘要最大 token 数（仅用于提示 LLM 压缩时）
COMPRESSION_THRESHOLD = 20     # 总消息数超过此值触发压缩检查

SYSTEM_PROMPT = """你是核身排障智能助手，专门帮助用户诊断和解决身份核身（人脸核身、活体检测、OCR 识别）相关的技术问题。

## 你的专业领域
- 核身错误码排查（FACE_TIMEOUT、LIVENESS_FAIL、NETWORK_TIMEOUT、SDK_VERSION_TOO_OLD、CAMERA_PERMISSION_DENIED 等）
- SDK 集成诊断（H5、小程序、App 端）
- 商户接入配置与通过率优化
- 核身批量失败应急响应

## 回答规则
1. 先理解用户的问题，提取关键信息（错误码、端类型、产品类型等）
2. 使用 search_knowledge_base 工具查询核身知识库获取排查方案
3. 基于工具返回的知识库内容，用自然语言给出结构化的排查建议
4. 回答要包含：原因分析 → 排查步骤 → 处理方案，使用 Markdown 列表或表格组织
5. 如果知识库没有覆盖用户的问题，如实告知并建议联系技术支持
6. 必要时引导用户补充更多诊断信息（如 trace 日志、SDK 版本、端类型等）

## 重要
- 严格基于知识库返回的内容回答，不要编造任何技术细节
- 每次只调用一个工具，等待结果后再决定下一步
- 如果用户问题不属于核身领域，礼貌说明你的专业范围"""


@dataclass
class ContextResult:
    """ContextBuilder 组装结果。"""
    messages: list[BaseMessage] = field(default_factory=list)
    history_count: int = 0
    has_summary: bool = False
    estimated_tokens: int = 0


class ContextBuilder:
    """Agent 上下文组装器。

    用法:
        builder = ContextBuilder(db)
        result = await builder.build(conversation_id, user_message)
        # result.messages 可直接传入 AgentState
    """

    def __init__(
        self,
        db: AsyncSession,
        *,
        max_context_tokens: int = MAX_CONTEXT_TOKENS,
        raw_window: int = RAW_WINDOW,
        system_prompt: str | None = None,
    ) -> None:
        self._db = db
        self._max_context_tokens = max_context_tokens
        self._raw_window = raw_window
        self._system_prompt = system_prompt or SYSTEM_PROMPT

    async def build(
        self, conversation_id: str, user_message: str
    ) -> ContextResult:
        """组装 Agent 上下文。

        Args:
            conversation_id: 会话 ID
            user_message: 当前用户消息

        Returns:
            ContextResult: 包含组装好的 messages 列表和元信息
        """
        # ── 1. 加载 Conversation + Memory ──
        conv = await self._load_conversation(conversation_id)
        memory = await self._load_memory(conversation_id)

        # ── 2. 加载最近消息 ──
        recent_messages = await self._load_recent_messages(conversation_id)

        # ── 3. 构建 System Prompt ──
        system_content = self._system_prompt

        has_summary = memory is not None and memory.summary
        if has_summary:
            system_content += f"\n\n## 历史对话摘要\n{memory.summary}\n\n请结合以上历史摘要信息来理解用户的上下文。"

        # ── 4. Token 预算管理 ──
        system_msg = SystemMessage(content=system_content)
        # 当前用户消息计入预算
        budget = self._max_context_tokens - _estimate_tokens(user_message)

        # 从最近的消息倒序取，直到 budget 用完
        selected: list[Message] = []
        for msg in reversed(recent_messages):
            tokens = _estimate_tokens(msg.content)
            if budget - tokens < 0:
                break
            selected.insert(0, msg)
            budget -= tokens

        # ── 5. 组装 LangChain messages ──
        history_msgs: list[BaseMessage] = []
        for msg in selected:
            if msg.role == "user":
                history_msgs.append(HumanMessage(content=msg.content))
            elif msg.role == "assistant":
                history_msgs.append(AIMessage(content=msg.content))
            elif msg.role == "system":
                history_msgs.append(SystemMessage(content=msg.content))
            # tool 角色暂不处理（未来扩展）

        all_messages = [system_msg] + history_msgs + [HumanMessage(content=user_message)]

        total_tokens = sum(_estimate_tokens(m.content) for m in all_messages)

        return ContextResult(
            messages=all_messages,
            history_count=len(selected),
            has_summary=has_summary,
            estimated_tokens=total_tokens,
        )

    async def _load_conversation(self, conversation_id: str) -> Conversation | None:
        result = await self._db.execute(
            select(Conversation).where(Conversation.id == conversation_id)
        )
        return result.scalar_one_or_none()

    async def _load_memory(self, conversation_id: str) -> ConversationMemory | None:
        result = await self._db.execute(
            select(ConversationMemory).where(
                ConversationMemory.conversation_id == conversation_id
            )
        )
        return result.scalar_one_or_none()

    async def _load_recent_messages(
        self, conversation_id: str
    ) -> list[Message]:
        """加载最近 N 条消息用于上下文组装。

        取 RAW_WINDOW * 2 条候选，由 Budget 阶段筛选。
        """
        result = await self._db.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(self._raw_window * 2)
        )
        rows = result.scalars().all()
        return list(reversed(rows))  # 恢复时间升序


# ── Token 估算 ─────────────────────────────────────────────────

def _estimate_tokens(text: str) -> int:
    """粗略估算文本 token 数。

    中文：约 1.5 字符/token
    英文：约 4 字符/token
    这里取保守估计：2 字符/token。

    生产环境应使用 tiktoken 等精确计数。
    """
    if not text:
        return 0
    return max(1, len(text) // 2)
