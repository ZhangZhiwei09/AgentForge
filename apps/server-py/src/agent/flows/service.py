"""Persistence and execution lifecycle for immutable flow runs.

Cancellation is persisted and polled so requests need not reach the worker
hosting a run. Waiting runs are located by their authoritative conversation
owner and keep their old snapshot across publish, disable and restarts.
"""

import asyncio
import re
import time
import uuid
from collections.abc import AsyncIterator

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.checkpoint import get_checkpointer
from src.agent.flows.runtime import run_flow
from src.agent.flows.schema import FlowDefinition, validate_definition
from src.agent.tools.registry import ToolRegistry, tool_registry
from src.agent.types import RouteContext
from src.config import settings
from src.db import async_session
from src.models.agent_flow import AgentFlow, AgentFlowRun


def flow_dto(flow: AgentFlow) -> dict:
    return {
        "id": flow.id, "name": flow.name, "scene": flow.scene, "draft": flow.draft,
        "draftRevision": flow.draft_revision, "publishedVersion": flow.published_version,
        "publishedRevision": flow.published_revision, "enabled": flow.enabled,
        "archived": flow.archived, "updatedAt": flow.updated_at.isoformat(),
    }


def redact(value):
    """Bound debug records and remove common credentials before persistence."""
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if re.search(r"password|secret|authorization|api.?key|access.?token", key, re.I)
            else redact(item) for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value[:200]]
    if isinstance(value, str):
        return re.sub(r"(?i)Bearer\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]", value)[:16000]
    return value


def run_dto(run: AgentFlowRun) -> dict:
    return {
        "id": run.id, "flowId": run.flow_id, "version": run.version,
        "draftRevision": run.draft_revision, "test": run.test, "status": run.status,
        "records": run.records, "output": run.output, "error": run.error,
        "durationMs": run.duration_ms, "createdAt": run.created_at.isoformat(),
    }


def require_valid(definition: FlowDefinition, registry: ToolRegistry = tool_registry):
    errors = validate_definition(definition, set(registry.list_names()))
    if errors:
        raise HTTPException(422, detail={"message": "流程校验失败", "errors": errors})


async def get_flow(db: AsyncSession, flow_id: str, *, locked=False) -> AgentFlow:
    stmt = select(AgentFlow).where(AgentFlow.id == flow_id, AgentFlow.archived.is_(False))
    if locked:
        stmt = stmt.with_for_update()
    flow = (await db.execute(stmt)).scalar_one_or_none()
    if flow is None:
        raise HTTPException(404, "流程不存在")
    return flow


async def create_run(
    db: AsyncSession, flow: AgentFlow, actor_id: str, conversation_id: str | None, *, test=False,
) -> AgentFlowRun:
    snapshot = flow.draft if test else flow.published
    if snapshot is None:
        raise HTTPException(409, "流程尚未发布")
    definition = FlowDefinition.model_validate(snapshot)
    require_valid(definition)
    run = AgentFlowRun(
        id=str(uuid.uuid4()), flow_id=flow.id, version=flow.published_version,
        draft_revision=flow.draft_revision if test else None, snapshot=snapshot,
        actor_id=actor_id, conversation_id=conversation_id, test=test,
        status="running", records={}, duration_ms=0, cancel_requested=False,
    )
    db.add(run)
    await db.commit()
    return run


async def claim_diagnosis(context: RouteContext, actor_id: str) -> tuple[AgentFlowRun | None, bool]:
    async with async_session() as db:
        # A transaction-scoped lock serializes flow selection/resume across workers.
        from sqlalchemy import text
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {
            "key": f"agent-flow-conversation:{context.conversation_id}",
        })
        waiting = (await db.execute(select(AgentFlowRun).where(
            AgentFlowRun.conversation_id == context.conversation_id,
            AgentFlowRun.actor_id == actor_id, AgentFlowRun.test.is_(False),
            AgentFlowRun.status == "waiting_input",
        ).with_for_update())).scalar_one_or_none()
        if waiting:
            waiting.status = "running"
            await db.commit()
            return waiting, True
        running = (await db.execute(select(AgentFlowRun.id).where(
            AgentFlowRun.conversation_id == context.conversation_id,
            AgentFlowRun.test.is_(False), AgentFlowRun.status == "running",
        ))).first()
        if running:
            raise HTTPException(409, "此会话已有流程正在执行")
        flow = (await db.execute(select(AgentFlow).where(
            AgentFlow.enabled.is_(True), AgentFlow.scene == "diagnosis",
        ))).scalar_one_or_none()
        if flow is None:
            return None, False
        return await create_run(db, flow, actor_id, context.conversation_id), False


async def execute_run(
    run: AgentFlowRun, context: RouteContext, registry: ToolRegistry,
    cancel: asyncio.Event, *, resume: bool = False,
) -> AsyncIterator[dict]:
    definition = FlowDefinition.model_validate(run.snapshot)
    require_valid(definition, registry)
    started = time.monotonic()
    previous_duration = run.duration_ms
    records = dict(run.records)
    terminal = False
    stream = None

    async def persist(**values):
        async with async_session() as db:
            await db.execute(update(AgentFlowRun).where(AgentFlowRun.id == run.id).values(**values))
            await db.commit()

    async def watch_cancel():
        while not cancel.is_set():
            async with async_session() as db:
                requested = await db.scalar(select(AgentFlowRun.cancel_requested).where(AgentFlowRun.id == run.id))
            if requested:
                cancel.set()
                return
            await asyncio.sleep(0.5)

    watcher = asyncio.create_task(watch_cancel())
    try:
        remaining = definition.limits.timeout_ms - previous_duration
        if remaining <= 0:
            raise TimeoutError("流程总执行预算已用完")
        checkpointer = None
        if settings.langgraph_diagnosis_checkpoint_enabled or resume:
            checkpointer = await get_checkpointer(required=True)
        if resume and checkpointer is None:
            raise RuntimeError("无法续跑：checkpoint 不可用")
        stream = run_flow(
            definition, context, registry, run.id, cancel, checkpointer=checkpointer,
            resume=context.user_message if resume else None,
            hitl=settings.langgraph_diagnosis_hitl_enabled and not run.test,
            timeout_ms=remaining,
        )
        async for event in stream:
            duration = previous_duration + round((time.monotonic() - started) * 1000)
            kind = event["type"]
            if kind.startswith("node_"):
                node_id = event["nodeId"]
                node = next(n for n in definition.nodes if n.id == node_id)
                record = {
                    **records.get(node_id, {}),
                    "nodeId": node_id, "name": node.name, "type": node.type,
                    **{k: v for k, v in event.items() if k != "type"},
                    "status": {"node_started": "running", "node_completed": "completed", "node_failed": "failed"}[kind],
                }
                records[node_id] = redact(record)
                await persist(records=records, duration_ms=duration)
            if kind in ("flow_completed", "flow_failed", "flow_cancelled", "flow_waiting_input"):
                terminal = True
                status = {
                    "flow_completed": "completed", "flow_failed": "failed",
                    "flow_cancelled": "cancelled", "flow_waiting_input": "waiting_input",
                }[kind]
                if status in ("failed", "cancelled"):
                    for record in records.values():
                        if record.get("status") == "running":
                            record["status"] = status
                for node_id in event.get("skippedNodes", []):
                    node = next(n for n in definition.nodes if n.id == node_id)
                    records[node_id] = {"nodeId": node_id, "name": node.name, "type": node.type, "status": "skipped"}
                await persist(
                    status=status, records=records, output=redact(event.get("output")),
                    error=redact(event.get("error")), duration_ms=duration,
                )
            # Raw inputs/results are only consumed here or by authorized admin SSE.
            yield redact(event) if run.test else event
    except asyncio.CancelledError:
        cancel.set()
        raise
    except Exception as exc:
        terminal = True
        for record in records.values():
            if record.get("status") == "running":
                record["status"] = "failed"
        await persist(status="failed", records=records, error=redact(str(exc)))
        yield {"type": "flow_failed", "runId": run.id, "error": "流程执行失败，请查看管理端运行记录"}
    finally:
        if stream is not None:
            await stream.aclose()
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        if not terminal:
            cancel.set()
            for record in records.values():
                if record.get("status") == "running":
                    record["status"] = "cancelled"
            await persist(status="cancelled", records=records)
