"""Adapt the persisted task runtime to the public chat event contract."""

import copy
import uuid
from contextlib import aclosing
from datetime import UTC, datetime

from langchain_core.messages import HumanMessage, SystemMessage, messages_to_dict
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.types import (
    RouteContext,
    StreamCitations,
    StreamDone,
    StreamError,
    StreamToken,
    StreamTraceStep,
)
from src.models.agent_session import AgentApproval, AgentSession
from src.services.agent_tasks import TASK_PROMPT, claim_resume, stream_task
from src.services.citations import citation_cards, source_context
from src.services.execution_policy import build_execution_policy
from src.services.knowledge_retrieval import result_dto, retrieval_service
from src.services.usage import task_usage_summary


async def paused_chat_task(db: AsyncSession, conversation_id: str) -> AgentSession | None:
    sessions = await db.scalars(select(AgentSession).where(
        AgentSession.conversation_id == conversation_id, AgentSession.status == "paused",
    ).order_by(AgentSession.started_at.desc(), AgentSession.id.desc()))
    return next((session for session in sessions if (session.runtime_state or {}).get("chat")), None)


async def cancel_chat_task(db: AsyncSession, conversation_id: str) -> bool:
    session = await paused_chat_task(db, conversation_id)
    if session is None:
        return False
    changed = await db.execute(update(AgentSession).where(
        AgentSession.id == session.id, AgentSession.status == "paused",
    ).values(status="failed", final_summary="Cancelled by user", completed_at=datetime.now(UTC)))
    if changed.rowcount != 1:
        await db.rollback()
        return False
    await db.execute(update(AgentApproval).where(
        AgentApproval.session_id == session.id, AgentApproval.status == "pending",
    ).values(status="rejected", rejection_reason="Cancelled by user", decided_at=datetime.now(UTC)))
    await db.commit()
    return True


async def stream_chat_task(db: AsyncSession, context: RouteContext):
    initial_sources = []
    session = await paused_chat_task(db, context.conversation_id)
    if session is not None:
        if (session.runtime_state or {}).get("pause_kind") == "approval":
            yield StreamToken(content="当前任务正在等待工具审批，请先完成审批。", message_id=context.assistant_msg_id)
            yield StreamDone(
                message_id=context.assistant_msg_id, route="TASK",
                agent_session_id=session.id, task_status="paused",
            )
            return
        state = await claim_resume(db, session, context.user_message, persist_user=False)
        initial_sources = (session.runtime_state or {}).get("knowledge_results", [])
    else:
        messages = list(context.prebuilt_messages) or [HumanMessage(content=context.user_message)]
        if messages and isinstance(messages[0], SystemMessage):
            # ContextBuilder already received the task prompt; keep its history summary.
            if not str(messages[0].content).startswith(TASK_PROMPT):
                messages.insert(0, SystemMessage(content=TASK_PROMPT))
        else:
            messages.insert(0, SystemMessage(content=TASK_PROMPT))
        policy = build_execution_policy()
        runtime = {
            "version": 1, "messages": messages_to_dict(messages), "iteration_count": 0,
            "max_iterations": policy.max_iterations, "model": context.resolved_model, "provider": context.provider_name,
            "tools": list(policy.tools), "guard": policy.guard_config().model_dump(),
            "execution_policy": policy.model_dump(),
            "tokens_used": 0, "cost_cents_used": 0, "pause_kind": None, "chat": True,
            "verify_citations": context.intent == "consultation",
        }
        session = AgentSession(
            id=str(uuid.uuid4()), conversation_id=context.conversation_id, task=context.user_message,
            status="running", scratchpad=[], runtime_state=runtime,
        )
        if context.intent == "consultation":
            step = {"seq": 1, "kind": "retrieval", "label": "检索知识库", "status": "running"}
            yield StreamTraceStep(step=step)
            results = await retrieval_service(db).retrieve(context.user_message, None, 5)
            sources = [result_dto(item) for item in results if item.content]
            messages.insert(1, SystemMessage(content=source_context(sources)))
            runtime.update(knowledge_results=sources, messages=messages_to_dict(messages))
            session.runtime_state = copy.deepcopy(runtime)
            yield StreamTraceStep(step={**step, "status": "done", "hitCount": len(sources)})
            yield StreamCitations(items=citation_cards(sources))
        db.add(session)
        await db.commit()
        state = {"messages": messages, "iteration_count": 0}
    seq = 1 if context.intent == "consultation" else 0
    paused = False
    failed = False
    try:
        if initial_sources:
            yield StreamCitations(items=citation_cards(initial_sources))
        async with aclosing(stream_task(
            db, session, state, persist_assistant=False, message_id=context.assistant_msg_id,
        )) as events:
            async for event in events:
                kind = event["type"]
                if kind == "agent_token":
                    yield StreamToken(content=event["content"], message_id=context.assistant_msg_id)
                elif kind == "agent_citations":
                    yield StreamCitations(items=event["items"])
                elif kind == "agent_observe":
                    seq += 1
                    retrieval = event.get("tool") == "search_knowledge_base"
                    yield StreamTraceStep(step={
                        "seq": seq, "kind": "retrieval" if retrieval else "tool",
                        "label": "检索知识库" if retrieval else event.get("tool", "调用工具"),
                        "status": "done",
                    })
                elif kind == "agent_ask_user":
                    paused = True
                    yield StreamToken(content=event["question"], message_id=context.assistant_msg_id)
                elif kind == "agent_approval_required":
                    paused = True
                    seq += 1
                    yield StreamTraceStep(step={
                        "seq": seq, "kind": "tool", "label": event["tool_name"], "status": "running",
                        "detail": "等待工具审批", "approvalId": event["approval_id"], "sessionId": session.id,
                    })
                    yield StreamToken(content="此操作需要审批，任务已暂停等待确认。", message_id=context.assistant_msg_id)
                elif kind == "agent_error":
                    failed = True
                    yield StreamError(content="任务执行失败，请稍后重试。")
                    yield StreamToken(content="任务执行失败，请稍后重试。", message_id=context.assistant_msg_id)
        yield StreamDone(
            message_id=context.assistant_msg_id, route="TASK", validated=not failed,
            usage=task_usage_summary(session.runtime_state or {}),
            agent_session_id=session.id, task_status="paused" if paused else "failed" if failed else "completed",
            citation=(session.runtime_state or {}).get("citation_report"),
        )
    finally:
        # Covers disconnects before the graph starts (for example during retrieval).
        if session.status == "running":
            from anyio import CancelScope

            with CancelScope(shield=True):
                await db.rollback()
                await db.refresh(session)
                if session.status == "running":
                    session.status = "failed"
                    session.final_summary = "Interrupted by user"
                    session.completed_at = datetime.now(UTC)
                    await db.commit()
