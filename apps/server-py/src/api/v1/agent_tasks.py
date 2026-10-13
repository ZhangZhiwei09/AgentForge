"""Compatible authenticated task execution, session and approval endpoints."""

import json
import uuid
from contextlib import aclosing
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    messages_to_dict,
)
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.task_guard import TaskGuardConfig
from src.api.deps import get_current_user, get_db
from src.models.agent_session import AgentApproval, AgentSession
from src.models.chat import Message
from src.models.user import User
from src.services.agent_tasks import (
    TASK_PROMPT,
    approval_dto,
    claim_approval,
    claim_resume,
    owned_conversation,
    owned_session,
    session_dto,
    stream_task,
)

router = APIRouter(tags=["agent-tasks"])
Db = Annotated[AsyncSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_current_user)]


class AgentRunRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    task: str = Field(min_length=1, max_length=16000)
    model: str | None = None
    max_iterations: int = Field(default=10, ge=1, le=20)
    tools: list[str] | None = None
    guard_config: TaskGuardConfig | None = None


class AgentRespondRequest(BaseModel):
    session_id: str = Field(min_length=1)
    response: str = Field(min_length=1, max_length=16000)


class AgentApprovalRequest(BaseModel):
    session_id: str = Field(min_length=1)
    approval_id: str = Field(min_length=1)
    action: Literal["approve", "reject"]
    modified_args: dict | None = None
    rejection_reason: str | None = Field(default=None, max_length=500)


def task_response(db: AsyncSession, session: AgentSession, state: dict) -> StreamingResponse:
    async def events():
        async with aclosing(stream_task(db, session, state)) as stream:
            async for event in stream:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


@router.post("/api/agent/run")
async def run_task(body: AgentRunRequest, actor: Actor, db: Db):
    await owned_conversation(db, body.conversation_id, actor.id)
    history = list(await db.scalars(select(Message).where(
        Message.conversation_id == body.conversation_id, Message.role.in_(["user", "assistant"]),
        Message.type == "text",
    ).order_by(Message.created_at.desc(), Message.id.desc()).limit(100)))
    messages = [SystemMessage(content=TASK_PROMPT)]
    # Bound history to leave room for the task, tools and response.
    remaining = 12000
    selected = []
    for message in history:
        if len(message.content) > remaining:
            break
        selected.append(message)
        remaining -= len(message.content)
    messages.extend(
        HumanMessage(content=message.content) if message.role == "user" else AIMessage(content=message.content)
        for message in reversed(selected)
    )
    messages.append(HumanMessage(content=body.task))
    runtime = {
        "version": 1, "messages": messages_to_dict(messages), "iteration_count": 0,
        "max_iterations": body.max_iterations, "model": body.model, "tools": body.tools or None,
        "guard": (body.guard_config or TaskGuardConfig()).model_dump(),
        "tokens_used": 0, "cost_cents_used": 0, "pause_kind": None,
    }
    session = AgentSession(
        id=str(uuid.uuid4()), conversation_id=body.conversation_id, task=body.task,
        status="running", scratchpad=[], runtime_state=runtime,
    )
    db.add(session)
    db.add(Message(
        id=str(uuid.uuid4()), conversation_id=body.conversation_id, role="user",
        content=body.task, model=body.model,
    ))
    await db.commit()
    return task_response(db, session, {"messages": messages, "iteration_count": 0})


@router.post("/api/agent/respond")
async def respond_task(body: AgentRespondRequest, actor: Actor, db: Db):
    session = await owned_session(db, body.session_id, actor.id)
    state = await claim_resume(db, session, body.response)
    return task_response(db, session, state)


@router.post("/api/agent/approve")
async def approve_task(body: AgentApprovalRequest, actor: Actor, db: Db):
    session = await owned_session(db, body.session_id, actor.id)
    state, _ = await claim_approval(
        db, session, body.approval_id, body.action, actor.id, body.modified_args, body.rejection_reason,
    )
    return task_response(db, session, state)


@router.get("/api/agent/approvals")
async def list_approvals(actor: Actor, db: Db, session_id: str | None = None):
    if not session_id:
        raise HTTPException(400, "Missing session_id parameter")
    await owned_session(db, session_id, actor.id, detail=True)
    rows = await db.scalars(select(AgentApproval).where(
        AgentApproval.session_id == session_id,
    ).order_by(AgentApproval.requested_at.desc(), AgentApproval.id.desc()))
    return [approval_dto(row) for row in rows]


@router.get("/api/agent-sessions")
async def list_sessions(actor: Actor, db: Db, conversation_id: str | None = None):
    if not conversation_id:
        raise HTTPException(400, "Missing conversation_id parameter")
    await owned_conversation(db, conversation_id, actor.id)
    rows = await db.scalars(select(AgentSession).where(
        AgentSession.conversation_id == conversation_id,
    ).order_by(AgentSession.started_at.desc(), AgentSession.id.desc()))
    return [session_dto(row) for row in rows]


@router.get("/api/agent-sessions/{session_id}")
async def get_session(session_id: str, actor: Actor, db: Db):
    return session_dto(await owned_session(db, session_id, actor.id, detail=True))
