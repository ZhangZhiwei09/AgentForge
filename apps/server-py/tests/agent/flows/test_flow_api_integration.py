"""Opt-in local PostgreSQL integration test with deterministic model responses.

AGENT_FLOW_INTEGRATION=1 enables this test after the additive Prisma migration.
Only uniquely identified test rows are removed, and any enabled flow is restored.
"""

import asyncio
import hashlib
import hmac
import json
import os
import time
import uuid

import httpx
import pytest
from fastapi import HTTPException
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool
from sqlalchemy import delete, select, update

from src.agent.executor import AgentExecutor
from src.agent.flows import service
from src.agent.tools.registry import tool_registry
from src.agent.types import RouteContext, StreamDone, StreamToken
from src.api.deps import get_current_user
from src.config import settings
from src.db import async_session, engine
from src.main import app
from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.chat import Conversation
from src.models.user import User


@pytest.mark.skipif(os.environ.get("AGENT_FLOW_INTEGRATION") != "1", reason="Requires local PostgreSQL")
@pytest.mark.asyncio
async def test_flow_api_publish_run_and_resume(monkeypatch):
    actor_id, conversation_id = str(uuid.uuid4()), str(uuid.uuid4())
    actor = User(id=actor_id, email=f"agent-flow-test-{actor_id}@example.test", role="admin")
    ids = []
    calls = []
    outputs = {
        "frontend": {
            "conclusion": "需要后端排查", "evidence": [], "need_escalation": True,
            "context_for_backend": {"traceId": "integration-trace"}, "escalation_reason": "backend",
        },
        "backend": {"conclusion": "后端证据不足", "evidence": []},
        "leader": {
            "frontend_score": 1, "backend_score": 1, "frontend_breakdown": {}, "backend_breakdown": {},
            "reasoning": "证据不足", "synthesis": "需要补充", "missing_fields": ["时间"], "message": "请补充时间",
        },
        "database_expert": {"conclusion": "数据库正常"},
    }

    async def execute(self, context, system_prompt=None):
        node_id = context.assistant_msg_id.removeprefix("flow-")
        calls.append(node_id)
        yield StreamToken(content=json.dumps(outputs[node_id], ensure_ascii=False))
        yield StreamDone()

    monkeypatch.setattr(AgentExecutor, "execute", execute)
    monkeypatch.setattr(service, "get_checkpointer", lambda **kwargs: _saver())
    monkeypatch.setattr(settings, "langgraph_diagnosis_hitl_enabled", True)
    pool = AsyncConnectionPool(
        settings.database_url.replace("+asyncpg", ""), open=False, kwargs={"autocommit": True},
    )
    saver = AsyncPostgresSaver(pool)

    async def _saver():
        return saver

    app.dependency_overrides[get_current_user] = lambda: actor
    previous = []
    try:
        await pool.open()
        await saver.setup()
        async with async_session() as db:
            previous = list((await db.scalars(select(AgentFlow.id).where(AgentFlow.enabled.is_(True)))).all())
            db.add(actor)
            await db.flush()
            db.add(Conversation(id=conversation_id, user_id=actor_id, title="Flow integration test"))
            await db.commit()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            actor.role = "user"
            assert (await client.get("/api/agent-flows")).status_code == 403
            actor.role = "admin"
            created = await client.post("/api/agent-flows", json={"name": "Integration flow"})
            assert created.status_code == 201, created.text
            flow = created.json()
            ids.append(flow["id"])
            base = f"/api/agent-flows/{flow['id']}"
            assert (await client.post(f"{base}/publish", json={"revision": 99})).status_code == 409
            draft = flow["draft"]
            draft["nodes"].append({
                "id": "database_expert", "type": "agent", "name": "数据库专家",
                "role": {"name": "数据库专家", "systemPrompt": "你是数据库专家"},
                "task": "验证数据库", "inputs": {"question": {"source": "task"}},
                "outputs": [{"name": "conclusion", "type": "string"}],
            })
            next(e for e in draft["edges"] if e["source"] == "backend")["target"] = "database_expert"
            draft["edges"].append({"id": "database_leader", "source": "database_expert", "target": "leader"})
            next(n for n in draft["nodes"] if n["id"] == "leader")["inputs"]["database"] = {
                "source": "node", "nodeId": "database_expert",
            }
            saved = await client.put(f"{base}/draft", json={"name": flow["name"], "revision": 1, "definition": draft})
            assert saved.status_code == 200, saved.text
            flow = saved.json()
            revision = flow["draftRevision"]
            assert (await client.post(f"{base}/publish", json={"revision": revision})).status_code == 200
            assert (await client.put(f"{base}/activation", json={"enabled": True})).status_code == 200
            trial = await client.post(f"{base}/test-run", json={"revision": revision, "message": "ACE_TIMEOUT"})
            assert trial.status_code == 200, trial.text
            assert '"flow_completed"' in trial.text
            assert "database_expert" in trial.text
            assert calls == ["frontend", "backend", "database_expert", "leader"]
            records = (await client.get(f"{base}/runs")).json()["items"]
            assert records[0]["status"] == "completed"
            assert records[0]["records"]["database_expert"]["status"] == "completed"

            context = RouteContext(conversation_id=conversation_id, user_message="ACE_TIMEOUT")
            claims = await asyncio.gather(
                service.claim_diagnosis(context, actor_id), service.claim_diagnosis(context, actor_id),
                return_exceptions=True,
            )
            claimed = next(item[0] for item in claims if isinstance(item, tuple))
            rejected = next(item for item in claims if isinstance(item, HTTPException))
            assert rejected.status_code == 409
            cancellation = await client.post(f"{base}/runs/{claimed.id}/cancel")
            assert cancellation.status_code == 200
            cancelled = [
                event async for event in service.execute_run(
                    claimed, context, tool_registry, asyncio.Event(),
                )
            ]
            assert cancelled[-1]["type"] == "flow_cancelled"
            cancelled_detail = (await client.get(f"{base}/runs/{claimed.id}")).json()
            assert cancelled_detail["status"] == "cancelled"
            assert all(record["status"] != "running" for record in cancelled_detail["records"].values())

            def headers(payload):
                stamp = str(int(time.time()))
                text = stamp + "\n/api/agent-flows/runtime/diagnose\n" + payload
                return {
                    "Content-Type": "application/json", "X-Agent-Flow-Timestamp": stamp,
                    "X-Agent-Flow-Signature": hmac.new(
                        settings.jwt_secret.encode(), text.encode(), hashlib.sha256,
                    ).hexdigest(),
                }

            payload = json.dumps({
                "conversationId": conversation_id, "assistantMsgId": "message-1",
                "userMessage": "traceId: integration-trace H5 ACE_TIMEOUT，核身失败请排查",
            })
            assert (await client.post("/api/agent-flows/runtime/diagnose", content=payload)).status_code == 401
            tampered = payload.replace("message-1", "message-tampered")
            assert (await client.post(
                "/api/agent-flows/runtime/diagnose", content=tampered, headers=headers(payload),
            )).status_code == 401
            expired = headers(payload)
            expired["X-Agent-Flow-Timestamp"] = str(int(time.time()) - 60)
            assert (await client.post(
                "/api/agent-flows/runtime/diagnose", content=payload, headers=expired,
            )).status_code == 401
            first = await client.post("/api/agent-flows/runtime/diagnose", content=payload, headers=headers(payload))
            assert first.status_code == 200, first.text
            assert "diagnosis_waiting_input" in first.text
            runs = (await client.get(f"{base}/runs")).json()["items"]
            waiting = next(run for run in runs if not run["test"])
            assert waiting["status"] == "waiting_input"
            assert waiting["version"] == 1
            count = len(calls)
            # A new saver instance has no in-memory state; resume reads persisted checkpoints.
            saver = AsyncPostgresSaver(pool)
            # Publish a changed draft and disable: resume must still use snapshot v1.
            changed = flow["draft"]
            next(n for n in changed["nodes"] if n["id"] == "database_expert")["name"] = "修改后的专家"
            update_response = await client.put(f"{base}/draft", json={
                "name": flow["name"], "revision": revision, "definition": changed,
            })
            new_revision = update_response.json()["draftRevision"]
            assert (await client.post(f"{base}/publish", json={"revision": new_revision})).status_code == 200
            assert (await client.put(f"{base}/activation", json={"enabled": False})).status_code == 200
            payload = json.dumps({
                "conversationId": conversation_id, "assistantMsgId": "message-2", "userMessage": "10:30",
            })
            resumed = await client.post("/api/agent-flows/runtime/diagnose", content=payload, headers=headers(payload))
            assert resumed.status_code == 200, resumed.text
            assert "diagnosis_completed" in resumed.text
            assert len(calls) == count
            async with async_session() as db:
                run = await db.get(AgentFlowRun, waiting["id"])
                assert run.version == 1 and run.status == "completed"
                assert next(n for n in run.snapshot["nodes"] if n["id"] == "database_expert")["name"] == "数据库专家"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        async with async_session() as db:
            thread_ids = list((await db.scalars(
                select(AgentFlowRun.id).where(AgentFlowRun.flow_id.in_(ids)),
            )).all()) if ids else []
            if ids:
                await db.execute(delete(AgentFlowRun).where(AgentFlowRun.flow_id.in_(ids)))
                await db.execute(delete(AgentFlow).where(AgentFlow.id.in_(ids)))
            if previous:
                await db.execute(update(AgentFlow).where(AgentFlow.id.in_(previous)).values(enabled=True))
            await db.execute(delete(Conversation).where(Conversation.id == conversation_id))
            await db.execute(delete(User).where(User.id == actor_id))
            await db.commit()
        for thread_id in thread_ids:
            await saver.adelete_thread(thread_id)
        await pool.close()
        await engine.dispose()
