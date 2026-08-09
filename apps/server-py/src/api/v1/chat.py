"""Chat API —— POST /api/agent/chat 流式聊天端点。

流程:
    用户消息 → get_or_create_conversation → 保存用户消息
    → Router(L1关键词) → AgentExecutor(ReAct) → SSE Stream
    → 保存助手消息 → 异步触发压缩检查

路由:
    SAFETY → 安全拦截
    CHAT   → 直接 LLM 回复
    TASK   → ReAct AgentExecutor（工具调用）
    HUMAN  → 转人工
    DIAGNOSIS → Multi-Agent 故障诊断

模块边界：
    SSE 序列化在 sse.py；会话资源端点（历史/列表/删除/FAQ）在 conversations.py。
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import TypeVar, cast

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pydantic import Field as PydField
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.chat_agent import ChatAgent
from src.agent.context_builder import ContextBuilder
from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.executor import AgentExecutor
from src.agent.redis_memory import mirror_message
from src.agent.router.pipeline import QueryRouter
from src.agent.tools.registry import tool_registry
from src.agent.types import (
    RouteContext,
    RouteName,
    RouterDecision,
    StreamDone,
    StreamToken,
)
from src.api.deps import get_current_user, get_db
from src.api.v1.conversations import _find_conversation
from src.api.v1.sse import _to_sse
from src.config import settings
from src.models.chat import Conversation, Message
from src.models.user import User
from src.providers.registry import resolve_model
from src.schemas.chat import ChatMessage, ChatRequest

router = APIRouter(prefix="/api/v1", tags=["chat"])

logger = logging.getLogger(__name__)

T = TypeVar("T")

# ── 模块级单例 ──
_singletons: dict[type, object] = {}


def _get_singleton(cls: type[T]) -> T:
    """惰性初始化并复用进程内单例。"""
    instance = _singletons.get(cls)
    if instance is None:
        instance = _singletons[cls] = cls()
    return cast(T, instance)


# ── 会话级并发控制 ──
_conversation_locks: dict[str, asyncio.Lock] = {}


def _get_executor() -> AgentExecutor:
    return _get_singleton(AgentExecutor)


def _get_chat_agent() -> ChatAgent:
    return _get_singleton(ChatAgent)


def _get_diagnosis_agent() -> DiagnosisRouteAgent:
    return _get_singleton(DiagnosisRouteAgent)


def _acquire_lock(conversation_id: str) -> asyncio.Lock:
    """获取或创建会话级别的异步锁，防止同一会话并发消息乱序。"""
    if conversation_id not in _conversation_locks:
        _conversation_locks[conversation_id] = asyncio.Lock()
    return _conversation_locks[conversation_id]


def _to_router_history(msgs: list) -> list[ChatMessage]:
    """从 ContextBuilder 组装的消息列表提取路由历史（供 L3/L4 用）。

    - 跳过 SystemMessage（系统提示不是对话历史）
    - 丢弃末尾当前用户消息（classify(message, history) 单独传 message，
      L3/L4 会把它追加为最后一条，避免重复）
    - 截取最近 router_llm_history_window 条
    """
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    out: list[ChatMessage] = []
    for m in msgs:
        if isinstance(m, SystemMessage):
            continue
        if isinstance(m, HumanMessage):
            role = "user"
        elif isinstance(m, AIMessage):
            role = "assistant"
        else:
            role = getattr(m, "role", "")
        content = str(m.content) if m.content else ""
        if role and content:
            out.append(ChatMessage(role=role, content=content))

    if out and out[-1].role == "user":
        out.pop()

    return out[-settings.router_llm_history_window:]


# ── 常量 ──────────────────────────────────────────────────────
SAFETY_RESPONSE = "抱歉，您的消息包含不安全内容，无法处理。如有需要，请联系人工客服。"


# ── 安全拦截 / 转人工 ──────────────────────────────────────


async def _stream_safety(assistant_msg_id: str) -> AsyncIterator:
    yield StreamToken(content=SAFETY_RESPONSE, message_id=assistant_msg_id)
    yield StreamDone(message_id=assistant_msg_id, usage={}, route=RouteName.SAFETY.value, fallback_used=True)


async def _stream_human(assistant_msg_id: str) -> AsyncIterator:
    human_msg = "正在为您转接人工客服，请稍候..."
    for char in human_msg:
        yield StreamToken(content=char, message_id=assistant_msg_id)
    yield StreamDone(message_id=assistant_msg_id, usage={}, route=RouteName.HUMAN.value)


# ── 会话持久化辅助函数 ──────────────────────────────────────


async def _get_or_create_conversation(
    db: AsyncSession, user_id: str, conversation_id: str | None
) -> Conversation:
    """获取或创建会话。

    - 有 conversation_id → 查找已有会话，验证 ownership
    - 无 → 新建会话
    """
    if conversation_id:
        conv = await _find_conversation(db, conversation_id, conv_type="agent_chat")
        if conv is not None:
            # 验证 ownership（防止跨用户访问）
            if conv.user_id != user_id:
                raise HTTPException(status_code=403, detail="无权访问此会话")
            return conv

    # 新建会话
    new_id = str(uuid.uuid4())
    conv = Conversation(
        id=new_id,
        title="新对话",
        user_id=user_id,
        type="agent_chat",
        status="active",
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


# ═══════════════════════════════════════════════════════════
# 核心聊天处理
# ═══════════════════════════════════════════════════════════


def _build_route_context(
    *,
    conversation_id: str,
    user_message: str,
    resolved_model: str,
    provider_name: str,
    assistant_msg_id: str,
    intent: str,
    prebuilt_messages: list | None = None,
) -> RouteContext:
    """构造 Agent 执行上下文（各路由共享的公共字段）。"""
    return RouteContext(
        conversation_id=conversation_id,
        user_message=user_message,
        prebuilt_messages=[] if prebuilt_messages is None else prebuilt_messages,
        resolved_model=resolved_model,
        provider_name=provider_name,
        assistant_msg_id=assistant_msg_id,
        intent=intent,
    )


def _select_events(
    decision: RouterDecision,
    *,
    conversation_id: str,
    user_message: str,
    prebuilt_messages: list,
    resolved_model: str,
    provider_name: str,
    assistant_msg_id: str,
) -> AsyncIterator:
    """按路由决策选择对应的事件流。

    SAFETY → 安全拦截文案；HUMAN → 转人工；其余交给对应 Agent 执行。
    """
    route = decision.route

    if route == RouteName.SAFETY:
        return _stream_safety(assistant_msg_id)
    if route == RouteName.HUMAN:
        return _stream_human(assistant_msg_id)

    if route == RouteName.CHAT:
        context = _build_route_context(
            conversation_id=conversation_id,
            user_message=user_message,
            prebuilt_messages=prebuilt_messages,
            resolved_model=resolved_model,
            provider_name=provider_name,
            assistant_msg_id=assistant_msg_id,
            intent="chat",
        )
        return _get_chat_agent().execute(context)

    if route == RouteName.DIAGNOSIS:
        context = _build_route_context(
            conversation_id=conversation_id,
            user_message=user_message,
            resolved_model=resolved_model,
            provider_name=provider_name,
            assistant_msg_id=assistant_msg_id,
            intent="diagnosis",
        )
        return _get_diagnosis_agent().execute(context, tool_registry)

    # TASK 兜底：ReAct + Tool
    context = _build_route_context(
        conversation_id=conversation_id,
        user_message=user_message,
        prebuilt_messages=prebuilt_messages,
        resolved_model=resolved_model,
        provider_name=provider_name,
        assistant_msg_id=assistant_msg_id,
        intent=route.value,
    )
    return _get_executor().execute(context)


async def _save_user_message(
    db: AsyncSession,
    conv: Conversation,
    message: str,
    model_id: str,
) -> Message:
    """持久化用户消息并更新会话时间戳（含 Redis 镜像）。"""
    user_msg = Message(
        id=str(uuid.uuid4()),
        conversation_id=conv.id,
        role="user",
        type="text",
        content=message,
        model=model_id,
    )
    db.add(user_msg)
    await db.commit()

    # 镜像到 Redis 短期记忆窗口（尽力而为，失败零影响）
    await mirror_message(db, conv.id, user_msg)

    # 更新会话 updated_at
    conv.updated_at = datetime.now(UTC)
    db.add(conv)
    await db.commit()
    return user_msg


async def _save_assistant_message(
    db: AsyncSession,
    conversation_id: str,
    assistant_msg_id: str,
    model_id: str,
    streamed_answer: list[str],
) -> None:
    """保存助手回复并镜像到 Redis；无输出时跳过。"""
    final_answer = "".join(streamed_answer)
    if not final_answer:
        return

    assistant_msg = Message(
        id=assistant_msg_id,
        conversation_id=conversation_id,
        role="assistant",
        type="text",
        content=final_answer,
        model=model_id,
    )
    db.add(assistant_msg)
    await db.commit()

    # 镜像到 Redis 短期记忆窗口（尽力而为，失败零影响）
    await mirror_message(db, conversation_id, assistant_msg)


async def _handle_chat(
    message: str,
    model: str | None,
    db: AsyncSession,
    user: User,
    conversation_id: str | None = None,
) -> StreamingResponse:
    """共享聊天处理：持久化 → Router → AgentExecutor → SSE → 保存回复。"""
    from src.observability import get_observability

    resolved = resolve_model(model)
    assistant_msg_id = str(uuid.uuid4())

    # ── 1. 会话管理 ──
    conv = await _get_or_create_conversation(db, user.id, conversation_id)
    actual_conv_id = conv.id

    # ── 并发控制 ──
    lock = _acquire_lock(actual_conv_id)

    async def _persisted_events():
        async with lock:
            # ── 1. ContextBuilder 组装上下文（含摘要 + Token Budget）──
            builder = ContextBuilder(db)
            ctx_result = await builder.build(actual_conv_id, message)

            # ── 2. 保存用户消息 ──
            await _save_user_message(db, conv, message, resolved["model_id"])

            # ── 3. 路由 + 选择 Agent 事件流 ──
            # 按请求构造 router（携带 resolved model，供 L3/L4 LLM 分类）
            router = QueryRouter(resolved["model_id"])
            decision = await router.classify(
                message, _to_router_history(ctx_result.messages)
            )
            events = _select_events(
                decision,
                conversation_id=actual_conv_id,
                user_message=message,
                prebuilt_messages=ctx_result.messages,
                resolved_model=resolved["model_id"],
                provider_name=resolved["provider_name"],
                assistant_msg_id=assistant_msg_id,
            )

            # ── 4. Langfuse Trace + 流式输出 ──
            obs = get_observability()
            streamed_answer: list[str] = []

            async with obs.create_trace(
                "chat-request",
                input=message,
                metadata={
                    "route": decision.route.value,
                    "model": resolved["model_id"],
                    "conversation_id": actual_conv_id,
                },
            ):
                async for event in events:
                    if isinstance(event, StreamToken):
                        streamed_answer.append(event.content)
                    yield event

            # ── 5. 保存助手消息 ──
            await _save_assistant_message(
                db, actual_conv_id, assistant_msg_id, resolved["model_id"], streamed_answer
            )

            # ── 6. 异步压缩检查（非阻塞，失败不影响主流程）──
            _spawn_compression(db, actual_conv_id)

    return StreamingResponse(
        _to_sse(_persisted_events()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 压缩检查（异步、非关键路径）──────────────────────────────

# 保存压缩任务的强引用，防止 asyncio 在任务完成前回收它
_compression_tasks: set[asyncio.Task] = set()


def _spawn_compression(db: AsyncSession, conversation_id: str) -> None:
    """异步触发压缩检查（非阻塞，失败不影响主流程）。"""
    try:
        task = asyncio.create_task(_maybe_compress(db, conversation_id))
        _compression_tasks.add(task)
        task.add_done_callback(_compression_tasks.discard)
    except Exception:
        logger.warning(
            "Failed to schedule compression for conversation %s",
            conversation_id,
            exc_info=True,
        )


async def _maybe_compress(db: AsyncSession, conversation_id: str) -> None:
    """检查是否需要压缩，如果是则触发 LLM 摘要生成。

    异步非阻塞：失败不影响 Agent 主流程。
    TODO: 生产环境改用 Redis Queue (arq) 替代 asyncio.create_task。
    """
    try:
        from src.agent.summary_compressor import SummaryCompressor

        compressor = SummaryCompressor(db)
        await compressor.compress(conversation_id)
    except Exception:
        logger.warning(
            "Conversation %s compression failed", conversation_id, exc_info=True
        )


# ═══════════════════════════════════════════════════════════
# POST /api/v1/chat —— V1 兼容端点
# ═══════════════════════════════════════════════════════════


@router.post("/chat")
async def chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """流式聊天端点 —— POST /api/v1/chat。"""
    return await _handle_chat(body.message, body.model, db, user)


# ═══════════════════════════════════════════════════════════
# POST /api/agent/chat —— 智能客服前端端点
# ═══════════════════════════════════════════════════════════


class AgentChatRequest(BaseModel):
    message: str = PydField(min_length=1)
    conversation_id: str | None = None


agent_router = APIRouter(prefix="/api/agent", tags=["agent-chat"])


@agent_router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Agent 聊天端点 —— 需要认证，支持会话持久化和历史记忆。"""
    return await _handle_chat(body.message, None, db, user, body.conversation_id)




