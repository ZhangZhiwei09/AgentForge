"""Files, HTTP boundaries, SQL read-only enforcement and tool failure isolation."""

import asyncio
import json
import os
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker

from src.agent.tools.builtins import operational
from src.agent.tools.registry import ToolRegistry
from src.config import settings
from src.database import upgrade_connection
from src.models.support_ticket import SupportTicket
from src.rate_limit import RateLimitMiddleware
from src.services.execution_policy import ToolExecutionContext, build_execution_policy


def bound_registry():
    return ToolRegistry().bind(ToolExecutionContext(
        actor_id="test", conversation_id="run", run_id="test-run", policy=build_execution_policy(),
    ))


@pytest.mark.asyncio
async def test_math_time_validation_and_unsupported_expressions():
    registry = bound_registry()
    for expression, expected in (("sqrt(144) + 2 ** 3", "20"), ("pow(2, 10)", "1024"), ("PI * 2", "6.28318530718")):
        response = await registry.execute("calculator", {"expression": expression}, "run")
        assert response["status"] == "success" and response["output"] == expected
    for expression in ("__import__('os')", "(1).__class__", "10 ** 9000000", "1 / 0", "'a' * 999999999"):
        assert (await registry.execute("calculator", {"expression": expression}, "run"))["status"] == "failed"
    assert (await registry.execute("get_current_time", {"timezone": "Asia/Shanghai"}, "run"))["status"] == "success"
    assert (await registry.execute("get_current_time", {"timezone": "invalid"}, "run"))["status"] == "partial"
    assert (await registry.execute("file_write", {"path": "a", "content": {}}, "run"))["status"] == "failed"


@pytest.mark.asyncio
async def test_workspace_file_operations_and_escape_rejection(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(settings, "file_workspace", str(workspace))
    registry = ToolRegistry()
    assert registry.get("file_write").require_approval
    assert registry.get("http_request").require_approval
    assert registry.get("create_support_ticket").require_approval
    # Test disabled adapters directly; the execution-policy suite checks they stay inaccessible.
    written = await operational.file_write(operational.WriteInput(path="nested/file.txt", content="hello\nworld\nlast"), "run")
    assert written["status"] == "success"
    read = await operational.file_read(operational.ReadInput(path="nested/file.txt", max_lines=2), "run")
    assert read["status"] == "partial" and read["output"] == "hello\nworld\n"
    search = await operational.file_search(operational.FileSearchInput(pattern="**/*.txt", contains="world"), "run")
    assert json.loads(search["output"])["matches"] == ["nested/file.txt"]
    for path in ("../escape.txt", str(tmp_path / "outside.txt")):
        with pytest.raises(ValueError):
            await operational.file_write(operational.WriteInput(path=path, content="blocked"), "run")
    assert not (tmp_path / "escape.txt").exists()
    assert not (tmp_path / "outside.txt").exists()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (workspace / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        return  # Windows without symlink privileges still runs the traversal cases.
    with pytest.raises(ValueError):
        await operational.file_write(operational.WriteInput(path="linked/escape.txt", content="blocked"), "run")
    assert not (outside / "escape.txt").exists()


@pytest.mark.asyncio
async def test_network_tools_validate_inputs_bound_response_and_preserve_post(monkeypatch):
    calls = []
    factory = httpx.AsyncClient

    def wire(request):
        calls.append(request)
        return httpx.Response(200, text="x" * 100000, headers={"content-type": "text/plain"})

    monkeypatch.setattr(operational.httpx, "AsyncClient", lambda **kwargs: factory(
        transport=httpx.MockTransport(wire), **kwargs,
    ))
    response = await operational.http_request(operational.RequestInput(
        url="https://example.test/api", method="post", body='{"hello":1}', headers={"X-Test": "yes"},
    ), "run")
    assert response["status"] == "partial"
    assert len(json.loads(response["output"])["body"]) == 5000
    assert calls[0].method == "POST" and calls[0].content == b'{"hello":1}'
    assert calls[0].headers["x-test"] == "yes"
    fetched = await operational.web_fetch(operational.FetchInput(url="https://example.test", max_chars=20), "run")
    assert fetched["status"] == "partial" and len(json.loads(fetched["output"])["content"]) == 20
    with pytest.raises(ValidationError):
        operational.FetchInput(url="file:///etc/passwd")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_web_search_unconfigured_is_explicit_and_wire_dto_validated(monkeypatch):
    monkeypatch.setattr(settings, "tavily_api_key", "")
    unavailable = await operational.web_search(operational.SearchInput(query="q"), "run")
    assert unavailable["status"] == "partial" and json.loads(unavailable["output"])["results"] == []
    factory = httpx.AsyncClient
    monkeypatch.setattr(settings, "tavily_api_key", "test-key")

    def wire(request):
        assert request.headers["authorization"] == "Bearer test-key"
        assert json.loads(request.content)["query"] == "q"
        return httpx.Response(200, json={"answer": "evidence", "results": [{
            "title": "source", "url": "https://example.test", "content": "text" * 100, "score": 0.9,
        }]})

    monkeypatch.setattr(operational.httpx, "AsyncClient", lambda **kwargs: factory(
        transport=httpx.MockTransport(wire), **kwargs,
    ))
    found = await operational.web_search(operational.SearchInput(query="q"), "run")
    assert found["status"] == "success"
    assert len(json.loads(found["output"])["results"][0]["snippet"]) == 300


@pytest.mark.parametrize("query", [
    "DELETE FROM users", "SELECT 1; DELETE FROM users", "SELECT * INTO stolen FROM users",
    "WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted", "SELECT * FROM users FOR UPDATE",
])
def test_sql_parser_rejects_writes_multiple_statements_and_locks(query):
    with pytest.raises(ValueError):
        operational.select_query(query)


@pytest.mark.asyncio
async def test_postgres_tools_enforce_readonly_limit_and_persist_ticket(empty_postgres, monkeypatch):
    engine, _ = empty_postgres
    async with engine.begin() as connection:
        await connection.run_sync(upgrade_connection)
        await connection.execute(text("CREATE TABLE tool_probe (id integer)"))
        await connection.execute(text("""
            CREATE FUNCTION sneaky_write() RETURNS integer LANGUAGE plpgsql AS $$
            BEGIN INSERT INTO tool_probe VALUES (1); RETURN 1; END $$
        """))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr("src.db.async_session", sessions)
    query = await operational.db_query(operational.SqlInput(query="SELECT generate_series(1, 1000) AS n"), "run")
    assert query["status"] == "partial"
    rows = json.loads(query["output"])
    assert len(rows["rows"]) == 100 and rows["truncated"]
    with pytest.raises(DBAPIError):
        await operational.db_query(operational.SqlInput(query="SELECT sneaky_write()"), "run")
    ticket = await operational.create_ticket(operational.TicketInput(summary="follow up", priority="urgent"), "run")
    assert ticket["status"] == "success"
    async with sessions() as db:
        stored = await db.scalar(select(SupportTicket))
        assert stored.ticket_id == json.loads(ticket["output"])["ticket_id"]
        assert stored.priority == "urgent" and stored.summary == "follow up"
        assert await db.scalar(text("SELECT COUNT(*) FROM tool_probe")) == 0


@pytest.mark.asyncio
async def test_registry_breaker_shared_with_filters_and_single_recovery_probe():
    registry = bound_registry()
    execute = AsyncMock(return_value={"status": "failed", "error": "provider down"})
    tool = replace(registry.get("calculator"), execute=execute)
    registry.register(tool)
    try:
        filtered = registry.filter(["calculator"])
        for _ in range(5):
            await filtered.execute("calculator", {"expression": "1"}, "run")
        denied = await registry.execute("calculator", {"expression": "1"}, "run")
        assert "circuit is open" in denied["error"] and execute.await_count == 5
        registry._circuits["calculator"].opened_at -= 61
        entered = asyncio.Event()
        release = asyncio.Event()

        async def probe(args, run_id):
            entered.set()
            await release.wait()
            return {"status": "success", "output": "1"}

        tool.execute = probe
        first = asyncio.create_task(filtered.execute("calculator", {}, "run"))
        await entered.wait()
        assert "circuit is open" in (await registry.execute("calculator", {}, "run"))["error"]
        release.set()
        assert (await first)["status"] == "success"
        assert registry._circuits["calculator"].failures == 0
    finally:
        tool.execute = execute


@pytest.mark.asyncio
async def test_http_limits_use_peer_ip_and_do_not_buffer_stream(monkeypatch):
    from starlette.responses import StreamingResponse

    monkeypatch.setattr(settings, "rate_limit_max", 2)
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware)

    @app.get("/stream")
    async def stream():
        async def events():
            yield "data: first\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        first = await client.get("/stream")
        assert first.status_code == 200 and "data: [DONE]" in first.text
        assert first.headers["x-ratelimit-remaining"] == "1"
        assert (await client.get("/stream")).status_code == 200
        third = await client.get("/stream", headers={"X-Forwarded-For": "spoofed"})
        assert third.status_code == 429 and int(third.headers["retry-after"]) > 0
        assert (await client.get("/api/health")).status_code == 200


@pytest.mark.asyncio
async def test_redis_http_limits_share_quota_across_app_instances(monkeypatch):
    from limits import RateLimitItemPerMinute
    from limits.aio.storage import RedisStorage
    from limits.aio.strategies import MovingWindowRateLimiter

    url = os.environ.get("AGENTFORGE_TEST_REDIS_URL")
    if not url:
        pytest.skip("Set AGENTFORGE_TEST_REDIS_URL for shared HTTP quota checks")
    import uuid

    item = RateLimitItemPerMinute(2, namespace=f"agentforge-test-{uuid.uuid4().hex}")
    first = MovingWindowRateLimiter(RedisStorage(f"async+{url}", implementation="redispy"))
    second = MovingWindowRateLimiter(RedisStorage(f"async+{url}", implementation="redispy"))
    assert await first.hit(item, "peer")
    assert await second.hit(item, "peer")
    assert not await first.hit(item, "peer")
    await first.clear(item, "peer")
    await first.storage.bridge.storage.aclose()
    await second.storage.bridge.storage.aclose()


@pytest.mark.asyncio
async def test_redis_limit_outage_falls_back_to_local_window(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_max", 1)
    monkeypatch.setattr(settings, "rate_limit_redis_enabled", True)
    app = FastAPI()

    @app.get("/probe")
    async def probe():
        return {"ok": True}

    middleware = RateLimitMiddleware(app)
    middleware.redis.hit = AsyncMock(side_effect=ConnectionError("offline"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(middleware), base_url="http://test") as client:
        assert (await client.get("/probe")).status_code == 200
        assert (await client.get("/probe")).status_code == 429
    middleware.redis.hit.assert_awaited_once()
    await middleware.redis.storage.bridge.storage.aclose()
