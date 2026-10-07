"""Administrator flow management and signed server-to-server diagnosis bridge."""

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from contextlib import aclosing

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import Field
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.flows.diagnosis import diagnosis_events
from src.agent.flows.schema import FlowDefinition, FlowModel, validate_definition
from src.agent.flows.service import (
    claim_diagnosis, create_run, execute_run, flow_dto, get_flow, require_valid, run_dto,
)
from src.agent.flows.templates import diagnosis_template
from src.agent.tools.registry import tool_registry
from src.agent.types import RouteContext
from src.api.deps import get_current_user, get_db
from src.api.v1.sse import _to_sse
from src.config import settings
from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.chat import Conversation
from src.models.user import User

router = APIRouter(prefix="/api/agent-flows", tags=["agent-flows"])


async def admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可以管理 Agent 流程")
    return user


class CreateRequest(FlowModel):
    name: str = Field(default="核身诊断流程", min_length=1, max_length=200)


class SaveRequest(CreateRequest):
    revision: int = Field(ge=1)
    definition: FlowDefinition


class RevisionRequest(FlowModel):
    revision: int = Field(ge=1)


class ActivationRequest(FlowModel):
    enabled: bool


class TestRequest(RevisionRequest):
    message: str = Field(min_length=1, max_length=12000)


class DiagnoseRequest(FlowModel):
    conversation_id: str
    user_message: str = Field(min_length=1, max_length=12000)
    assistant_msg_id: str
    session_id: str | None = None
    resolved_model: str = ""
    provider_name: str = ""


def check_revision(flow: AgentFlow, revision: int):
    if flow.draft_revision != revision:
        raise HTTPException(409, "草稿已被其他页面修改，请重新加载")


async def signed_bridge(request: Request):
    stamp = request.headers.get("x-agent-flow-timestamp", "")
    signature = request.headers.get("x-agent-flow-signature", "")
    try:
        if abs(time.time() - int(stamp)) > 30:
            raise ValueError()
    except ValueError:
        raise HTTPException(401, "Invalid bridge timestamp") from None
    body = await request.body()
    if len(body) > 65536:
        raise HTTPException(413, "Request too large")
    payload = stamp.encode() + b"\n" + request.url.path.encode() + b"\n" + body
    expected = hmac.new(settings.jwt_secret.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(401, "Invalid bridge signature")


@router.post("/runtime/diagnose", dependencies=[Depends(signed_bridge)])
async def runtime_diagnose(body: DiagnoseRequest, db: AsyncSession = Depends(get_db)):
    conversation = await db.get(Conversation, body.conversation_id)
    if conversation is None:
        raise HTTPException(404, "会话不存在；请确认两套后端使用同一业务数据库")
    context = RouteContext(**body.model_dump(), intent="diagnosis")
    # Preserve preflight for new diagnoses, but never block a waiting run's supplement.
    waiting = await db.scalar(select(AgentFlowRun.id).where(
        AgentFlowRun.conversation_id == conversation.id,
        AgentFlowRun.status == "waiting_input", AgentFlowRun.test.is_(False),
    ))
    if not waiting:
        from src.agent.diagnosis.route_agent import _check_info_sufficiency
        from src.agent.types import ClarificationNeeded, StreamDone, StreamToken
        info = _check_info_sufficiency(body.user_message)
        if not info["sufficient"]:
            async def clarification():
                yield ClarificationNeeded(
                    message_id=body.assistant_msg_id, intent=info["intent"],
                    missing_fields=info["missing_fields"], prompt_message=info["prompt_message"],
                    hints=info["hints"],
                )
                yield StreamToken(message_id=body.assistant_msg_id, content=info["prompt_message"])
                yield StreamDone(message_id=body.assistant_msg_id, route="DIAGNOSIS", usage={})
            return StreamingResponse(_to_sse(clarification()), media_type="text/event-stream")
    run, resume = await claim_diagnosis(context, conversation.user_id)
    if run is None:
        raise HTTPException(409, "未启用诊断流程")
    async def public_events():
        async with aclosing(
            diagnosis_events(run, context, tool_registry, asyncio.Event(), resume=resume),
        ) as stream:
            async for frame in _to_sse(stream):
                yield frame
    return StreamingResponse(public_events(), media_type="text/event-stream")


@router.get("/tools")
async def tools(user: User = Depends(admin)):
    return {"tools": [
        {"name": item.function.name, "description": item.function.description}
        for item in tool_registry.get_definitions()
    ]}


@router.get("")
async def list_flows(user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(AgentFlow).where(
        AgentFlow.archived.is_(False),
    ).order_by(AgentFlow.updated_at.desc()))).scalars().all()
    return {"items": [flow_dto(flow) for flow in rows]}


@router.post("", status_code=201)
async def create(body: CreateRequest, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    flow = AgentFlow(
        id=str(uuid.uuid4()), name=body.name, updated_by=user.id,
        draft=diagnosis_template().model_dump(mode="json", by_alias=True),
    )
    db.add(flow)
    await db.commit()
    return flow_dto(flow)


@router.get("/{flow_id}")
async def detail(flow_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    return flow_dto(await get_flow(db, flow_id))


@router.put("/{flow_id}/draft")
async def save(flow_id: str, body: SaveRequest, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    flow = await get_flow(db, flow_id, locked=True)
    check_revision(flow, body.revision)
    if len(body.definition.model_dump_json().encode()) > 262144:
        raise HTTPException(413, "流程配置超过 256 KB")
    flow.name = body.name
    flow.draft = body.definition.model_dump(mode="json", by_alias=True)
    flow.draft_revision += 1
    flow.updated_by = user.id
    await db.commit()
    return flow_dto(flow)


@router.post("/{flow_id}/validate")
async def validate(flow_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    flow = await get_flow(db, flow_id)
    errors = validate_definition(FlowDefinition.model_validate(flow.draft), set(tool_registry.list_names()))
    return {"valid": not errors, "errors": errors}


@router.post("/{flow_id}/publish")
async def publish(
    flow_id: str, body: RevisionRequest, user: User = Depends(admin), db: AsyncSession = Depends(get_db),
):
    flow = await get_flow(db, flow_id, locked=True)
    check_revision(flow, body.revision)
    require_valid(FlowDefinition.model_validate(flow.draft))
    flow.published = flow.draft
    flow.published_version += 1
    flow.published_revision = flow.draft_revision
    flow.updated_by = user.id
    await db.commit()
    return flow_dto(flow)


@router.put("/{flow_id}/activation")
async def activate(
    flow_id: str, body: ActivationRequest, user: User = Depends(admin), db: AsyncSession = Depends(get_db),
):
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('agent-flow-activation'))"))
    flow = await get_flow(db, flow_id, locked=True)
    if body.enabled:
        if flow.published is None:
            raise HTTPException(409, "请先发布流程")
        require_valid(FlowDefinition.model_validate(flow.published))
        await db.execute(update(AgentFlow).where(
            AgentFlow.scene == flow.scene, AgentFlow.id != flow.id,
        ).values(enabled=False))
    flow.enabled = body.enabled
    flow.updated_by = user.id
    await db.commit()
    return flow_dto(flow)


@router.delete("/{flow_id}")
async def archive(flow_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    flow = await get_flow(db, flow_id, locked=True)
    flow.enabled = False
    flow.archived = True
    flow.updated_by = user.id
    await db.commit()
    return {"ok": True}


@router.post("/{flow_id}/test-run")
async def test_run(
    flow_id: str, body: TestRequest, user: User = Depends(admin), db: AsyncSession = Depends(get_db),
):
    flow = await get_flow(db, flow_id, locked=True)
    check_revision(flow, body.revision)
    run = await create_run(db, flow, user.id, None, test=True)
    context = RouteContext(user_message=body.message, conversation_id=f"test-{run.id}", intent="diagnosis")

    async def events():
        async with aclosing(execute_run(run, context, tool_registry, asyncio.Event())) as stream:
            async for event in stream:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    return StreamingResponse(events(), media_type="text/event-stream")


@router.get("/{flow_id}/runs")
async def runs(flow_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(AgentFlowRun).where(
        AgentFlowRun.flow_id == flow_id,
    ).order_by(AgentFlowRun.created_at.desc()).limit(20))).scalars().all()
    return {"items": [run_dto(run) for run in rows]}


@router.get("/{flow_id}/runs/{run_id}")
async def run_detail(
    flow_id: str, run_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db),
):
    run = await db.get(AgentFlowRun, run_id)
    if run is None or run.flow_id != flow_id:
        raise HTTPException(404, "运行不存在")
    return run_dto(run)


@router.post("/{flow_id}/runs/{run_id}/cancel")
async def cancel_run(
    flow_id: str, run_id: str, user: User = Depends(admin), db: AsyncSession = Depends(get_db),
):
    run = await db.get(AgentFlowRun, run_id)
    if run is None or run.flow_id != flow_id:
        raise HTTPException(404, "运行不存在")
    if run.status not in ("running", "waiting_input"):
        raise HTTPException(409, "运行已结束")
    run.cancel_requested = True
    if run.status == "waiting_input":
        run.status = "cancelled"
    await db.commit()
    return {"ok": True}
