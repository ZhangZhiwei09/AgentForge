"""SQL/HTTP search, evaluation persistence and external ranking contracts."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update

from src.config import settings
from src.models.base import Base
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.models.knowledge_regression import (
    KnowledgeQueryLog,
    KnowledgeRegressionCase,
    KnowledgeRegressionRun,
    KnowledgeRegressionRunItem,
    KnowledgeRegressionTestSet,
)
from src.rag import ranking
from src.rag.pgvector import PgVectorKnowledgeService
from src.rag.types import HybridSearchParams, KnowledgeSearchResult
from src.services import knowledge_eval_metrics as metrics
from src.services import knowledge_index, knowledge_regression

ADMIN = {"X-Test-Actor": "admin"}
USER = {"X-Test-Actor": "user"}
TABLES = [
    KnowledgeBase.__table__, KnowledgeDocument.__table__, KnowledgeChunk.__table__,
    KnowledgeQueryLog.__table__, KnowledgeRegressionTestSet.__table__, KnowledgeRegressionCase.__table__,
    KnowledgeRegressionRun.__table__, KnowledgeRegressionRunItem.__table__,
]


@pytest_asyncio.fixture
async def retrieval_api(entry_api, monkeypatch):
    client, sessions = entry_api
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=TABLES))
    monkeypatch.setattr(settings, "pgvector_enabled", False)
    monkeypatch.setattr(settings, "elasticsearch_url", "")
    monkeypatch.setattr(settings, "reranker_base_url", "")
    async with sessions() as db:
        db.add_all([KnowledgeBase(id="kb1", name="知识库一"), KnowledgeBase(id="kb2", name="知识库二")])
        await db.flush()
        db.add_all([
            KnowledgeDocument(id="doc1", knowledge_base_id="kb1", title="超时排查", content="正文", status="completed"),
            KnowledgeDocument(id="doc2", knowledge_base_id="kb2", title="权限指引", content="正文", status="completed"),
        ])
        await db.flush()
        vector = [1.0] + [0.0] * 1023
        db.add_all([
            KnowledgeChunk(id="parent", document_id="doc1", knowledge_base_id="kb1", chunk_index=0,
                           content="完整父块上下文", token_count=8),
            KnowledgeChunk(id="chunk1", document_id="doc1", knowledge_base_id="kb1", chunk_index=1,
                           content="超时需要检查网络连接", token_count=10, embedding=vector),
            KnowledgeChunk(id="disabled", document_id="doc1", knowledge_base_id="kb1", chunk_index=2,
                           content="超时禁用秘密", token_count=8, enabled=False, embedding=vector),
            KnowledgeChunk(id="foreign", document_id="doc2", knowledge_base_id="kb2", chunk_index=0,
                           content="超时跨库内容", token_count=8, embedding=vector),
        ])
        await db.flush()
        await db.execute(update(KnowledgeChunk).where(KnowledgeChunk.id == "chunk1").values(parent_chunk_id="parent"))
        await db.commit()
    return client, sessions


@pytest.mark.asyncio
async def test_search_and_hit_testing_contracts_and_audit(retrieval_api):
    client, sessions = retrieval_api
    response = await client.post("/api/knowledge/search", headers=USER, json={"query": "超时", "kb_ids": ["kb1"]})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["total"] == 1
    result = payload["results"][0]
    assert result["chunkId"] == "chunk1"
    assert result["scoreType"] == "rrf"
    assert result["parentChunk"] == {"id": "parent", "content": "完整父块上下文"}
    response = await client.post("/api/knowledge/bases/kb1/hit-testing", headers=ADMIN, json={
        "query": "超时", "search_method": "keyword",
    })
    assert response.status_code == 200, response.text
    hit = response.json()["results"][0]
    assert hit["chunk_id"] == "chunk1"
    assert hit["document"] == {"id": "doc1", "title": "超时排查"}
    assert hit["score"] == 1
    async with sessions() as db:
        audit = await db.scalar(select(KnowledgeQueryLog))
        assert audit.results == 1 and audit.method == "keyword"
    assert (await client.post("/api/knowledge/search", json={"query": "超时"})).status_code == 401
    assert (await client.post("/api/knowledge/bases/absent/hit-testing", headers=ADMIN,
                              json={"query": "超时"})).status_code == 404
    assert (await client.post("/api/knowledge/bases/kb1/hit-testing", headers=ADMIN, json={
        "query": "超时", "score_threshold": 0.5,
    })).json()["results"] == []


@pytest.mark.asyncio
async def test_keyword_fallback_escapes_sql_wildcards_and_disabled_documents(retrieval_api):
    _, sessions = retrieval_api
    service = PgVectorKnowledgeService(sessions)
    assert await service.keyword_search("%", ["kb1"], 10) == []
    async with sessions() as db:
        await db.execute(update(KnowledgeDocument).where(KnowledgeDocument.id == "doc1").values(enabled=False))
        await db.commit()
    assert await service.keyword_search("超时", ["kb1"], 10) == []


@pytest.mark.asyncio
async def test_es_hydration_filters_foreign_disabled_and_stale_content(retrieval_api, monkeypatch):
    _, sessions = retrieval_api
    monkeypatch.setattr(settings, "elasticsearch_url", "http://elastic.test")
    request = AsyncMock(return_value={"hits": {"hits": [
        {"_source": {"chunkId": chunk_id, "content": "stale"}, "_score": 7 - index}
        for index, chunk_id in enumerate(("foreign", "disabled", "deleted", "chunk1"))
    ]}})
    monkeypatch.setattr(knowledge_index, "request_index", request)
    results = await PgVectorKnowledgeService(sessions).keyword_search("超时", ["kb1"], 10)
    assert [item.chunk_id for item in results] == ["chunk1"]
    assert results[0].content == "超时需要检查网络连接"
    assert request.await_args.args[2]["query"]["bool"]["filter"] == [{"terms": {"kbId": ["kb1"]}}]
    request.return_value = {"invalid": True}
    assert (await PgVectorKnowledgeService(sessions).keyword_search("超时", ["kb1"], 10))[0].chunk_id == "chunk1"


@pytest.mark.asyncio
async def test_postgres_dense_recall_uses_real_pgvector_and_kb_filter(retrieval_api, monkeypatch):
    _, sessions = retrieval_api
    if sessions.kw["bind"].dialect.name != "postgresql":
        pytest.skip("Real pgvector requires the isolated PostgreSQL database")
    monkeypatch.setattr(settings, "pgvector_enabled", True)
    provider = SimpleNamespace(embed=AsyncMock(return_value=[[1.0] + [0.0] * 1023]))
    service = PgVectorKnowledgeService(sessions, provider)
    results = await service.semantic_search("超时", ["kb1"], 10)
    assert [item.chunk_id for item in results] == ["chunk1"]
    assert results[0].score == 1
    fused = await service.hybrid_search(HybridSearchParams("超时", ["kb1"], 5, False))
    assert fused[0].recall_sources == ["pgvector", "elasticsearch"]
    assert fused[0].fusion_score == round(2 / 61, 4)


def test_fusion_dedupe_and_rank_score_semantics():
    first = KnowledgeSearchResult(chunk_id="a", content="网络检查", score=0.9)
    second = KnowledgeSearchResult(chunk_id="b", content="访问权限", score=0.8)
    duplicate = KnowledgeSearchResult(chunk_id="c", content="网络检查", score=0.7)
    fused = ranking.rrf_fusion([first, second], [second, duplicate], 10)
    assert fused[0].chunk_id == "b"
    assert fused[0].recall_sources == ["pgvector", "elasticsearch"]
    assert fused[0].score_type == "rrf"
    assert [item.chunk_id for item in ranking.dedupe(fused)] == ["b", "a"]


@pytest.mark.asyncio
@pytest.mark.parametrize("payload,expected", [
    ({"results": [{"index": 1, "relevance_score": 0.9}, {"index": 0, "score": 0.6}]}, ["b", "a"]),
    ({"results": [{"index": -1, "score": 0.9}]}, []),
    ({"results": [{"index": 2, "score": 0.9}]}, []),
    ({"results": [{"index": 0, "score": 0.9}, {"index": 0, "score": 0.8}]}, []),
    ({"results": [{"index": True, "score": 0.9}]}, []),
    ({"results": [{"index": 0, "score": "0.9"}]}, []),
    ({"results": "invalid"}, []),
])
async def test_reranker_wire_contract_and_invalid_outputs(monkeypatch, payload, expected):
    monkeypatch.setattr(settings, "reranker_base_url", "http://rerank.test/")
    monkeypatch.setattr(settings, "reranker_model", "bge")
    real_client = httpx.AsyncClient
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(ranking.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(respond)))
    candidates = [KnowledgeSearchResult(chunk_id=key, content="text" * 500) for key in ("a", "b")]
    results = await ranking.rerank("超时", candidates, 2)
    assert [item.chunk_id for item in results] == expected
    assert requests[0]["topK"] == 2
    assert len(requests[0]["documents"][0]["text"]) == 800
    assert all(item.score_type == "reranker" for item in results)


@pytest.mark.asyncio
async def test_regression_crud_run_history_and_metrics(retrieval_api):
    client, sessions = retrieval_api
    base = "/api/knowledge/bases/kb1/regression"
    empty = (await client.get(base + "/metrics", headers=ADMIN)).json()
    assert empty["summary"] == {"runCount": 0, "totalCases": 0, "latest": None, "average": None}
    sets = (await client.get(base + "/test-sets", headers=ADMIN)).json()
    assert len(sets) == 1 and sets[0]["cases"] == []
    assert (await client.get(base + "/test-sets", headers=ADMIN)).json()[0]["id"] == sets[0]["id"]
    response = await client.post(base + "/cases", headers=ADMIN, json={
        "name": "网络排查命中", "query": "超时", "expectedDocIds": ["DOC1"],
        "requiredText": ["网络连接"], "forbiddenText": ["禁用秘密"],
        "promptRequiredContextText": ["网络连接"], "minScore": 0.5, "expectedTopK": 5,
        "retrievalConfig": {"searchMethod": "keyword"},
    })
    assert response.status_code == 201, response.text
    case = response.json()
    assert case["retrievalConfig"]["topK"] == 10
    assert (await client.get(base + "/test-sets", headers=ADMIN)).json()[0]["cases"][0]["id"] == case["id"]
    response = await client.post(base + "/runs", headers=ADMIN, json={})
    assert response.status_code == 201, response.text
    run = response.json()
    assert run["status"] == "completed"
    assert run["totalCases"] == 1 and run["passedCases"] == 1 and run["hitRate"] == 1
    assert run["items"][0]["matchedDocId"] == "doc1"
    assert "检索上下文" in run["items"][0]["promptSnapshot"]
    history = (await client.get(base + "/runs", headers=ADMIN)).json()
    assert history[0]["id"] == run["id"]
    metrics_payload = (await client.get(base + "/metrics", headers=ADMIN)).json()
    latest = metrics_payload["summary"]["latest"]
    assert latest["mrr"] == 1 and latest["recallAtK"] == 1 and latest["precisionAtK"] == 0.2
    assert metrics_payload["queries"][0]["relevantRanks"] == [1]
    changed = {**case, "requiredText": ["不存在的内容"]}
    response = await client.put(f"/api/knowledge/regression/cases/{case['id']}", headers=ADMIN, json=changed)
    assert response.status_code == 200, response.text
    failed = (await client.post(base + "/runs", headers=ADMIN, json={})).json()
    assert failed["failedCases"] == 1
    assert "Required text missing" in failed["items"][0]["failureReason"]
    assert (await client.delete(f"/api/knowledge/regression/cases/{case['id']}", headers=ADMIN)).status_code == 200
    async with sessions() as db:
        assert list(await db.scalars(select(KnowledgeRegressionRunItem))) == []


@pytest.mark.asyncio
async def test_foreign_sets_validation_and_empty_run(retrieval_api):
    client, _ = retrieval_api
    foreign = (await client.post("/api/knowledge/bases/kb2/regression/test-sets", headers=ADMIN,
                                 json={"name": "foreign"})).json()
    base = "/api/knowledge/bases/kb1/regression"
    assert (await client.post(base + "/cases", headers=ADMIN, json={
        "name": "bad", "query": "超时", "testSetId": foreign["id"],
    })).status_code == 404
    assert (await client.post(base + "/runs", headers=ADMIN, json={"testSetId": foreign["id"]})).status_code == 404
    assert (await client.post(base + "/cases", headers=ADMIN, json={
        "name": "bad", "query": "超时", "expectedTopK": 0,
    })).status_code == 422
    run = await client.post(base + "/runs", headers=ADMIN, json={})
    assert run.status_code == 201
    assert run.json()["totalCases"] == 0
    assert run.json()["averageRank"] is None
    assert (await client.get(base + "/metrics?limit=101", headers=ADMIN)).status_code == 422


@pytest.mark.asyncio
async def test_interrupted_regression_marks_run_failed(retrieval_api, monkeypatch):
    client, sessions = retrieval_api
    base = "/api/knowledge/bases/kb1/regression"
    await client.post(base + "/cases", headers=ADMIN, json={"name": "case", "query": "超时"})
    monkeypatch.setattr(knowledge_regression, "retrieval_service",
                        lambda db: SimpleNamespace(retrieve=AsyncMock(side_effect=RuntimeError("offline"))))
    async with sessions() as db:
        with pytest.raises(RuntimeError, match="offline"):
            await knowledge_regression.KnowledgeRegressionService(db).run("kb1", None)
    async with sessions() as db:
        run = await db.scalar(select(KnowledgeRegressionRun))
        assert run.status == "failed" and run.completed_at is not None


def test_metric_binary_recall_and_fixed_k_precision():
    expectation = {"expectedDocIds": ["DOC"], "expectedDocTitles": [], "expectedTopK": 3}
    snapshot = [{"docId": "miss", "docTitle": ""}, {"docId": "doc", "docTitle": ""}]
    item = {
        "caseId": "case", "caseName": "test", "query": "test", "passed": True,
        "rank": 2, "matchedDocId": "doc", "failureReason": None, "elapsedMs": 3,
        "resultsSnapshot": snapshot,
    }
    metric = metrics.query_metric(item, expectation)
    assert metric["reciprocalRank"] == 0.5
    assert metric["precisionAtK"] == pytest.approx(1 / 3)
    assert metric["ndcgAtK"] == pytest.approx(1 / 1.584962500721156)
    assert metrics.query_metric(item, None)["relevant"] is False
