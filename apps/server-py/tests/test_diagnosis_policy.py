"""Diagnosis entry points must preserve identity and reject unavailable evidence."""

import asyncio
import hashlib
import hmac
import json
import time
from unittest.mock import MagicMock

import pytest
from sqlalchemy import func, select

from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.executor import AgentExecutor
from src.agent.flows import service
from src.agent.flows.diagnosis import diagnosis_events
from src.agent.flows.templates import diagnosis_template
from src.agent.tools.registry import ToolRegistry
from src.agent.types import RouteContext, StreamDone, StreamError
from src.api.v1 import diagnosis
from src.config import settings
from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.chat import Conversation
from src.services.execution_policy import ToolExecutionContext, build_execution_policy

ADMIN = {"X-Test-Actor": "admin"}
USER = {"X-Test-Actor": "user"}


async def seed(sessions):
    snapshot = diagnosis_template().model_dump(mode="json", by_alias=True)
    async with sessions() as db:
        db.add(Conversation(id="conv", user_id="user", type="agent_chat"))
        db.add(AgentFlow(
            id="flow", name="demo", draft=snapshot, published=snapshot,
            published_version=1, enabled=True, updated_by="admin",
        ))
        await db.commit()


async def signed_request(client, trace_id="abc123"):
    path = "/api/agent-flows/runtime/diagnose"
    payload = json.dumps({
        "conversation_id": "conv", "user_message": f"traceId={trace_id}",
        "assistant_msg_id": "msg",
    })
    stamp = str(int(time.time()))
    signature = hmac.new(
        settings.jwt_secret.encode(), f"{stamp}\n{path}\n{payload}".encode(), hashlib.sha256,
    ).hexdigest()
    return await client.post(path, content=payload, headers={
        "Content-Type": "application/json", "X-Agent-Flow-Timestamp": stamp,
        "X-Agent-Flow-Signature": signature,
    })


@pytest.mark.parametrize("mode, trace_id", [("disabled", "abc123"), ("mock", "unknown123")])
async def test_all_diagnosis_apis_reject_missing_evidence(entry_api, monkeypatch, mode, trace_id):
    client, sessions = entry_api
    await seed(sessions)
    monkeypatch.setattr(settings, "monitoring_mode", mode)
    resolve = MagicMock(side_effect=AssertionError("must not invoke a model"))
    monkeypatch.setattr(diagnosis, "resolve_model", resolve)
    runner = MagicMock(side_effect=AssertionError("must not run diagnosis"))
    monkeypatch.setattr(service, "run_flow", runner)
    response = await client.post("/api/diagnosis/query", headers=USER, json={"query": f"traceId={trace_id}"})
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["toolResults"] == []
    assert (await signed_request(client, trace_id)).status_code == 503
    trial = await client.post("/api/agent-flows/flow/test-run", headers=ADMIN, json={
        "revision": 1, "message": f"traceId={trace_id}",
    })
    assert trial.status_code == 503
    resolve.assert_not_called()
    runner.assert_not_called()
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(AgentFlowRun)) == 0


@pytest.mark.parametrize("entry", ["bridge", "admin"])
async def test_flow_runtime_binds_server_owned_identity(entry_api, monkeypatch, monitoring_demo, entry):
    client, sessions = entry_api
    await seed(sessions)
    monkeypatch.setattr(service, "async_session", sessions)
    seen = []

    async def run_flow(definition, context, registry, run_id, cancel, **kwargs):
        seen.append(registry.context)
        assert registry.context.run_id == run_id
        assert registry.context.conversation_id == context.conversation_id
        assert (await registry.execute("db_query", {}, context.conversation_id))["status"] == "failed"
        assert (await registry.get("query_trace_log").execute({"traceId": "abc123"}, "foreign"))["status"] == "failed"
        result = await registry.execute("query_trace_log", {"traceId": "abc123"}, context.conversation_id)
        assert result["status"] == "success"
        yield {"type": "flow_started", "agents": []}
        yield {"type": "flow_completed", "output": {"conclusion": "demo"}, "skippedNodes": []}

    monkeypatch.setattr(service, "run_flow", run_flow)
    if entry == "bridge":
        response = await signed_request(client)
    else:
        response = await client.post("/api/agent-flows/flow/test-run", headers=ADMIN, json={
            "revision": 1, "message": "traceId=abc123",
        })
    assert response.status_code == 200, response.text
    assert len(seen) == 1 and seen[0].actor_id == ("user" if entry == "bridge" else "admin")
    assert "模拟监控" in response.text if entry == "bridge" else '"evidenceSource": "mock"' in response.text
    async with sessions() as db:
        run = await db.scalar(select(AgentFlowRun))
        assert run.actor_id == seen[0].actor_id and run.status == "completed"


async def test_revoked_monitoring_fails_existing_flow_without_validated_success(entry_api, monkeypatch, monitoring_demo):
    _, sessions = entry_api
    await seed(sessions)
    monkeypatch.setattr(service, "async_session", sessions)
    async with sessions() as db:
        flow = await db.get(AgentFlow, "flow")
        run = await service.create_run(db, flow, "user", "conv")
    monkeypatch.setattr(settings, "monitoring_mode", "disabled")
    runner = MagicMock(side_effect=AssertionError("revoked capability must stop execution"))
    monkeypatch.setattr(service, "run_flow", runner)
    events = [event async for event in diagnosis_events(
        run, RouteContext(conversation_id="conv", user_message="traceId=abc123"),
        ToolRegistry(), asyncio.Event(),
    )]
    assert any(isinstance(event, StreamError) for event in events)
    assert isinstance(events[-1], StreamDone) and events[-1].validated is False
    runner.assert_not_called()
    async with sessions() as db:
        assert (await db.get(AgentFlowRun, run.id)).status == "failed"


@pytest.mark.parametrize("legacy", [False, True])
async def test_executors_reject_missing_context_before_model(monkeypatch, legacy):
    resolve = MagicMock(side_effect=AssertionError("unbound execution must stop before model"))
    monkeypatch.setattr("src.agent.executor.resolve_model", resolve)
    context = RouteContext(conversation_id="conv", user_message="traceId=abc123")
    stream = (DiagnosisRouteAgent().execute(context, ToolRegistry()) if legacy
              else AgentExecutor(checkpoint=False).execute(context))
    events = [event async for event in stream]
    assert any(isinstance(event, StreamError) for event in events)
    assert events[-1].validated is False
    resolve.assert_not_called()


async def test_legacy_diagnosis_binds_context_and_rejects_unknown_trace(monkeypatch, monitoring_demo):
    context = RouteContext(
        conversation_id="conv", user_message="traceId=unknown123",
        execution_context=ToolExecutionContext(
            actor_id="user", conversation_id="conv", run_id="run", policy=build_execution_policy(),
        ),
    )
    events = [event async for event in DiagnosisRouteAgent().execute(context, ToolRegistry())]
    assert any(isinstance(event, StreamError) and "未找到" in event.content for event in events)
    assert events[-1].validated is False
