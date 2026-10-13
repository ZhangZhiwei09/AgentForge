"""Persisted task policy on the shared LangGraph ReAct runtime."""

import asyncio
import copy
import json
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import anyio
from fastapi import HTTPException
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    messages_from_dict,
    messages_to_dict,
)
from langgraph.config import get_stream_writer
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.executor import REACT_SYSTEM_PROMPT, AgentExecutor
from src.agent.langchain_adapter import ProviderChatModel
from src.agent.react_graph import build_react_graph
from src.agent.state import AgentState
from src.agent.task_guard import (
    TaskGuardConfig,
    count_tokens,
    model_rates,
    sanitize_response,
)
from src.agent.tools.registry import ToolRegistry, tool_registry
from src.models.agent_session import AgentApproval, AgentSession
from src.models.chat import Conversation, Message
from src.providers.registry import get_provider, resolve_model

logger = logging.getLogger(__name__)

TASK_PROMPT = REACT_SYSTEM_PROMPT + """

执行任务时可以直接调用提供的工具。需要追问用户时调用 agent_decide，
action=ask_user，提供 question 和 clarify_context；完成后直接给出最终回答，
或调用 agent_decide，action=respond，提供 content 和 summary。
也可以用 action=tool_call，提供 tool、args_json 和 reason 报告下一步工具调用。
不得把内部决策 JSON 作为用户回复，不得调用未提供的工具。"""

DECISION_TOOL = {
    "type": "function",
    "function": {
        "name": "agent_decide",
        "description": "报告当前观察、分析、计划，以及执行工具、追问用户或最终回复的决策。",
        "parameters": {
            "type": "object",
            "properties": {
                **{key: {"type": "string"} for key in (
                    "observation", "analysis", "plan", "tool", "args_json", "reason",
                    "content", "summary", "question", "clarify_context",
                )},
                "action": {"type": "string", "enum": ["tool_call", "ask_user", "respond"]},
            },
            "required": ["observation", "analysis", "plan", "action"],
        },
    },
}


def session_dto(session: AgentSession) -> dict:
    return {
        "id": session.id, "conversationId": session.conversation_id,
        "task": session.task, "status": session.status, "scratchpad": session.scratchpad,
        "finalSummary": session.final_summary, "compressedSummary": session.compressed_summary,
        "runtimeState": session.runtime_state, "startedAt": session.started_at,
        "completedAt": session.completed_at,
    }


def approval_dto(approval: AgentApproval) -> dict:
    return {
        "id": approval.id, "sessionId": approval.session_id,
        "conversationId": approval.conversation_id, "stepNumber": approval.step_number,
        "toolName": approval.tool_name, "toolArgs": approval.tool_args,
        "riskLevel": approval.risk_level, "reason": approval.reason, "status": approval.status,
        "approvedBy": approval.approved_by, "modifiedArgs": approval.modified_args,
        "rejectionReason": approval.rejection_reason, "timeoutMs": approval.timeout_ms,
        "requestedAt": approval.requested_at, "decidedAt": approval.decided_at,
    }


async def owned_conversation(db: AsyncSession, conversation_id: str, actor_id: str) -> Conversation:
    conversation = await db.scalar(select(Conversation).where(
        Conversation.id == conversation_id, Conversation.user_id == actor_id,
    ))
    if conversation is None:
        raise HTTPException(404, "Conversation not found or access denied")
    return conversation


async def owned_session(
    db: AsyncSession, session_id: str, actor_id: str, *, detail: bool = False,
) -> AgentSession:
    session = await db.get(AgentSession, session_id)
    if session is None:
        raise HTTPException(404, "Agent session not found")
    try:
        await owned_conversation(db, session.conversation_id, actor_id)
    except HTTPException:
        raise HTTPException(403 if detail else 404, "Access denied") from None
    return session


def restore_state(session: AgentSession) -> tuple[dict, AgentState]:
    runtime = copy.deepcopy(session.runtime_state or {})
    if runtime.get("version") == 1:
        return runtime, {
            "messages": messages_from_dict(runtime["messages"]),
            "iteration_count": runtime["iteration_count"],
            "resume_tools": runtime.get("pause_kind") == "approval",
            "paused": False,
        }
    # A paused session created by the TS backend has only its scratchpad.
    messages = [SystemMessage(content=TASK_PROMPT), HumanMessage(content=session.task)]
    for index, step in enumerate(session.scratchpad):
        decision = step.get("decision", {})
        action = decision.get("action")
        if action == "tool_call":
            call_id = f"legacy-{index}"
            messages.append(AIMessage(content="", tool_calls=[{
                "id": call_id, "name": decision["tool"], "args": decision.get("args", {}),
            }]))
            if step.get("result") is not None:
                messages.append(ToolMessage(content=str(step["result"]), tool_call_id=call_id))
        elif action == "ask_user":
            messages.append(AIMessage(content=decision.get("question", "")))
    pending = bool(messages and isinstance(messages[-1], AIMessage) and messages[-1].tool_calls)
    runtime = {
        "version": 1, "max_iterations": 10, "tools": None, "guard": {},
        "pause_kind": "approval" if pending else "user", "model": None,
        "tokens_used": 0, "cost_cents_used": 0,
    }
    return runtime, {
        "messages": messages, "iteration_count": max((step["step"] for step in session.scratchpad), default=0),
        "resume_tools": pending, "paused": False,
    }


async def claim_resume(db: AsyncSession, session: AgentSession, response: str) -> AgentState:
    runtime, state = restore_state(session)
    if session.status != "paused":
        raise HTTPException(400, f"Agent session is {session.status}, not paused")
    pending = await db.scalar(select(AgentApproval.id).where(
        AgentApproval.session_id == session.id, AgentApproval.status == "pending",
    ).limit(1))
    if pending or runtime.get("pause_kind") != "user":
        raise HTTPException(409, "Session is waiting for tool approval")
    state["messages"].append(HumanMessage(content=response))
    runtime.update(messages=messages_to_dict(state["messages"]), pause_kind=None)
    result = await db.execute(update(AgentSession).where(
        AgentSession.id == session.id, AgentSession.status == "paused",
        AgentSession.runtime_state == session.runtime_state,
    ).values(status="running", runtime_state=runtime).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "Session has already been resumed")
    db.add(Message(
        id=str(uuid.uuid4()), conversation_id=session.conversation_id, role="user", content=response,
    ))
    await db.commit()
    await db.refresh(session)
    return state


async def claim_approval(
    db: AsyncSession, session: AgentSession, approval_id: str, action: str,
    actor_id: str, modified_args: dict | None, rejection_reason: str | None,
) -> tuple[AgentState, AgentApproval]:
    approval = await db.scalar(select(AgentApproval).where(
        AgentApproval.id == approval_id, AgentApproval.session_id == session.id,
    ))
    if approval is None:
        raise HTTPException(404, "Approval not found")
    if approval.status != "pending":
        raise HTTPException(400, f"Approval is already {approval.status}")
    if session.status != "paused":
        raise HTTPException(400, f"Agent session is {session.status}, not paused")
    runtime, state = restore_state(session)
    if runtime.get("pause_kind") != "approval":
        raise HTTPException(409, "Session is not waiting for tool approval")
    if runtime.get("pending_approval_id", approval_id) != approval_id:
        raise HTTPException(409, "Approval does not match the pending tool call")
    calls = [call for message in state["messages"] if isinstance(message, AIMessage) for call in message.tool_calls]
    call_id = runtime.get("pending_call_id")
    call = next((call for call in calls if call["id"] == call_id), None)
    if call is None and not session.runtime_state:
        call = calls[-1] if calls else None
        call_id = call["id"] if call else None
    if call is None or call["name"] != approval.tool_name or call["args"] != approval.tool_args:
        raise HTTPException(409, "Approval does not match the pending tool call")
    now = datetime.now(UTC)
    requested = approval.requested_at.replace(tzinfo=UTC) if approval.requested_at.tzinfo is None else approval.requested_at
    if (now - requested).total_seconds() * 1000 > approval.timeout_ms:
        # Match approval/resume lock order: session first, then approval.
        failed = await db.execute(update(AgentSession).where(
            AgentSession.id == session.id, AgentSession.status == "paused",
            AgentSession.runtime_state == session.runtime_state,
        ).values(status="failed", final_summary="Approval request has timed out", completed_at=now))
        expired = await db.execute(update(AgentApproval).where(
            AgentApproval.id == approval_id, AgentApproval.status == "pending",
        ).values(status="timed_out", decided_at=now))
        if expired.rowcount != 1 or failed.rowcount != 1:
            await db.rollback()
            raise HTTPException(409, "Approval has already been decided")
        await db.commit()
        raise HTTPException(410, "Approval request has timed out")
    runtime.update(
        pending_call_id=call_id, active_approval_id=approval.id,
        approval_action=action, approval_args=modified_args, rejection_reason=rejection_reason,
        pause_kind=None,
    )
    state["resume_tools"] = True
    runtime["messages"] = messages_to_dict(state["messages"])
    claimed = await db.execute(update(AgentSession).where(
        AgentSession.id == session.id, AgentSession.status == "paused",
        AgentSession.runtime_state == session.runtime_state,
    ).values(status="running", runtime_state=runtime).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "Session has already been resumed")
    result = await db.execute(update(AgentApproval).where(
        AgentApproval.id == approval_id, AgentApproval.status == "pending",
    ).values(
        status="approved" if action == "approve" else "rejected", approved_by=actor_id,
        modified_args=modified_args, rejection_reason=rejection_reason, decided_at=now,
    ).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "Approval has already been decided")
    await db.commit()
    await db.refresh(session)
    await db.refresh(approval)
    return state, approval


class TaskLifecycle:
    def __init__(
        self, db: AsyncSession, session: AgentSession, registry: ToolRegistry,
        runtime: dict, model: ProviderChatModel,
    ) -> None:
        self.db = db
        self.session = session
        self.registry = registry
        self.runtime = copy.deepcopy(runtime)
        self.model = model
        self.guard = TaskGuardConfig.model_validate(runtime.get("guard", {}))
        self.paused = False
        self.summary = ""

    def emit(self, kind: str, **data) -> None:
        get_stream_writer()({"type": kind, **data})

    async def save(self, state: AgentState) -> None:
        self.runtime.update(
            messages=messages_to_dict(state["messages"]),
            iteration_count=state["iteration_count"],
        )
        self.session.runtime_state = copy.deepcopy(self.runtime)
        await self.db.commit()

    async def before_model(self, state: AgentState) -> None:
        if state["iteration_count"] >= self.runtime["max_iterations"]:
            raise RuntimeError("Agent iteration budget exhausted")
        prompt_tokens = sum(count_tokens(str(message.content)) for message in state["messages"])
        # Tool definitions and structured calls also contribute to the input budget.
        prompt_tokens += count_tokens(json.dumps(self.runtime.get("tool_defs", []), ensure_ascii=False))
        prompt_tokens += sum(
            count_tokens(json.dumps(message.tool_calls, ensure_ascii=False))
            for message in state["messages"] if isinstance(message, AIMessage) and message.tool_calls
        )
        available = self.guard.max_tokens - self.runtime.get("tokens_used", 0) - prompt_tokens
        prompt_rate, completion_rate = model_rates(self.model.model_name)
        cost_available = self.guard.max_cost_cents - self.runtime.get("cost_cents_used", 0) - prompt_tokens * prompt_rate / 1000
        available = min(available, int(cost_available * 1000 / completion_rate))
        if available <= 0:
            self.emit("agent_guard_block", step=state["iteration_count"] + 1, reason="budget", detail="任务预算已耗尽")
            raise RuntimeError("Agent token or cost budget exhausted")
        self.model.max_tokens = min(4096, available)
        self.runtime["estimated_prompt_tokens"] = prompt_tokens
        await self.save(state)

    def record(self, state: AgentState, decision: dict, details: dict | None = None) -> dict:
        details = details or {}
        step = {
            "step": state["iteration_count"], "observation": details.get("observation", ""),
            "analysis": details.get("analysis", ""), "plan": details.get("plan", ""),
            "decision": decision, "timestamp": datetime.now(UTC).isoformat(),
        }
        self.session.scratchpad = [*self.session.scratchpad, step]
        self.emit("agent_think", **{key: step[key] for key in ("step", "observation", "analysis", "plan")})
        self.emit("agent_act", step=step["step"], decision=decision)
        return step

    async def after_model(self, state: AgentState, response: AIMessage) -> AgentState:
        usage = response.usage_metadata or {}
        prompt_tokens = usage.get("input_tokens") or self.runtime["estimated_prompt_tokens"]
        output_tokens = usage.get("output_tokens") or count_tokens(str(response.content) + json.dumps(response.tool_calls))
        prompt_rate, completion_rate = model_rates(self.model.model_name)
        self.runtime["tokens_used"] = self.runtime.get("tokens_used", 0) + prompt_tokens + output_tokens
        self.runtime["cost_cents_used"] = self.runtime.get("cost_cents_used", 0) + (
            prompt_tokens * prompt_rate + output_tokens * completion_rate
        ) / 1000
        next_state = {**state, "iteration_count": state["iteration_count"] + 1}
        decisions = [call for call in response.tool_calls if call["name"] == "agent_decide"]
        details = {}
        if decisions:
            if len(response.tool_calls) != 1:
                raise RuntimeError("agent_decide must be the only decision in a model response")
            details = decisions[0]["args"]
            action = details.get("action")
            if action == "tool_call":
                args = json.loads(details.get("args_json", "{}"))
                if not isinstance(args, dict) or not isinstance(details.get("tool"), str):
                    raise RuntimeError("Invalid agent tool decision")
                response = AIMessage(content="", tool_calls=[{
                    "id": decisions[0]["id"], "name": details["tool"], "args": args,
                }])
                self.runtime["decision_details"] = details
            elif action == "ask_user":
                question = details.get("question")
                if not isinstance(question, str) or not question.strip():
                    raise RuntimeError("Agent clarification question is empty")
                question, _ = sanitize_response(question, self.guard)
                response = AIMessage(content=question)
                self.record(next_state, {
                    "action": "ask_user", "question": question, "context": details.get("clarify_context", ""),
                }, details)
                self.paused = True
                self.runtime["pause_kind"] = "user"
                self.session.status = "paused"
                self.db.add(Message(
                    id=str(uuid.uuid4()), conversation_id=self.session.conversation_id,
                    role="assistant", content=question, model=self.model.model_name,
                ))
            elif action == "respond":
                if not isinstance(details.get("content"), str):
                    raise RuntimeError("Invalid agent response")
                response = AIMessage(content=details["content"])
                self.summary = details.get("summary") or ""
            else:
                raise RuntimeError("Unknown agent decision")
        if not response.tool_calls and not self.paused:
            content, blocked = sanitize_response(str(response.content), self.guard)
            if not content.strip():
                raise RuntimeError("Agent returned an empty response")
            response = AIMessage(content=content)
            self.summary = sanitize_response(self.summary or content, self.guard)[0]
            self.record(next_state, {"action": "respond", "content": content, "summary": self.summary}, details)
            if blocked:
                self.emit("agent_guard_block", step=next_state["iteration_count"], reason="content_safety", detail="响应内容已拦截")
        next_state.update(messages=[*state["messages"], response], paused=self.paused)
        await self.save(next_state)
        if self.paused:
            self.emit("agent_ask_user", question=response.content,
                      context=details.get("clarify_context", ""), session_id=self.session.id)
        if response.tool_calls and next_state["iteration_count"] >= self.runtime["max_iterations"]:
            raise RuntimeError("Agent iteration budget exhausted before tool execution")
        return {"messages": [response], "iteration_count": next_state["iteration_count"], "paused": self.paused}

    async def before_tool(self, state: AgentState, call: dict) -> dict | None:
        name, args, call_id = call["name"], call["args"], call["id"]
        if self.runtime.get("executing_call_id") == call_id:
            raise RuntimeError("Interrupted tool has an uncertain outcome; automatic replay is disabled")
        decision = {
            "action": "tool_call", "tool": name, "args": args,
            "reason": self.runtime.get("decision_details", {}).get("reason", "模型调用工具"),
        }
        is_resuming = self.runtime.get("active_approval_id") and self.runtime.get("pending_call_id") == call_id
        if not is_resuming:
            self.record(state, decision, self.runtime.pop("decision_details", {}))
        allowed = self.runtime.get("tools")
        blocked = (
            name in self.guard.denied_tools
            or (self.guard.allowed_tools and name not in self.guard.allowed_tools)
            or (allowed is not None and name not in allowed)
        )
        tool = self.registry.get(name)
        if (self.runtime.get("tokens_used", 0) >= self.guard.max_tokens
                or self.runtime.get("cost_cents_used", 0) >= self.guard.max_cost_cents):
            self.emit("agent_guard_block", step=state["iteration_count"], reason="budget", detail="任务预算已耗尽")
            raise RuntimeError("Agent token or cost budget exhausted")
        if blocked or tool is None:
            self.emit("agent_guard_block", step=state["iteration_count"], reason="tool_permission",
                      detail=f"工具 {name} 不在允许列表中")
            return {"status": "failed", "error": "Tool is not enabled"}
        if is_resuming:
            self.emit(
                "agent_approval_result", approval_id=self.runtime["active_approval_id"],
                session_id=self.session.id, step=state["iteration_count"],
                status="approved" if self.runtime["approval_action"] == "approve" else "rejected",
                modified_args=self.runtime.get("approval_args"),
                rejection_reason=self.runtime.get("rejection_reason"),
            )
            if self.runtime["approval_action"] == "reject":
                return {"status": "failed", "error": self.runtime.get("rejection_reason") or "Tool approval rejected"}
            if self.runtime.get("approval_args") is not None:
                call["args"] = self.runtime["approval_args"]
                # The graph uses this same dict, so execution receives reviewed arguments.
        elif tool.require_approval:
            approval = AgentApproval(
                id=str(uuid.uuid4()), session_id=self.session.id,
                conversation_id=self.session.conversation_id, step_number=state["iteration_count"],
                tool_name=name, tool_args=args, risk_level=str(tool.risk_level),
                reason=decision["reason"][:500], timeout_ms=300000,
            )
            self.db.add(approval)
            self.session.status = "paused"
            self.runtime.update(pause_kind="approval", pending_call_id=call_id, pending_approval_id=approval.id)
            self.paused = True
            await self.save(state)
            self.emit(
                "agent_approval_required", approval_id=approval.id, session_id=self.session.id,
                step=approval.step_number, tool_name=name, tool_args=args,
                risk_level=approval.risk_level, reason=approval.reason, timeout_ms=approval.timeout_ms,
            )
            return None
        self.runtime["executing_call_id"] = call_id
        await self.save(state)
        return None

    async def after_tool(self, state: AgentState, call: dict, result: dict) -> None:
        content = str(result.get("output", result.get("error", json.dumps(result, ensure_ascii=False))))
        scratchpad = copy.deepcopy(self.session.scratchpad)
        for step in reversed(scratchpad):
            if step["step"] == state["iteration_count"] and step["decision"].get("tool") == call["name"] and "result" not in step:
                step["result"] = content
                if self.runtime.get("approval_args") is not None:
                    step["decision"]["args"] = self.runtime["approval_args"]
                break
        self.session.scratchpad = scratchpad
        for key in (
            "executing_call_id", "active_approval_id", "approval_action", "approval_args",
            "pending_call_id", "pending_approval_id",
        ):
            self.runtime.pop(key, None)
        await self.save(state)
        self.emit("agent_observe", step=state["iteration_count"], result=content)


async def stream_task(
    db: AsyncSession, session: AgentSession, state: AgentState,
    registry: ToolRegistry | None = None,
) -> AsyncIterator[dict]:
    registry = registry or tool_registry
    lifecycle = None
    try:
        runtime = copy.deepcopy(session.runtime_state or {})
        resolved = resolve_model(runtime.get("model"))
        provider_name = runtime.get("provider") or resolved["provider_name"]
        provider = get_provider(provider_name)
        model = ProviderChatModel(provider=provider, model_name=resolved["model_id"])
        registry.init()
        tools = runtime.get("tools")
        guard = TaskGuardConfig.model_validate(runtime.get("guard", {}))
        names = registry.list_names() if tools is None else tools
        names = [name for name in names if name not in guard.denied_tools
                 and (not guard.allowed_tools or name in guard.allowed_tools)]
        definitions = AgentExecutor._to_openai_tools(registry.get_definitions(names)) + [DECISION_TOOL]
        runtime.update(model=resolved["model_id"], provider=provider_name, tool_defs=definitions)
        lifecycle = TaskLifecycle(db, session, registry, runtime, model)
        yield {
            "type": "agent_meta", "session_id": session.id, "model": resolved["model_id"],
            "provider": provider_name, "max_iterations": runtime["max_iterations"],
            "tools_enabled": names,
        }
        graph = build_react_graph(
            model, definitions, registry, session.conversation_id,
            max_iterations=runtime["max_iterations"], lifecycle=lifecycle,
        )
        final_state = state
        async for mode, data in graph.astream(
            state, stream_mode=["updates", "custom"],
            config={"recursion_limit": runtime["max_iterations"] * 3 + 5},
        ):
            if mode == "custom":
                yield data
            else:
                for delta in data.values():
                    final_state = {
                        **final_state, **delta,
                        "messages": [*final_state["messages"], *delta.get("messages", [])],
                    }
        if lifecycle.paused:
            return
        last_message = final_state["messages"][-1]
        if not isinstance(last_message, AIMessage) or last_message.tool_calls:
            raise RuntimeError("Agent did not return a final answer")
        content = str(last_message.content)
        message_id = str(uuid.uuid4())
        db.add(Message(
            id=message_id, conversation_id=session.conversation_id, role="assistant",
            content=content, model=resolved["model_id"],
        ))
        session.status = "completed"
        session.final_summary = lifecycle.summary or content
        session.completed_at = datetime.now(UTC)
        await lifecycle.save(final_state)
        yield {"type": "agent_responding", "step": final_state["iteration_count"]}
        yield {"type": "agent_token", "content": content, "message_id": message_id}
        yield {
            "type": "agent_respond", "content": content, "summary": session.final_summary,
            "message_id": message_id,
        }
        yield {
            "type": "agent_done", "total_steps": final_state["iteration_count"],
            "final_summary": session.final_summary, "session_id": session.id,
        }
    except (asyncio.CancelledError, GeneratorExit):
        with anyio.CancelScope(shield=True):
            await db.rollback()
            await db.refresh(session)
            if session.status == "running":
                session.status = "failed"
                session.final_summary = "Interrupted by user"
                session.completed_at = datetime.now(UTC)
                await db.commit()
        raise
    except Exception:
        logger.exception("Task execution failed session=%s", session.id)
        await db.rollback()
        await db.refresh(session)
        session.status = "failed"
        session.final_summary = "Agent execution failed"
        session.completed_at = datetime.now(UTC)
        await db.commit()
        yield {"type": "agent_error", "error": "Agent execution failed",
               "step": (session.runtime_state or {}).get("iteration_count", 0)}
