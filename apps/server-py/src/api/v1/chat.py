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
import json
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field as PydField
from sqlalchemy import and_, func, select, text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.chat_agent import ChatAgent
from src.agent.executor import AgentExecutor
from src.agent.router.pipeline import QueryRouter
from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.context_builder import ContextBuilder
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
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)
from src.api.deps import get_current_user, get_db
from src.models.chat import Conversation, ConversationMemory, Message
from src.models.user import User
from src.providers.registry import resolve_model
from src.schemas.chat import ChatRequest

router = APIRouter(prefix="/api/v1", tags=["chat"])

# ── 模块级单例 ──
_router: QueryRouter | None = None
_executor: AgentExecutor | None = None
_chat_agent: ChatAgent | None = None
_diagnosis_agent: DiagnosisRouteAgent | None = None

# ── 会话级并发控制 ──
_conversation_locks: dict[str, asyncio.Lock] = {}


def _get_router() -> QueryRouter:
    global _router
    if _router is None:
        _router = QueryRouter()
    return _router


def _get_executor() -> AgentExecutor:
    global _executor
    if _executor is None:
        _executor = AgentExecutor()
    return _executor


def _get_chat_agent() -> ChatAgent:
    global _chat_agent
    if _chat_agent is None:
        _chat_agent = ChatAgent()
    return _chat_agent


def _get_diagnosis_agent() -> DiagnosisRouteAgent:
    global _diagnosis_agent
    if _diagnosis_agent is None:
        _diagnosis_agent = DiagnosisRouteAgent()
    return _diagnosis_agent


def _acquire_lock(conversation_id: str) -> asyncio.Lock:
    """获取或创建会话级别的异步锁，防止同一会话并发消息乱序。"""
    if conversation_id not in _conversation_locks:
        _conversation_locks[conversation_id] = asyncio.Lock()
    return _conversation_locks[conversation_id]


# ── 常量 ──────────────────────────────────────────────────────
MAX_HISTORY_MESSAGES = 20
RAW_WINDOW = 10
SAFETY_RESPONSE = "抱歉，您的消息包含不安全内容，无法处理。如有需要，请联系人工客服。"
AGENT_USER_ID = "00000000-0000-0000-0000-000000000002"


# ── SSE 序列化 ──────────────────────────────────────────────────


async def _to_sse(events: AsyncIterator) -> AsyncIterator[str]:
    """将 Agent 事件流转为 SSE 格式字符串流。"""
    async for event in events:
        if isinstance(event, StreamToken):
            payload = json.dumps(
                {"type": "token", "content": event.content, "message_id": event.message_id},
                ensure_ascii=False,
            )
        elif isinstance(event, StreamDone):
            payload = json.dumps(
                {
                    "type": "done",
                    "message_id": event.message_id,
                    "usage": event.usage,
                    "suggestions": event.suggestions,
                    "validated": event.validated,
                    "fallback_used": event.fallback_used,
                    "route": event.route,
                },
                ensure_ascii=False,
            )
        elif isinstance(event, StreamError):
            payload = json.dumps(
                {"type": "error", "content": event.content},
                ensure_ascii=False,
            )
        elif isinstance(event, StreamMeta):
            payload = json.dumps(
                {
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
                },
                ensure_ascii=False,
            )
        elif isinstance(event, DiagnosisStarted):
            payload = json.dumps(
                {"type": "diagnosis_started", "message_id": event.message_id, "agents": event.agents},
                ensure_ascii=False,
            )
        elif isinstance(event, DiagnosisPhase):
            payload = json.dumps(
                {"type": "diagnosis_phase", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label},
                ensure_ascii=False,
            )
        elif isinstance(event, DiagnosisPhaseDone):
            payload = json.dumps(
                {"type": "diagnosis_phase_done", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label, "summary": event.summary},
                ensure_ascii=False,
            )
        elif isinstance(event, DiagnosisCompleted):
            payload = json.dumps(
                {"type": "diagnosis_completed", "message_id": event.message_id, "output": event.output},
                ensure_ascii=False,
            )
        elif isinstance(event, ClarificationNeeded):
            payload = json.dumps(
                {"type": "clarification_needed", "message_id": event.message_id, "intent": event.intent, "missing_fields": event.missing_fields, "prompt_message": event.prompt_message, "hints": event.hints},
                ensure_ascii=False,
            )
        elif isinstance(event, DiagnosisWaitingInput):
            # Phase 3b HITL：诊断在阶段边界暂停，等待用户补充信息。
            payload = json.dumps(
                {"type": "diagnosis_waiting_input", "message_id": event.message_id, "message": event.message, "missing_fields": event.missing_fields},
                ensure_ascii=False,
            )
        else:
            payload = json.dumps(
                {"type": getattr(event, "type", "unknown"), "message_id": getattr(event, "message_id", "")},
                ensure_ascii=False,
            )
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


async def _get_or_create_conversation(
    db: AsyncSession, user_id: str, conversation_id: str | None
) -> Conversation:
    """获取或创建会话。

    - 有 conversation_id → 查找已有会话，验证 ownership
    - 无 → 新建会话
    """
    if conversation_id:
        result = await db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.type == "agent_chat",
            )
        )
        conv = result.scalar_one_or_none()
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


async def _load_history(
    db: AsyncSession, conversation_id: str, limit: int = MAX_HISTORY_MESSAGES
) -> list[dict]:
    """加载会话最近 N 条历史消息（用于 Agent 上下文注入）。"""
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    rows = result.scalars().all()
    # 反序恢复时间顺序
    rows = list(reversed(rows))
    return [
        {"role": m.role, "content": m.content}
        for m in rows
    ]


# ═══════════════════════════════════════════════════════════
# 核心聊天处理
# ═══════════════════════════════════════════════════════════


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
            # ── 2. ContextBuilder 组装上下文（含摘要 + Token Budget）──
            builder = ContextBuilder(db)
            ctx_result = await builder.build(actual_conv_id, message)

            # ── 3. 保存用户消息 ──
            user_msg = Message(
                id=str(uuid.uuid4()),
                conversation_id=actual_conv_id,
                role="user",
                type="text",
                content=message,
                model=resolved["model_id"],
            )
            db.add(user_msg)
            await db.commit()

            # ── 更新会话 updated_at ──
            conv.updated_at = datetime.now(timezone.utc)
            db.add(conv)
            await db.commit()

            # ── 4. 路由 + Agent 执行 ──
            router = _get_router()
            decision = router.classify(message)

            if decision.route == RouteName.SAFETY:
                events = _stream_safety(assistant_msg_id)
            elif decision.route == RouteName.HUMAN:
                events = _stream_human(assistant_msg_id)
            elif decision.route == RouteName.CHAT:
                chat_context = RouteContext(
                    conversation_id=actual_conv_id,
                    user_message=message,
                    prebuilt_messages=ctx_result.messages,
                    resolved_model=resolved["model_id"],
                    provider_name=resolved["provider_name"],
                    assistant_msg_id=assistant_msg_id,
                    intent="chat",
                )
                chat_agent = _get_chat_agent()
                events = chat_agent.execute(chat_context)
            elif decision.route == RouteName.DIAGNOSIS:
                diagnosis_ctx = RouteContext(
                    conversation_id=actual_conv_id,
                    user_message=message,
                    history=[{"role": m.__class__.__name__.replace("Message", "").lower(), "content": m.content} for m in ctx_result.messages],
                    resolved_model=resolved["model_id"],
                    provider_name=resolved["provider_name"],
                    assistant_msg_id=assistant_msg_id,
                    intent="diagnosis",
                )
                agent = _get_diagnosis_agent()
                events = agent.execute(diagnosis_ctx, tool_registry)
            else:
                context = RouteContext(
                    conversation_id=actual_conv_id,
                    user_message=message,
                    prebuilt_messages=ctx_result.messages,
                    resolved_model=resolved["model_id"],
                    provider_name=resolved["provider_name"],
                    assistant_msg_id=assistant_msg_id,
                    intent=decision.route.value,
                )
                executor = _get_executor()
                events = executor.execute(context)

            # ── 5. Langfuse Trace + 流式输出 ──
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

            # ── 6. 保存助手消息 ──
            final_answer = "".join(streamed_answer)
            if final_answer:
                assistant_msg = Message(
                    id=assistant_msg_id,
                    conversation_id=actual_conv_id,
                    role="assistant",
                    type="text",
                    content=final_answer,
                    model=resolved["model_id"],
                )
                db.add(assistant_msg)
                await db.commit()

            # ── 7. 异步压缩检查（非阻塞，失败不影响主流程）──
            try:
                asyncio.create_task(_maybe_compress(db, actual_conv_id))
            except Exception:
                pass  # 压缩是非关键路径

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

COMPRESSION_THRESHOLD = 20


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
        pass  # 压缩失败不影响主流程


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
    result = await db.execute(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.type == "agent_chat",
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        return {"conversation_id": conversation_id, "messages": [], "has_more": False}
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权访问此会话")

    # 构建查询
    conditions = [Message.conversation_id == conversation_id]

    if before_time and before_id:
        # 复合游标：(created_at, id) < (cursor_time, cursor_id)
        cursor_time = datetime.fromisoformat(before_time.replace("Z", "+00:00"))
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

    messages = [
        {
            "id": m.id,
            "role": m.role,
            "type": m.type,
            "content": m.content,
            "timestamp": m.created_at.isoformat(),
        }
        for m in rows
    ]

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
    result = await db.execute(
        select(Conversation).where(Conversation.id == conv_id)
    )
    conv = result.scalar_one_or_none()
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
    result = await db.execute(
        select(Conversation).where(Conversation.id == conv_id)
    )
    conv = result.scalar_one_or_none()
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
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "type": m.type,
                "content": m.content,
                "timestamp": m.created_at.isoformat(),
            }
            for m in messages
        ],
    }


@conversations_router.delete("/conversations/{conv_id}")
async def delete_conversation_alias(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除会话 —— DELETE /api/conversations/:id（向后兼容）。"""
    result = await db.execute(
        select(Conversation).where(Conversation.id == conv_id)
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除此会话")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}
