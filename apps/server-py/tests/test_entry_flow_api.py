import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from src.agent.entry_flows.schema import EntryFlowError
from src.models.entry_flow import EntryRouteFlow, EntryRouteFlowRun
from src.services.entry_flows import EntryRouteFlowService
from tests.entry_fixtures import create_flow, enable_flow

ADMIN = {"X-Test-Actor": "admin"}


async def test_admin_and_input_contracts(entry_api):
    client, _ = entry_api
    assert (await client.get("/api/entry-route-flows")).status_code == 401
    denied = await client.get("/api/entry-route-flows", headers={"X-Test-Actor": "user"})
    assert denied.status_code == 403
    assert denied.headers["cache-control"] == "no-store"
    for body in ({"name": " "}, {"name": "valid", "unknown": 1}, {"name": "valid", "template": "code"}):
        response = await client.post("/api/entry-route-flows", json=body, headers=ADMIN)
        assert response.status_code == 400
        assert response.json()["detail"]["errors"]
    assert (await client.post("/api/entry-route-flows", content="{broken", headers=ADMIN)).status_code == 400
    assert (await client.post("/api/entry-route-flows", content="x" * 300001, headers=ADMIN)).status_code == 400
    assert (await client.get("/api/entry-route-flows/not-uuid", headers=ADMIN)).status_code == 400
    assert (await client.get("/api/entry-route-flows/00000000-0000-4000-8000-000000000000", headers=ADMIN)).status_code == 404


async def test_revision_publication_activation_archive_and_dto(entry_api):
    client, sessions = entry_api
    flow = await create_flow(client, template="empty")
    assert set(flow) == {"id", "name", "draft", "draftRevision", "published", "publishedVersion",
                         "publishedRevision", "enabled", "archived", "updatedBy", "createdAt", "updatedAt"}
    assert flow["published"] is None and flow["draftRevision"] == 1
    base = f"/api/entry-route-flows/{flow['id']}"
    assert (await client.put(f"{base}/activation", json={"enabled": True}, headers=ADMIN)).status_code == 400
    assert (await client.post(f"{base}/publish", json={"revision": 99}, headers=ADMIN)).status_code == 409
    incomplete = flow["draft"]
    incomplete["edges"] = []
    save = await client.put(f"{base}/draft", json={"name": "草稿", "revision": 1, "definition": incomplete}, headers=ADMIN)
    assert save.status_code == 200, save.text
    assert save.json()["draftRevision"] == 2
    assert (await client.post(f"{base}/validate", json={"revision": 1}, headers=ADMIN)).status_code == 409
    validated = await client.post(f"{base}/validate", json={"revision": 2}, headers=ADMIN)
    assert validated.json()["valid"] is False
    assert (await client.post(f"{base}/publish", json={"revision": 2}, headers=ADMIN)).status_code == 400
    incomplete["edges"] = [{"id": "first", "source": "start", "target": "fallback", "branch": None}]
    assert (await client.put(f"{base}/draft", json={"name": "入口", "revision": 2, "definition": incomplete}, headers=ADMIN)).status_code == 200
    published = (await client.post(f"{base}/publish", json={"revision": 3}, headers=ADMIN)).json()
    assert published["publishedVersion"] == 1 and published["publishedRevision"] == 3
    assert (await client.put(f"{base}/activation", json={"enabled": True}, headers=ADMIN)).status_code == 200
    other = await enable_flow(client)
    assert (await client.get(base, headers=ADMIN)).json()["enabled"] is False
    async with sessions() as db:
        assert list(await db.scalars(select(EntryRouteFlow.id).where(EntryRouteFlow.enabled.is_(True)))) == [other["id"]]
    assert (await client.delete(f"/api/entry-route-flows/{other['id']}", headers=ADMIN)).json() == {"ok": True}
    assert len((await client.get("/api/entry-route-flows", headers=ADMIN)).json()["items"]) == 1
    assert (await client.post(f"/api/entry-route-flows/{other['id']}/publish", json={"revision": 1}, headers=ADMIN)).status_code == 404


async def test_runs_keep_frozen_versions_and_redact_draft_records(entry_api):
    client, sessions = entry_api
    flow = await enable_flow(client)
    base = f"/api/entry-route-flows/{flow['id']}"
    async with sessions() as db:
        service = EntryRouteFlowService(db)
        snapshot = await service.active_snapshot()
        execution = await service.execute(snapshot, "password=secret " + "x" * 3000, "user", conversation_id="conv")
        await service.link_assistant(execution.run_id, "assistant")
        original = await service.get_run(flow["id"], execution.run_id)
        assert original["inputSummary"].startswith("password=[REDACTED]")
        assert len(original["inputSummary"]) == 2000
        assert original["assistantMessageId"] == "assistant" and original["test"] is False
    trial = await client.post(f"{base}/test-run", json={"revision": 1, "message": "你好"}, headers=ADMIN)
    assert trial.status_code == 200, trial.text
    assert trial.json()["test"] is True and trial.json()["draftRevision"] == 1
    assert trial.json()["status"] == "completed" and trial.json()["output"]["action"] == "reply"
    await client.post(f"{base}/publish", json={"revision": 1}, headers=ADMIN)
    async with sessions() as db:
        service = EntryRouteFlowService(db)
        reused = await service.execute(snapshot, "你好", "user")
        assert reused.version == 1
        assert (await service.active_snapshot()).version == 2
    page = (await client.get(f"{base}/runs?pageSize=1", headers=ADMIN)).json()
    assert page["total"] == 3 and len(page["items"]) == 1 and page["pageSize"] == 1
    assert set(page["items"][0]) == {
        "id", "flowId", "version", "draftRevision", "snapshot", "actorId", "conversationId",
        "assistantMessageId", "test", "status", "inputSummary", "records", "output",
        "terminalNodeId", "error", "durationMs", "createdAt", "updatedAt",
    }
    other = await create_flow(client)
    assert (await client.get(f"/api/entry-route-flows/{other['id']}/runs/{execution.run_id}", headers=ADMIN)).status_code == 404
    for query in ("page=0", "pageSize=51", "page=bad", "other=1"):
        assert (await client.get(f"{base}/runs?{query}", headers=ADMIN)).status_code == 400


async def test_concurrent_save_has_one_winner(entry_api):
    client, _ = entry_api
    flow = await create_flow(client)
    base = f"/api/entry-route-flows/{flow['id']}"
    payload = {"name": "new", "revision": 1, "definition": flow["draft"]}
    responses = await asyncio.gather(*[client.put(f"{base}/draft", json=payload, headers=ADMIN) for _ in range(2)])
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert (await client.get(base, headers=ADMIN)).json()["draftRevision"] == 2


async def test_run_creation_decision_write_and_cancellation_fail_explicitly(entry_api, monkeypatch):
    client, sessions = entry_api
    flow = await enable_flow(client, template="empty")
    async with sessions() as db:
        service = EntryRouteFlowService(db)
        snapshot = await service.active_snapshot()
        original_commit = db.commit
        with monkeypatch.context() as patch:
            patch.setattr(db, "commit", AsyncMock(side_effect=RuntimeError("write unavailable")))
            with pytest.raises(EntryFlowError, match="创建失败"):
                await service.execute(snapshot, "hello", "user")
        assert list(await db.scalars(select(EntryRouteFlowRun))) == []
        count = 0

        async def fail_decision_commit():
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("password=secret")
            await original_commit()

        with monkeypatch.context() as patch:
            patch.setattr(db, "commit", fail_decision_commit)
            with pytest.raises(EntryFlowError, match="记录保存失败"):
                await service.execute(snapshot, "hello", "user")
        failed = await db.scalar(select(EntryRouteFlowRun))
        assert failed.status == "failed"
        assert failed.output is None and "secret" not in failed.error
        cancel = asyncio.Event()
        cancel.set()
        with pytest.raises(asyncio.CancelledError):
            await service.execute(snapshot, "hello", "user", cancel=cancel)
        statuses = list(await db.scalars(select(EntryRouteFlowRun.status)))
        assert sorted(statuses) == ["cancelled", "failed"]
        assert (await service.get(flow["id"]))["enabled"] is True


async def test_active_config_missing_differs_from_corrupt_or_unavailable(entry_api, monkeypatch):
    client, sessions = entry_api
    async with sessions() as db:
        assert await EntryRouteFlowService(db).active_snapshot() is None
    flow = await enable_flow(client)
    async with sessions() as db:
        row = await db.get(EntryRouteFlow, flow["id"])
        row.published = {"bad": True}
        await db.commit()
        with pytest.raises(EntryFlowError, match="加载失败"):
            await EntryRouteFlowService(db).active_snapshot()
        monkeypatch.setattr(db, "scalars", AsyncMock(side_effect=RuntimeError("database down")))
        with pytest.raises(EntryFlowError):
            await EntryRouteFlowService(db).active_snapshot()
    # Admin failures remain controlled, with no exception text in the response.
    monkeypatch.setattr(EntryRouteFlowService, "list", AsyncMock(side_effect=RuntimeError("password=secret")))
    response = await client.get("/api/entry-route-flows", headers=ADMIN)
    assert response.status_code == 503 and "secret" not in json.dumps(response.json())
