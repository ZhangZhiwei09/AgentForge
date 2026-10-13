"""Authenticated public search and retrieval debugging endpoints."""

import time
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.schemas.knowledge_retrieval import HitTestingRequest, SearchRequest
from src.services.knowledge_management import get_base
from src.services.knowledge_retrieval import audit_query, result_dto, retrieval_service

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(get_current_user)])
Db = Annotated[AsyncSession, Depends(get_db)]


@router.post("/search")
async def search(body: SearchRequest, db: Db):
    results = await retrieval_service(db).search(body.query, body.kb_ids, body.top_k)
    return {"results": [result_dto(item) for item in results], "query": body.query, "total": len(results)}


@router.post("/bases/{base_id}/hit-testing")
async def hit_testing(base_id: str, body: HitTestingRequest, db: Db):
    await get_base(db, base_id)
    started = time.perf_counter()
    results = await retrieval_service(db).retrieve(
        body.query, [base_id], body.top_k, body.search_method, body.reranking_enable, body.score_threshold,
    )
    elapsed = round((time.perf_counter() - started) * 1000)
    await audit_query(db, base_id, body.query, body.search_method, len(results), elapsed)
    payload = []
    for item in results:
        dto = {
            "chunk_id": item.chunk_id, "content": item.content, "score": item.score,
            "fusion_score": item.fusion_score, "recall_sources": item.recall_sources,
            "chunk_index": item.chunk_index, "document": {"id": item.doc_id, "title": item.doc_title},
            "parent_chunk": item.parent_chunk,
        }
        if item.rerank_score is not None:
            dto["rerank_score"] = item.rerank_score
        payload.append(dto)
    return {"query": {"content": body.query}, "results": payload, "elapsed_ms": elapsed}
