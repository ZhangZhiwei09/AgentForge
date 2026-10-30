"""SQL/HTTP administrative migration and operational dependency checks."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_db
from src.api.v1 import diagnosis, health
from src.models.base import Base
from src.models.chat import Conversation, Message, SatisfactionRating
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.rag.types import KnowledgeSearchResult

USER = {"X-Test-Actor": "user"}
ADMIN = {"X-Test-Actor": "admin"}
pytestmark = pytest.mark.usefixtures("monitoring_demo")


@pytest_asyncio.fixture
async def platform_api(entry_api):
    client, sessions = entry_api
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            SatisfactionRating.__table__, KnowledgeBase.__table__, KnowledgeDocument.__table__, KnowledgeChunk.__table__,
        ]))
    async with sessions() as db:
        db.add_all([
            Conversation(id="ours", user_id="user", session_id="own-session", title="评价"),
            Conversation(id="foreign", user_id="other", session_id="foreign-session", title="他人"),
        ])
        await db.flush()
        db.add_all([
            Message(id="question", conversation_id="ours", role="user", content="如何退款？"),
            Message(id="answer", conversation_id="ours", role="assistant", content="参考退款指引"),
            Message(id="foreign-answer", conversation_id="foreign", role="assistant", content="他人答案"),
            KnowledgeBase(id="kb", name="客服知识库"),
        ])
        await db.flush()
        db.add_all([
            KnowledgeDocument(id="faq", knowledge_base_id="kb", title="退货退款指南", content="完整指南",
                              status="completed", chunk_count=1),
            KnowledgeDocument(id="draft", knowledge_base_id="kb", title="物流草稿", content="未发布内容"),
            KnowledgeDocument(id="disabled", knowledge_base_id="kb", title="物流旧文档", content="禁用内容",
                              status="completed", enabled=False),
        ])
        await db.flush()
        db.add(KnowledgeChunk(id="faq-chunk", document_id="faq", knowledge_base_id="kb",
                              chunk_index=0, content="退款处理步骤", token_count=6))
        await db.commit()
    return client, sessions


@pytest.mark.asyncio
async def test_ratings_ownership_message_validation_and_persistence(platform_api):
    client, sessions = platform_api
    response = await client.post("/api/agent/chat/rate", headers=USER, json={
        "session_id": "own-session", "message_id": "answer", "rating": "positive", "comment": "有效",
    })
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok", "rating": "positive"}
    async with sessions() as db:
        rating = await db.scalar(select(SatisfactionRating))
        assert rating.conversation_id == "ours" and rating.message_id == "answer" and rating.comment == "有效"
    assert (await client.post("/api/agent/chat/rate", headers=USER, json={
        "session_id": "foreign", "rating": "positive",
    })).status_code == 403
    assert (await client.post("/api/agent/chat/rate", headers=USER, json={
        "session_id": "own-session", "message_id": "foreign-answer", "rating": "positive",
    })).status_code == 400
    assert (await client.post("/api/agent/chat/rate", headers=USER, json={
        "session_id": "own-session", "message_id": "question", "rating": "positive",
    })).status_code == 400


@pytest.mark.asyncio
async def test_rating_write_failure_does_not_report_success(platform_api, monkeypatch):
    client, sessions = platform_api
    with monkeypatch.context() as patch:
        patch.setattr(AsyncSession, "commit", AsyncMock(side_effect=RuntimeError("write failed")))
        with pytest.raises(RuntimeError, match="write failed"):
            await client.post("/api/agent/chat/rate", headers=USER, json={
                "session_id": "own-session", "rating": "negative",
            })
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(SatisfactionRating)) == 0


@pytest.mark.asyncio
async def test_public_faq_categories_filter_and_detail_hide_unpublished_content(platform_api):
    client, _ = platform_api
    response = await client.get("/api/agent/chat/faq")
    assert response.status_code == 200
    assert [doc["id"] for doc in response.json()["documents"]] == ["faq"]
    assert (await client.get("/api/agent/chat/faq?category=物流")).json()["documents"] == []
    categories = (await client.get("/api/agent/chat/faq/categories")).json()["categories"]
    assert categories[0] == {"name": "退货退款", "count": 1}
    assert len(categories) == 5
    assert (await client.get("/api/agent/chat/faq/faq")).json()["content"] == "退款处理步骤"
    for doc_id in ("draft", "disabled", "missing"):
        assert (await client.get(f"/api/agent/chat/faq/{doc_id}")).status_code == 404


@pytest.mark.asyncio
async def test_feedback_paging_filters_and_aggregate_counts(platform_api):
    client, _ = platform_api
    for rating in ("positive", "negative", "star_5"):
        assert (await client.post("/api/agent/chat/rate", headers=USER, json={
            "session_id": "own-session", "message_id": "answer", "rating": rating,
        })).status_code == 200
    response = await client.get("/api/agent/chat/feedback?limit=2", headers=ADMIN)
    payload = response.json()
    assert payload["pagination"] == {"page": 1, "limit": 2, "total": 3, "totalPages": 2}
    assert payload["feedback"][0]["user_message"] == "如何退款？"
    assert payload["feedback"][0]["assistant_message"] == "参考退款指引"
    negative = (await client.get("/api/agent/chat/feedback?type=negative", headers=ADMIN)).json()
    assert negative["pagination"]["total"] == 2
    analytics = (await client.get("/api/agent/chat/analytics", headers=ADMIN)).json()
    assert analytics["total_conversations"] == 2
    assert analytics["total_messages"] == 3
    assert analytics["satisfaction_rate"] == 67 and analytics["total_ratings"] == 3
    assert (await client.get("/api/agent/chat/feedback?page=0", headers=ADMIN)).status_code == 422
    assert (await client.get("/api/agent/chat/analytics", headers=USER)).status_code == 403
    assert (await client.get("/api/agent/chat/feedback", headers=USER)).status_code == 403
    assert (await client.get("/api/agent/chat/analytics")).status_code == 401
    assert (await client.get("/api/agent/chat/feedback")).status_code == 401


@pytest.mark.asyncio
async def test_tools_and_disabled_memory_contracts(platform_api):
    client, _ = platform_api
    tools = (await client.get("/api/tools", headers=USER)).json()
    assert tools["count"] >= 2
    by_name = {tool["name"]: tool for tool in tools["tools"]}
    assert by_name["query_trace_log"]["risk_level"] == "read_only"
    assert by_name["search_knowledge_base"]["require_approval"] is False
    assert (await client.get("/api/tools")).status_code == 401
    assert (await client.get("/api/memories", headers=USER)).json()["memories"] == []
    assert (await client.get("/api/memories/search?q=test", headers=USER)).json()["results"] == []
    assert (await client.delete("/api/memories/disabled", headers=USER)).status_code == 404


@pytest.mark.asyncio
async def test_readiness_checks_actual_dependencies_and_queue_requirement(platform_api, monkeypatch):
    client, _ = platform_api
    redis = SimpleNamespace(ping=AsyncMock(return_value=True), aclose=AsyncMock())
    monkeypatch.setattr(health.Redis, "from_url", lambda *args, **kwargs: redis)
    monkeypatch.setattr(health, "resolve_model", lambda model: {"provider_name": "test"})
    monkeypatch.setattr(health, "get_provider", lambda name: object())
    response = await client.get("/api/ready")
    assert response.status_code == 200
    assert response.json()["checks"] == {"db": "ok", "llm": "ok", "redis": "ok"}
    redis.aclose.assert_awaited_once()
    redis.ping.side_effect = ConnectionError("offline")
    monkeypatch.setattr(health.settings, "ingestion_async_enabled", True)
    failed = await client.get("/api/ready")
    assert failed.status_code == 503 and failed.json()["checks"]["redis"] == "error"
    monkeypatch.setattr(health.settings, "ingestion_async_enabled", False)
    degraded = await client.get("/api/ready")
    assert degraded.status_code == 200 and degraded.json()["checks"]["redis"] == "degraded"


@pytest.mark.asyncio
async def test_readiness_database_outage_returns_503(platform_api, monkeypatch):
    client, _ = platform_api
    async def broken_db():
        yield SimpleNamespace(execute=AsyncMock(side_effect=ConnectionError("offline")), rollback=AsyncMock())
    client._transport.app.dependency_overrides[get_db] = broken_db
    redis = SimpleNamespace(ping=AsyncMock(return_value=True), aclose=AsyncMock())
    monkeypatch.setattr(health.Redis, "from_url", lambda *args, **kwargs: redis)
    response = await client.get("/api/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["db"] == "error"


@pytest.mark.asyncio
async def test_prometheus_uses_route_templates_and_protects_metrics(platform_api):
    client, _ = platform_api
    await client.get("/api/agent/chat/faq/private-doc-id")
    assert (await client.get("/api/metrics")).status_code == 401
    assert (await client.get("/api/metrics", headers=USER)).status_code == 403
    response = await client.get("/api/metrics", headers=ADMIN)
    assert response.status_code == 200
    assert "http_requests_total" in response.text
    assert 'path="/api/agent/chat/faq/{document_id}"' in response.text
    assert 'path="/api/agent/chat/faq/private-doc-id"' not in response.text
    assert "text/plain" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_public_diagnosis_preflight_needs_no_provider(platform_api):
    client, _ = platform_api
    response = await client.post("/api/diagnosis/query", headers=USER, json={"query": "我的刷脸失败了"})
    assert response.status_code == 200
    assert response.json()["status"] == "needs_clarification"
    assert response.json()["missingFields"]
    assert (await client.post("/api/diagnosis/query", headers=USER, json={"query": "  "})).status_code == 422


@pytest.mark.asyncio
async def test_public_diagnosis_reuses_runtime_and_scopes_knowledge(platform_api, monkeypatch):
    client, _ = platform_api
    retrieve = AsyncMock(return_value=[KnowledgeSearchResult(
        chunk_id="chunk", doc_id="doc", doc_title="资料", content="排查依据", score=0.02,
    )])
    monkeypatch.setattr(diagnosis, "retrieval_service", lambda db: SimpleNamespace(retrieve=retrieve))
    monkeypatch.setattr(diagnosis, "resolve_model", lambda model: {"model_id": "test", "provider_name": "test"})
    calls = []

    async def runtime(context, actor_id, *, waiting, cancel, registry):
        calls.append((context, actor_id))
        assert registry.context.actor_id == actor_id
        denied = await registry.get("search_knowledge_base").execute({"query": "trace"}, "foreign")
        assert denied["status"] == "failed"
        retrieve.assert_not_awaited()
        assert (await registry.execute("db_query", {"sql": "SELECT 1"}, context.conversation_id))["status"] == "failed"
        await registry.execute("search_knowledge_base", {"query": "trace"}, context.conversation_id)
        await registry.execute("query_trace_log", {"traceId": "abc123"}, context.conversation_id)
        from src.agent.types import StreamToken
        yield StreamToken(content="已定位链路异常")

    monkeypatch.setattr(diagnosis.chat, "_stream_diagnosis", runtime)
    response = await client.post("/api/diagnosis/query", headers=USER, json={
        "query": "traceId=abc123 刷脸失败", "kbIds": ["allowed-kb"],
    })
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "single_trace_diagnosis" and payload["status"] == "diagnosed"
    assert payload["answer"] == "已定位链路异常"
    assert payload["evidence"][0]["id"] == "chunk"
    assert payload["toolResults"][0]["ok"] is True
    retrieve.assert_awaited_once_with("trace", ["allowed-kb"], 5)
    assert len(calls) == 1 and calls[0][1] == "user"


@pytest.mark.asyncio
async def test_public_diagnosis_rejects_foreign_conversation(platform_api):
    client, _ = platform_api
    response = await client.post("/api/diagnosis/query", headers=USER, json={
        "query": "traceId=abc123", "sessionId": "foreign",
    })
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_public_diagnosis_reports_runtime_failure(platform_api, monkeypatch):
    client, _ = platform_api
    monkeypatch.setattr(diagnosis, "resolve_model", lambda model: {"model_id": "test", "provider_name": "test"})

    async def failed_runtime(*args, **kwargs):
        from src.agent.types import StreamError
        yield StreamError(content="runtime unavailable")

    monkeypatch.setattr(diagnosis.chat, "_stream_diagnosis", failed_runtime)
    response = await client.post("/api/diagnosis/query", headers=USER, json={"query": "traceId=abc123"})
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert "runtime unavailable" in response.json()["warnings"]
