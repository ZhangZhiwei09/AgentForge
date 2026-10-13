"""SQL-backed knowledge management contracts and chunk safety regression."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select

from src.config import settings
from src.models.base import Base
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.rag.splitter import RecursiveTokenTextSplitter, estimate_tokens
from src.services import knowledge_index, knowledge_management

USER = {"X-Test-Actor": "user"}


@pytest_asyncio.fixture
async def knowledge_api(entry_api, monkeypatch):
    client, sessions = entry_api
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            KnowledgeBase.__table__, KnowledgeDocument.__table__, KnowledgeChunk.__table__,
        ]))
    monkeypatch.setattr(settings, "elasticsearch_url", "")
    monkeypatch.setattr(knowledge_management, "get_embedding_provider", lambda: None)
    yield client, sessions


async def create_base(client, **kwargs):
    response = await client.post("/api/knowledge/bases", headers=USER, json={"name": "核身知识", **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


async def seed_document(sessions, kb_id, *, doc_id="doc", enabled=True):
    async with sessions() as db:
        db.add(KnowledgeDocument(
            id=doc_id, knowledge_base_id=kb_id, title="人脸超时", content="排查网络", status="completed",
            chunk_count=2, enabled=enabled, processing_detail='{"phase":"completed"}',
            normalizing_completed_at=datetime.now(UTC), chunking_completed_at=datetime.now(UTC),
            embedding_completed_at=datetime.now(UTC),
        ))
        await db.flush()
        db.add(KnowledgeChunk(
            id=f"{doc_id}-parent", document_id=doc_id, knowledge_base_id=kb_id,
            chunk_index=0, content="父上下文", token_count=6,
        ))
        await db.flush()
        db.add(KnowledgeChunk(
            id=f"{doc_id}-child", document_id=doc_id, knowledge_base_id=kb_id,
            chunk_index=1, content="检查网络", token_count=6, parent_chunk_id=f"{doc_id}-parent",
            embedding=[0.1] * 1024,
        ))
        await db.commit()


@pytest.mark.asyncio
async def test_base_crud_preserves_snake_case_and_counts(knowledge_api):
    client, sessions = knowledge_api
    base = await create_base(client, chunk_size_tokens=200, chunk_overlap_tokens=20,
                             separator_mode="custom", custom_separator="\\n## ",
                             remove_urls_emails=True)
    assert base["document_count"] == 0
    assert base["separator_mode"] == "custom"
    assert base["remove_extra_spaces"] is True
    await seed_document(sessions, base["id"])
    detail = (await client.get(f"/api/knowledge/bases/{base['id']}", headers=USER)).json()
    assert detail["document_count"] == 1
    listing = (await client.get("/api/knowledge/bases", headers=USER)).json()
    assert listing == [detail]
    response = await client.put(f"/api/knowledge/bases/{base['id']}", headers=USER, json={
        "name": "更新知识", "enabled": False, "description": None,
    })
    assert response.status_code == 200
    assert response.json()["name"] == "更新知识"
    assert response.json()["enabled"] is False
    assert (await client.delete(f"/api/knowledge/bases/{base['id']}", headers=USER)).json() == {"status": "deleted"}
    async with sessions() as db:
        for model in (KnowledgeBase, KnowledgeDocument, KnowledgeChunk):
            assert await db.scalar(select(func.count()).select_from(model)) == 0
    assert (await client.get(f"/api/knowledge/bases/{base['id']}", headers=USER)).status_code == 404


@pytest.mark.asyncio
async def test_update_validates_settings_merged_with_persisted_values(knowledge_api):
    client, _ = knowledge_api
    base = await create_base(client, chunk_size_tokens=400, chunk_overlap_tokens=100)
    url = f"/api/knowledge/bases/{base['id']}"
    assert (await client.put(url, headers=USER, json={"chunk_size_tokens": 150})).status_code == 422
    assert (await client.put(url, headers=USER, json={"separator_mode": "custom"})).status_code == 422
    saved = (await client.get(url, headers=USER)).json()
    assert saved["chunk_size_tokens"] == 400
    assert saved["separator_mode"] == "auto"
    update = await client.put(url, headers=USER, json={
        "chunk_size_tokens": 150, "chunk_overlap_tokens": 0,
        "separator_mode": "custom", "custom_separator": "###",
    })
    assert update.status_code == 200
    assert update.json()["chunk_overlap_tokens"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [
    {"chunk_size_tokens": 49}, {"chunk_size_tokens": 200, "chunk_overlap_tokens": 100},
    {"separator_mode": "custom"},
    {"chunk_structure": "hierarchical", "child_chunk_size_tokens": 100, "child_chunk_overlap_tokens": 50},
    {"name": ""}, {"remove_urls_emails": None},
])
async def test_invalid_base_config_does_not_write(knowledge_api, data):
    client, sessions = knowledge_api
    response = await client.post("/api/knowledge/bases", headers=USER, json={"name": "知识", **data})
    assert response.status_code == 422
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(KnowledgeBase)) == 0


@pytest.mark.asyncio
async def test_document_and_chunk_dtos_preserve_stage_timestamps(knowledge_api):
    client, sessions = knowledge_api
    base = await create_base(client)
    await seed_document(sessions, base["id"])
    listing = (await client.get(f"/api/knowledge/bases/{base['id']}/documents", headers=USER)).json()
    assert "content" not in listing[0]
    assert listing[0]["knowledgeBaseId"] == base["id"]
    assert listing[0]["processingDetail"] == {"phase": "completed"}
    for field in ("normalizingCompletedAt", "chunkingCompletedAt", "embeddingCompletedAt"):
        assert listing[0][field]
    detail = (await client.get("/api/knowledge/documents/doc", headers=USER)).json()
    assert detail["content"] == "排查网络"
    chunks = (await client.get("/api/knowledge/documents/doc/chunks", headers=USER)).json()
    assert [chunk["chunkIndex"] for chunk in chunks] == [0, 1]
    assert chunks[1]["parentChunkId"] == "doc-parent"
    assert "embedding" not in chunks[1]
    async with sessions() as db:
        document = await db.get(KnowledgeDocument, "doc")
        document.processing_detail = "legacy invalid JSON"
        await db.commit()
    assert (await client.get("/api/knowledge/documents/doc", headers=USER)).json()["processingDetail"] == "legacy invalid JSON"
    assert (await client.get("/api/knowledge/documents/absent", headers=USER)).status_code == 404
    assert (await client.get("/api/knowledge/documents/absent/chunks", headers=USER)).json() == []


@pytest.mark.asyncio
async def test_document_delete_keeps_other_document_and_syncs_index(knowledge_api, monkeypatch):
    client, sessions = knowledge_api
    base = await create_base(client)
    await seed_document(sessions, base["id"], doc_id="a")
    await seed_document(sessions, base["id"], doc_id="b")
    remove_index = AsyncMock()
    monkeypatch.setattr(knowledge_index, "remove_documents", remove_index)
    response = await client.delete("/api/knowledge/documents/a", headers=USER)
    assert response.json() == {"status": "deleted"}
    remove_index.assert_awaited_once_with(["a"])
    async with sessions() as db:
        assert await db.get(KnowledgeDocument, "a") is None
        assert await db.get(KnowledgeDocument, "b") is not None
        assert await db.scalar(select(func.count()).select_from(KnowledgeChunk)) == 2
    assert (await client.delete("/api/knowledge/documents/a", headers=USER)).status_code == 404


@pytest.mark.asyncio
async def test_chunk_edit_replaces_vector_and_refreshes_index(knowledge_api, monkeypatch):
    client, sessions = knowledge_api
    base = await create_base(client)
    await seed_document(sessions, base["id"])
    embed = AsyncMock(return_value=[[0.5] * 1024])
    monkeypatch.setattr(knowledge_management, "get_embedding_provider", lambda: SimpleNamespace(embed=embed))
    index = AsyncMock()
    monkeypatch.setattr(knowledge_index, "update_chunk", index)
    response = await client.put("/api/knowledge/chunks/doc-child", headers=USER, json={"content": "  重新检查网络  "})
    assert response.status_code == 200, response.text
    assert response.json()["content"] == "重新检查网络"
    embed.assert_awaited_once_with(["重新检查网络"])
    assert index.await_args.args[0]["title"] == "人脸超时"
    assert index.await_args.args[0]["content"] == "重新检查网络"
    async with sessions() as db:
        chunk = await db.get(KnowledgeChunk, "doc-child")
        assert list(chunk.embedding) == [0.5] * 1024
        assert chunk.token_count == estimate_tokens("重新检查网络")


@pytest.mark.asyncio
@pytest.mark.parametrize("vectors", [None, [], [[0.5] * 2], [[float("nan")] * 1024]])
async def test_failed_embedding_leaves_chunk_untouched(knowledge_api, monkeypatch, vectors):
    client, sessions = knowledge_api
    base = await create_base(client)
    await seed_document(sessions, base["id"])
    monkeypatch.setattr(knowledge_management, "get_embedding_provider",
                        lambda: None if vectors is None else SimpleNamespace(embed=AsyncMock(return_value=vectors)))
    response = await client.put("/api/knowledge/chunks/doc-child", headers=USER, json={"content": "new"})
    assert response.status_code == 503
    async with sessions() as db:
        chunk = await db.get(KnowledgeChunk, "doc-child")
        assert chunk.content == "检查网络"
        assert abs(float(chunk.embedding[0]) - 0.1) < 1e-6


@pytest.mark.asyncio
async def test_preview_supports_fixed_separators_and_hierarchy_without_writes(knowledge_api):
    client, sessions = knowledge_api
    response = await client.post("/api/knowledge/chunk-preview", headers=USER, json={
        "text": "第一段\\n## 第二段".replace("\\n", "\n"),
        "separator_mode": "custom", "custom_separator": "\\n## ", "chunk_overlap_tokens": 0,
    })
    assert response.status_code == 200
    assert [chunk["content"] for chunk in response.json()["preview"]] == ["第一段", "第二段"]
    response = await client.post("/api/knowledge/chunk-preview", headers=USER, json={
        "text": "测试段落。" * 80, "chunk_structure": "hierarchical", "chunk_size_tokens": 200,
        "chunk_overlap_tokens": 0, "child_chunk_size_tokens": 50, "child_chunk_overlap_tokens": 0,
    })
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["total_parents"] > 1
    assert preview["total_children"] > preview["total_parents"]
    assert all(child["token_count"] <= 50 for parent in preview["preview"] for child in parent["children"])
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(KnowledgeDocument)) == 0


@pytest.mark.asyncio
async def test_stats_include_pgvector_and_index_counts(knowledge_api):
    client, sessions = knowledge_api
    base = await create_base(client)
    await seed_document(sessions, base["id"])
    response = await client.get("/api/knowledge/stats", headers=USER)
    assert response.status_code == 200
    result = response.json()
    assert result["knowledge_bases"] == 1
    assert result["documents"] == 1
    assert result["chunks"] == 2
    assert result["retrieval"]["chunksWithEmbedding"] == 1
    assert result["retrieval"]["elasticsearchAvailable"] is False


@pytest.mark.asyncio
async def test_knowledge_paths_require_auth(knowledge_api):
    client, _ = knowledge_api
    for path in ("/api/knowledge/bases", "/api/knowledge/stats", "/api/knowledge/documents/id",
                 "/api/knowledge/bases/id/documents", "/api/knowledge/documents/id/chunks"):
        assert (await client.get(path)).status_code == 401
    assert (await client.post("/api/knowledge/ingest", json={
        "kb_id": "id", "title": "title", "content": "content",
    })).status_code == 401
    assert (await client.post("/api/knowledge/chunk-preview", json={"text": "text"})).status_code == 401


def test_splitter_honors_zero_overlap_and_keeps_token_limits():
    text = "甲乙丙丁戊己庚辛壬癸。" * 20
    splitter = RecursiveTokenTextSplitter(50, 0)
    chunks = splitter.split_text(text)
    assert "".join(chunks) == text
    assert all(estimate_tokens(chunk) <= 50 for chunk in chunks)
    assert len(RecursiveTokenTextSplitter(50, 10).split_text(text)) >= len(chunks)
    with pytest.raises(ValueError):
        RecursiveTokenTextSplitter(50, 50)


@pytest.mark.asyncio
async def test_index_sync_uses_existing_index_and_handles_outages(monkeypatch, caplog):
    requests = []

    async def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"count": 3})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(settings, "elasticsearch_url", "http://index.test")
    monkeypatch.setattr(knowledge_index.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(handle),
    ))
    await knowledge_index.update_chunk({"chunkId": "chunk", "content": "new"})
    await knowledge_index.remove_documents(["doc"])
    assert requests[1].url.path == "/knowledge_chunks/_doc/chunk"
    assert json.loads(requests[2].content)["query"]["terms"]["docId"] == ["doc"]
    assert await knowledge_index.index_stats() == (True, 3)

    async def unavailable(request):
        raise httpx.ConnectError("offline", request=request)

    monkeypatch.setattr(knowledge_index.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(unavailable),
    ))
    assert await knowledge_index.index_stats() == (False, 0)
    assert "Elasticsearch synchronization unavailable" in caplog.text


@pytest.mark.asyncio
async def test_fresh_index_uses_keyword_ids_for_document_cleanup(monkeypatch):
    requests = []

    async def handle(request):
        requests.append(request)
        return httpx.Response(404 if request.method == "HEAD" else 200, json={"acknowledged": True})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(settings, "elasticsearch_url", "http://index.test")
    monkeypatch.setattr(knowledge_index.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(handle),
    ))
    await knowledge_index.update_chunk({"chunkId": "chunk", "content": "new"})
    mapping = json.loads(requests[1].content)
    assert mapping["mappings"]["properties"]["docId"]["type"] == "keyword"
    assert requests[2].url.path == "/knowledge_chunks/_doc/chunk"
