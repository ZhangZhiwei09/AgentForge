"""Chat API —— POST /api/agent/chat 流式聊天端点。

流程:
    用户消息 → get_or_create_conversation → 保存用户消息
    → 企业入口决策 → 现有 AgentExecutor / 配置诊断 → SSE Stream
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
from contextlib import aclosing, asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, cast

from anyio import CancelScope
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from pydantic import Field as PydField
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.chat_agent import ChatAgent
from src.agent.context_builder import ContextBuilder
from src.agent.diagnosis.route_agent import DiagnosisRouteAgent, _check_info_sufficiency
from src.agent.executor import AgentExecutor
from src.agent.flows.diagnosis import diagnosis_events
from src.agent.flows.service import claim_diagnosis
from src.agent.redis_memory import mirror_message
from src.agent.router.entry_decision import (
    EntryDecision,
    conversational_reply,
    decide_entry,
    explicit_entry_control,
    safety_route_scan,
)
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
    StreamCitations,
    StreamClear,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
    StreamTraceStep,
)
from src.api.deps import get_chat_user, get_current_user, get_db
from src.api.v1.conversations import _find_conversation
from src.api.v1.sse import _to_sse
from src.config import settings
from src.models.agent_flow import AgentFlowRun
from src.models.chat import Conversation, Message
from src.models.entry_flow import EntryRouteFlowRun
from src.models.user import User
from src.providers.registry import resolve_model
from src.schemas.chat import ChatMessage, ChatRequest
from src.services.chat_tasks import cancel_chat_task, paused_chat_task, stream_chat_task
from src.services.entry_flows import EntryRouteFlowService, RunExecution

router = APIRouter(prefix="/api/v1", tags=["chat"])

logger = logging.getLogger(__name__)

# ── 模块级单例 ──
_singletons: dict[type, object] = {}


def _get_singleton[T](cls: type[T]) -> T:
    """惰性初始化并复用进程内单例。"""
    instance = _singletons.get(cls)
    if instance is None:
        instance = _singletons[cls] = cls()
    return cast(T, instance)


# ── 会话级并发控制 ──
_conversation_locks: dict[str, tuple[asyncio.Lock, int]] = {}


def _get_executor() -> AgentExecutor:
    return _get_singleton(AgentExecutor)


def _get_chat_agent() -> ChatAgent:
    return _get_singleton(ChatAgent)


def _get_diagnosis_agent() -> DiagnosisRouteAgent:
    return _get_singleton(DiagnosisRouteAgent)


@asynccontextmanager
async def _acquire_lock(conversation_id: str):
    """Keep a lock until its holder and all queued requests have released it."""
    lock, users = _conversation_locks.get(conversation_id, (asyncio.Lock(), 0))
    _conversation_locks[conversation_id] = (lock, users + 1)
    try:
        async with lock:
            yield
    finally:
        _, users = _conversation_locks[conversation_id]
        if users == 1:
            del _conversation_locks[conversation_id]
        else:
            _conversation_locks[conversation_id] = (lock, users - 1)


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
        conv = await _find_conversation(
            db, conversation_id, conv_type="agent_chat", user_id=user_id,
        )
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
        session_id=conversation_id,
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
    session_id: str | None = None,
    prebuilt_messages: list | None = None,
) -> RouteContext:
    """构造 Agent 执行上下文（各路由共享的公共字段）。"""
    return RouteContext(
        conversation_id=conversation_id,
        session_id=session_id,
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
    intent: str | None = None,
    session_id: str | None = None,
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
            session_id=session_id,
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
            session_id=session_id,
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
        session_id=session_id,
        user_message=user_message,
        prebuilt_messages=prebuilt_messages,
        resolved_model=resolved_model,
        provider_name=provider_name,
        assistant_msg_id=assistant_msg_id,
        intent=intent or route.value,
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
    metadata: dict | None = None,
    entry_run_id: str | None = None,
    message_type: str = "text",
) -> None:
    """保存助手回复并镜像到 Redis；无输出时跳过。"""
    final_answer = "".join(streamed_answer)
    if not final_answer and not metadata:
        return

    assistant_msg = Message(
        id=assistant_msg_id,
        conversation_id=conversation_id,
        role="assistant",
        type=message_type,
        content=final_answer,
        model=model_id,
        msg_metadata=metadata,
    )
    db.add(assistant_msg)
    if entry_run_id is not None:
        await db.execute(update(EntryRouteFlowRun).where(
            EntryRouteFlowRun.id == entry_run_id,
        ).values(assistant_message_id=assistant_msg_id))
    await db.commit()

    # 镜像到 Redis 短期记忆窗口（尽力而为，失败零影响）
    await mirror_message(db, conversation_id, assistant_msg)


async def _waiting_diagnosis(db: AsyncSession, conversation_id: str, actor_id: str) -> bool:
    return await db.scalar(select(AgentFlowRun.id).where(
        AgentFlowRun.conversation_id == conversation_id, AgentFlowRun.actor_id == actor_id,
        AgentFlowRun.test.is_(False), AgentFlowRun.status == "waiting_input",
    ).limit(1)) is not None


async def _cancel_waiting_diagnosis(db: AsyncSession, conversation_id: str, actor_id: str) -> bool:
    ids = list(await db.scalars(update(AgentFlowRun).where(
        AgentFlowRun.conversation_id == conversation_id, AgentFlowRun.actor_id == actor_id,
        AgentFlowRun.test.is_(False), AgentFlowRun.status == "waiting_input",
    ).values(status="cancelled", cancel_requested=True).returning(AgentFlowRun.id)))
    await db.commit()
    return bool(ids)


async def _stream_entry_response(decision: EntryDecision, assistant_msg_id: str) -> AsyncIterator:
    if decision.action == "clarify":
        yield ClarificationNeeded(
            message_id=assistant_msg_id, intent="unclear", missing_fields=["business_intent"],
            prompt_message=decision.answer,
        )
    elif decision.action == "unavailable":
        yield StreamError(content=decision.answer)
    yield StreamToken(content=decision.answer, message_id=assistant_msg_id)
    yield StreamDone(
        message_id=assistant_msg_id, route="CHAT", usage={}, suggestions=decision.suggestions,
        validated=decision.action != "unavailable", conversational=decision.action == "reply",
    )


async def _stream_diagnosis(context: RouteContext, actor_id: str, *, waiting: bool, cancel: asyncio.Event) -> AsyncIterator:
    if not waiting:
        info = _check_info_sufficiency(context.user_message)
        if not info["sufficient"]:
            yield ClarificationNeeded(
                message_id=context.assistant_msg_id, intent=info["intent"],
                missing_fields=info["missing_fields"], prompt_message=info["prompt_message"],
                hints=info["hints"],
            )
            yield StreamToken(message_id=context.assistant_msg_id, content=info["prompt_message"])
            yield StreamDone(message_id=context.assistant_msg_id, route="DIAGNOSIS", usage={})
            return
    run, resume = await claim_diagnosis(context, actor_id, require_waiting=waiting)
    if waiting and (run is None or not resume):
        # Do not start a different run if a waiting run was cancelled concurrently.
        raise HTTPException(409, "等待排查状态已变化，请重新发送")
    if run is not None:
        async with aclosing(diagnosis_events(run, context, tool_registry, cancel, resume=resume)) as events:
            async for event in events:
                yield event
    else:
        async with aclosing(_get_diagnosis_agent().execute(context, tool_registry)) as events:
            async for event in events:
                yield event


def _collect_diagnosis(metadata: dict, event: object) -> None:
    """Persist the same progress DTO the frontend builds from live events."""
    if isinstance(event, DiagnosisStarted):
        metadata["diagnosis"] = {
            "status": "running",
            "phases": [{
                "phase": agent.get("phase", index + 1),
                "label": agent.get("role", ""), "agent": agent.get("name", ""),
                "status": "pending",
            } for index, agent in enumerate(event.agents)],
        }
    elif isinstance(event, (DiagnosisPhase, DiagnosisPhaseDone)):
        for phase in metadata.get("diagnosis", {}).get("phases", []):
            if phase["phase"] == event.phase:
                phase["status"] = "done" if isinstance(event, DiagnosisPhaseDone) else "running"
                if isinstance(event, DiagnosisPhaseDone):
                    phase["summary"] = event.summary
    elif isinstance(event, DiagnosisCompleted):
        from src.agent.diagnosis.route_agent import _extract_conclusion_text

        progress = metadata.setdefault("diagnosis", {"phases": []})
        progress.update({
            "status": "done", "resolution": event.output.get("resolution", ""),
            "finalConclusion": _extract_conclusion_text(event.output),
        })
        for phase in progress["phases"]:
            if phase["status"] == "pending" or phase["agent"] in event.output.get("skipped_nodes", []):
                phase["status"] = "skipped"
        metadata["diagnosisOutput"] = event.output
        metadata.pop("waitingInput", None)
        metadata.pop("diagnosisWaitingInput", None)


async def _handle_chat(
    message: str,
    model: str | None,
    db: AsyncSession,
    user: User,
    conversation_id: str | None = None,
) -> StreamingResponse:
    """共享聊天处理：持久化 → Router → AgentExecutor → SSE → 保存回复。"""
    from src.observability import get_observability

    assistant_msg_id = str(uuid.uuid4())

    # ── 1. 会话管理 ──
    if conversation_id:
        async with _acquire_lock(f"lookup:{user.id}:{conversation_id}"):
            conv = await _get_or_create_conversation(db, user.id, conversation_id)
    else:
        conv = await _get_or_create_conversation(db, user.id, None)
    actual_conv_id = conv.id
    actual_session_id = conv.session_id

    # ── 并发控制 ──
    lock = _acquire_lock(actual_conv_id)

    async def _persisted_events():
        async with lock:
            history_rows = list(await db.scalars(select(Message).where(
                Message.conversation_id == actual_conv_id,
                Message.role.in_(["user", "assistant"]), Message.type.in_(["text", "diagnosis"]),
            ).order_by(Message.created_at.desc(), Message.id.desc()).limit(4)))
            history = [ChatMessage(role=row.role, content=row.content) for row in reversed(history_rows)]
            model_id = model or settings.default_model
            user_message = await _save_user_message(db, conv, message, model_id)
            service = EntryRouteFlowService(db)
            entry_execution: RunExecution | None = None
            cancel = asyncio.Event()
            streamed_answer: list[str] = []
            metadata: dict = {}
            saved = False
            delivered = False

            async def load_entry_result():
                nonlocal entry_execution
                snapshot = await service.active_snapshot()
                if snapshot is None:
                    return None
                entry_execution = await service.execute(
                    snapshot, message, user.id, conversation_id=actual_conv_id, cancel=cancel,
                )
                return entry_execution.execution.result

            async def persist():
                nonlocal saved
                if saved or not delivered:
                    return
                if entry_execution is not None:
                    metadata["entryRoute"] = {
                        "flowId": entry_execution.flow_id, "runId": entry_execution.run_id,
                        "version": entry_execution.version,
                    }
                await _save_assistant_message(
                    db, actual_conv_id, assistant_msg_id, model_id, streamed_answer, metadata,
                    entry_execution.run_id if entry_execution is not None else None,
                    message_type="diagnosis" if route == RouteName.DIAGNOSIS else "text",
                )
                saved = True

            obs = get_observability()
            async with obs.create_trace(
                "chat-request", input=message, metadata={"conversation_id": actual_conv_id},
            ):
                try:
                    safety = safety_route_scan(message)
                    waiting = False if safety or explicit_entry_control(message) == "human" else await _waiting_diagnosis(db, actual_conv_id, user.id)
                    task = None if safety or explicit_entry_control(message) == "human" else await paused_chat_task(db, actual_conv_id)
                    decision = await decide_entry(
                        message, history, model, safety_decision=safety,
                        waiting_diagnosis=waiting, load_entry_result=load_entry_result,
                        cancel_waiting_diagnosis=lambda: _cancel_waiting_diagnosis(db, actual_conv_id, user.id),
                        conversational=conversational_reply(message), cancel=cancel,
                        waiting_task=task is not None,
                        cancel_waiting_task=lambda: cancel_chat_task(db, actual_conv_id),
                    )
                except Exception as exc:  # noqa: BLE001 - Configuration/state failures must stop dispatch.
                    await db.rollback()
                    logger.warning("Entry decision unavailable conversation_id=%s error_type=%s", actual_conv_id, type(exc).__name__)
                    decision = EntryDecision(
                        "unavailable", "entry_flow", "配置加载或记录保存失败",
                        answer="入口配置或运行记录暂不可用，请联系管理员检查配置。",
                    )
                route = decision.route
                intent = decision.business_intent or ("unclear" if decision.action == "clarify" else route.value.lower())
                metadata["entryDecision"] = {
                    "action": decision.action, "source": decision.source, "reasoning": decision.reasoning,
                }
                events = None
                provider_name = ""
                try:
                    if decision.action != "dispatch":
                        events = _stream_entry_response(decision, assistant_msg_id)
                    elif route in (RouteName.SAFETY, RouteName.HUMAN):
                        events = _stream_safety(assistant_msg_id) if route == RouteName.SAFETY else _stream_human(assistant_msg_id)
                    else:
                        query = decision.resolved_query or message
                        # Insufficient diagnoses can ask for information without a provider.
                        needs_model = route != RouteName.DIAGNOSIS or waiting or _check_info_sufficiency(query)["sufficient"]
                        if needs_model:
                            task_model = (task.runtime_state or {}).get("model") if task is not None and route == RouteName.TASK else None
                            resolved = resolve_model(task_model or model)
                            model_id, provider_name = resolved["model_id"], resolved["provider_name"]
                        prebuilt = []
                        if route in (RouteName.TASK, RouteName.CHAT):
                            built = await ContextBuilder(db).build(actual_conv_id, query, exclude_message_id=user_message.id)
                            prebuilt = built.messages
                        if decision.business_intent:
                            conv.intent = decision.business_intent
                            await db.commit()
                        context = _build_route_context(
                            conversation_id=actual_conv_id, user_message=query,
                            session_id=actual_session_id,
                            resolved_model=model_id, provider_name=provider_name,
                            assistant_msg_id=assistant_msg_id, intent=intent, prebuilt_messages=prebuilt,
                        )
                        if route == RouteName.DIAGNOSIS:
                            events = _stream_diagnosis(context, user.id, waiting=waiting, cancel=cancel)
                        elif route == RouteName.TASK:
                            events = stream_chat_task(db, context)
                        else:
                            events = _select_events(
                                RouterDecision(route, 1, decision.reasoning),
                                conversation_id=actual_conv_id, user_message=query, prebuilt_messages=prebuilt,
                                session_id=actual_session_id,
                                resolved_model=model_id, provider_name=provider_name, assistant_msg_id=assistant_msg_id,
                                intent=intent,
                            )
                    yield StreamMeta(
                        message_id=assistant_msg_id, conversation_id=actual_conv_id,
                        session_id=actual_session_id,
                        model=model_id if provider_name else "", provider=provider_name,
                        route=route.value, intent=intent, source=decision.source,
                        conversational=decision.action == "reply",
                    )
                    async with aclosing(events):
                        async for event in events:
                            if isinstance(event, StreamMeta):
                                continue
                            if isinstance(event, StreamToken):
                                streamed_answer.append(event.content)
                                delivered = True
                            elif isinstance(event, StreamClear):
                                streamed_answer.clear()
                            elif isinstance(event, StreamCitations):
                                metadata["citations"] = event.items
                                delivered = True
                            elif isinstance(event, StreamTraceStep):
                                traces = {step["seq"]: step for step in metadata.get("traces", [])}
                                traces[event.step["seq"]] = event.step
                                metadata["traces"] = [traces[key] for key in sorted(traces)]
                                delivered = True
                            elif isinstance(event, ClarificationNeeded):
                                delivered = True
                                metadata["clarification"] = {
                                    "intent": event.intent, "missingFields": event.missing_fields,
                                    "promptMessage": event.prompt_message, "hints": event.hints,
                                }
                            elif isinstance(event, (DiagnosisStarted, DiagnosisPhase, DiagnosisPhaseDone, DiagnosisCompleted)):
                                _collect_diagnosis(metadata, event)
                                delivered = True
                            elif isinstance(event, DiagnosisWaitingInput):
                                delivered = True
                                metadata["diagnosisWaitingInput"] = {
                                    "message": event.message, "missing_fields": event.missing_fields,
                                }
                                metadata["waitingInput"] = {
                                    "message": event.message, "missingFields": event.missing_fields,
                                }
                                if "diagnosis" in metadata:
                                    metadata["diagnosis"]["status"] = "waiting_input"
                            elif isinstance(event, StreamError):
                                if "diagnosis" in metadata:
                                    metadata["diagnosis"]["status"] = "error"
                            elif isinstance(event, StreamDone):
                                metadata["suggestions"] = event.suggestions or []
                                if event.citation is not None:
                                    metadata["citation"] = event.citation
                                if event.agent_session_id is not None:
                                    metadata["agentSession"] = {
                                        "id": event.agent_session_id, "status": event.task_status,
                                    }
                                event.source = decision.source
                                await persist()
                            yield event
                except asyncio.CancelledError:
                    cancel.set()
                    raise
                except Exception as exc:  # noqa: BLE001 - Convert execution failures to the public SSE contract.
                    await db.rollback()
                    logger.warning("Chat execution failed conversation_id=%s error_type=%s", actual_conv_id, type(exc).__name__)
                    failure = "处理请求失败，请稍后重试。"
                    metadata["executionError"] = True
                    yield StreamError(content=failure)
                    if not streamed_answer:
                        streamed_answer.append(failure)
                        delivered = True
                        yield StreamToken(content=failure, message_id=assistant_msg_id)
                    await persist()
                    yield StreamDone(message_id=assistant_msg_id, route=route.value, source=decision.source, validated=False)
                finally:
                    cancel.set()
                    # Starlette disconnect cancellation must not cancel the final SQL write.
                    with CancelScope(shield=True):
                        await persist()
            _spawn_compression(db, actual_conv_id)

    return StreamingResponse(
        _to_sse(_persisted_events(), terminal_marker=True),
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
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """流式聊天端点 —— POST /api/v1/chat。"""
    return await _handle_chat(body.message, body.model, db, user)


# ═══════════════════════════════════════════════════════════
# POST /api/agent/chat —— 智能客服前端端点
# ═══════════════════════════════════════════════════════════


class AgentChatRequest(BaseModel):
    message: str = PydField(min_length=1, max_length=16000)
    conversation_id: str | None = PydField(default=None, max_length=64)
    session_id: str | None = PydField(default=None, max_length=64)

    @field_validator("message")
    @classmethod
    def nonblank_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("消息不能为空")
        return value


agent_router = APIRouter(prefix="/api/agent", tags=["agent-chat"])


@agent_router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: Annotated[User, Depends(get_chat_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Agent 聊天端点，兼容匿名身份与旧 session_id。"""
    return await _handle_chat(body.message, None, db, user, body.conversation_id or body.session_id)




