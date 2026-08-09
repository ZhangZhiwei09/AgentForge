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
"""

import asyncio
import functools
import json
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import TypeVar, cast

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pydantic import Field as PydField
from sqlalchemy import and_, select
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.chat_agent import ChatAgent
from src.agent.context_builder import ContextBuilder
from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.executor import AgentExecutor
from src.agent.redis_memory import mirror_message
from src.agent.router.pipeline import QueryRouter
from src.agent.tools.registry import tool_registry
from src.agent.types import (
    ClarificationNeeded,
    DiagnosisCompleted,
    DiagnosisPhase,
    DiagnosisPhaseDone,
    DiagnosisStarted,
    DiagnosisWaitingInput,
    RouteContext,
    RouteName,
    RouterDecision,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)
from src.api.deps import get_current_user, get_db
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


# ── SSE 序列化 ──────────────────────────────────────────────────


@functools.singledispatch
def _sse_payload(event: object) -> dict:
    """将单个 Agent 事件序列化为 SSE payload dict（未知类型走兜底）。

    新增事件类型时，只需再注册一个 _sse_payload 的 overload。
    """
    return {
        "type": getattr(event, "type", "unknown"),
        "message_id": getattr(event, "message_id", ""),
    }


@_sse_payload.register
def _(event: StreamToken) -> dict:
    return {"type": "token", "content": event.content, "message_id": event.message_id}


@_sse_payload.register
def _(event: StreamDone) -> dict:
    return {
        "type": "done",
        "message_id": event.message_id,
        "usage": event.usage,
        "suggestions": event.suggestions,
        "validated": event.validated,
        "fallback_used": event.fallback_used,
        "route": event.route,
    }


@_sse_payload.register
def _(event: StreamError) -> dict:
    return {"type": "error", "content": event.content}


@_sse_payload.register
def _(event: StreamMeta) -> dict:
    return {
        "type": event.type,
        "message_id": event.message_id,
        "conversation_id": getattr(event, "conversation_id", ""),
        "session_id": event.session_id,
        "model": event.model,
        "provider": event.provider,
        "route": event.route,
        "intent": getattr(event, "intent", ""),
        "within_service_hours": getattr(event, "within_service_hours", None),
        "memory_count": getattr(event, "memory_count", 0),
    }


@_sse_payload.register
def _(event: DiagnosisStarted) -> dict:
    return {"type": "diagnosis_started", "message_id": event.message_id, "agents": event.agents}


@_sse_payload.register
def _(event: DiagnosisPhase) -> dict:
    return {"type": "diagnosis_phase", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label}


@_sse_payload.register
def _(event: DiagnosisPhaseDone) -> dict:
    return {"type": "diagnosis_phase_done", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label, "summary": event.summary}


@_sse_payload.register
def _(event: DiagnosisCompleted) -> dict:
    return {"type": "diagnosis_completed", "message_id": event.message_id, "output": event.output}


@_sse_payload.register
def _(event: ClarificationNeeded) -> dict:
    return {
        "type": "clarification_needed",
        "message_id": event.message_id,
        "intent": event.intent,
        "missing_fields": event.missing_fields,
        "prompt_message": event.prompt_message,
        "hints": event.hints,
    }


@_sse_payload.register
def _(event: DiagnosisWaitingInput) -> dict:
    # Phase 3b HITL：诊断在阶段边界暂停，等待用户补充信息。
    return {
        "type": "diagnosis_waiting_input",
        "message_id": event.message_id,
        "message": event.message,
        "missing_fields": event.missing_fields,
    }


async def _to_sse(events: AsyncIterator) -> AsyncIterator[str]:
    """将 Agent 事件流转为 SSE 格式字符串流。"""
    async for event in events:
        payload = json.dumps(_sse_payload(event), ensure_ascii=False)
        yield f"data: {payload}\n\n"


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


async def _find_conversation(
    db: AsyncSession, conv_id: str, *, conv_type: str | None = None
) -> Conversation | None:
    """按 id 查询会话，可选按类型过滤；不存在返回 None。

    注意：不做归属校验，调用方按各自语义处理 403/404 或返回空。
    """
    stmt = select(Conversation).where(Conversation.id == conv_id)
    if conv_type is not None:
        stmt = stmt.where(Conversation.type == conv_type)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def _serialize_message(m: Message) -> dict:
    """消息 → API 输出 dict（多个端点复用的统一序列化）。"""
    return {
        "id": m.id,
        "role": m.role,
        "type": m.type,
        "content": m.content,
        "timestamp": m.created_at.isoformat(),
    }


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


# ═══════════════════════════════════════════════════════════
# GET /api/agent/chat/history —— 游标分页消息历史（PR4 增强）
# ═══════════════════════════════════════════════════════════


@agent_router.get("/chat/history")
async def agent_chat_history(
    conversation_id: str = Query(..., description="会话 ID"),
    before_time: str | None = Query(None, description="游标：ISO 时间戳"),
    before_id: str | None = Query(None, description="游标：消息 ID"),
    limit: int = Query(5, ge=1, le=20, description="每页条数"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取会话消息历史，支持复合游标分页。

    首次加载：只传 conversation_id + limit
    翻页：传 conversation_id + limit + before_time + before_id
    """
    # 验证 ownership
    conv = await _find_conversation(db, conversation_id, conv_type="agent_chat")
    if conv is None:
        return {"conversation_id": conversation_id, "messages": [], "has_more": False}
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权访问此会话")

    # 构建查询
    conditions = [Message.conversation_id == conversation_id]

    if before_time and before_id:
        # 复合游标：(created_at, id) < (cursor_time, cursor_id)
        cursor_time = datetime.fromisoformat(before_time)
        conditions.append(
            sa_text(
                "(messages.created_at, messages.id) < (:cursor_time, :cursor_id)"
            ).bindparams(cursor_time=cursor_time, cursor_id=before_id)
        )

    query = (
        select(Message)
        .where(and_(*conditions))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit + 1)  # 多取 1 条判断 has_more
    )

    result = await db.execute(query)
    rows = result.scalars().all()

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    # 反序恢复时间升序（前端展示用）
    rows = list(reversed(rows))

    messages = [_serialize_message(m) for m in rows]

    next_cursor = None
    if has_more and rows:
        oldest = rows[0]
        next_cursor = {
            "before_time": oldest.created_at.isoformat(),
            "before_id": oldest.id,
        }

    return {
        "conversation_id": conversation_id,
        "messages": messages,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


# ═══════════════════════════════════════════════════════════
# GET /api/agent/chat/conversations —— 会话列表
# ═══════════════════════════════════════════════════════════


@agent_router.get("/chat/conversations")
async def agent_conversations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户所有 agent_chat 会话，按更新时间倒序。"""
    result = await db.execute(
        select(Conversation)
        .where(
            Conversation.user_id == user.id,
            Conversation.type == "agent_chat",
        )
        .order_by(Conversation.updated_at.desc())
    )
    conversations = result.scalars().all()

    conv_list = []
    for conv in conversations:
        # 获取首条用户消息作为预览
        first_msg_result = await db.execute(
            select(Message.content)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.created_at.asc())
            .limit(1)
        )
        first_msg = first_msg_result.scalar_one_or_none()

        conv_list.append({
            "id": conv.id,
            "title": conv.title,
            "conversation_id": conv.id,
            "session_id": conv.id,  # 向后兼容：前端旧代码用 session_id
            "created_at": conv.created_at.isoformat(),
            "updated_at": conv.updated_at.isoformat(),
            "first_message": first_msg[:100] if first_msg else None,
        })

    return {"conversations": conv_list}


# ═══════════════════════════════════════════════════════════
# DELETE /api/agent/chat/conversations/:id
# ═══════════════════════════════════════════════════════════


@agent_router.delete("/chat/conversations/{conv_id}")
async def agent_delete_conversation(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除会话 —— 验证 ownership 后级联删除。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除此会话")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# FAQ（保留兼容，暂不实现）
# ═══════════════════════════════════════════════════════════


@agent_router.get("/chat/faq/categories")
async def agent_faq_categories():
    """FAQ 分类列表。"""
    return {"categories": []}


# ═══════════════════════════════════════════════════════════
# /api/conversations —— 向后兼容别名
# ═══════════════════════════════════════════════════════════

conversations_router = APIRouter(prefix="/api", tags=["conversations"])


@conversations_router.get("/conversations")
async def list_conversations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """会话列表 —— GET /api/conversations（向后兼容）。"""
    result = await db.execute(
        select(Conversation.id, Conversation.title, Conversation.created_at, Conversation.updated_at)
        .where(
            Conversation.user_id == user.id,
            Conversation.type == "agent_chat",
        )
        .order_by(Conversation.updated_at.desc())
    )
    rows = result.all()
    return {
        "conversations": [
            {
                "id": row.id,
                "title": row.title,
                "session_id": row.id,
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
                "first_message": None,
            }
            for row in rows
        ]
    }


@conversations_router.get("/conversations/{conv_id}/messages")
async def get_conversation_messages(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取会话消息列表 —— GET /api/conversations/:id/messages（向后兼容）。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None or conv.user_id != user.id:
        return {"conversation_id": conv_id, "messages": []}

    msg_result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv_id)
        .order_by(Message.created_at.asc())
    )
    messages = msg_result.scalars().all()
    return {
        "conversation_id": conv_id,
        "messages": [_serialize_message(m) for m in messages],
    }


@conversations_router.delete("/conversations/{conv_id}")
async def delete_conversation_alias(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除会话 —— DELETE /api/conversations/:id（向后兼容）。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除此会话")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}


