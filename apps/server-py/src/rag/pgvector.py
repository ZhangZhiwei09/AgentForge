"""Shared dense/keyword retrieval, rank fusion, reranking and parent context."""

import asyncio
import logging
import math
import re
from dataclasses import replace

from sqlalchemy import case, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from src.config import settings
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.rag import ranking
from src.rag.embeddings import (
    EmbeddingProvider,
    get_embedding_provider,
    validate_embeddings,
)
from src.rag.types import HybridSearchParams, KnowledgeSearchResult
from src.services import knowledge_index

logger = logging.getLogger(__name__)


class PgVectorKnowledgeService:
    def __init__(self, session_factory, embedding_provider: EmbeddingProvider | None = None):
        self._session_factory = session_factory
        self._embedding_provider = embedding_provider

    @property
    def embedding_provider(self) -> EmbeddingProvider | None:
        if self._embedding_provider is None:
            self._embedding_provider = get_embedding_provider()
        return self._embedding_provider

    def statement(self, kb_ids: list[str] | None):
        child = aliased(KnowledgeChunk)
        statement = select(
            KnowledgeChunk.id.label("chunk_id"), KnowledgeChunk.document_id.label("doc_id"),
            KnowledgeChunk.knowledge_base_id.label("kb_id"), KnowledgeChunk.content,
            KnowledgeChunk.chunk_index, KnowledgeDocument.title.label("doc_title"),
        ).join(KnowledgeDocument, KnowledgeDocument.id == KnowledgeChunk.document_id).join(
            KnowledgeBase, KnowledgeBase.id == KnowledgeChunk.knowledge_base_id,
        ).where(
            KnowledgeChunk.enabled.is_(True), KnowledgeDocument.enabled.is_(True), KnowledgeBase.enabled.is_(True),
            ~select(child.id).where(child.parent_chunk_id == KnowledgeChunk.id).exists(),
        )
        if kb_ids:
            statement = statement.where(KnowledgeChunk.knowledge_base_id.in_(kb_ids))
        return statement

    @staticmethod
    def result(row, score: float, source: str) -> KnowledgeSearchResult:
        return KnowledgeSearchResult(
            chunk_id=row.chunk_id, doc_id=row.doc_id, kb_id=row.kb_id, content=row.content,
            chunk_index=row.chunk_index, doc_title=row.doc_title or "", score=score,
            source_score=score, fusion_score=score, recall_sources=[source],
        )

    async def search(self, query: str, kb_ids: list[str] | None = None, top_k: int = 5):
        return await self.hybrid_search(HybridSearchParams(query, kb_ids, top_k, use_reranker=False))

    async def semantic_search(self, query: str, kb_ids: list[str] | None, top_k: int):
        if not settings.pgvector_enabled or self._session_factory is None or not query.strip():
            return []
        try:
            provider = self.embedding_provider
            if provider is None:
                return []
            vectors = await provider.embed([query])
            validate_embeddings(vectors, 1)
            async with self._session_factory() as session:
                return await self._vector_search(session, vectors[0], kb_ids, top_k)
        except Exception:
            logger.exception("Dense knowledge recall unavailable")
            return []

    async def _vector_search(
        self, session: AsyncSession, query_embedding: list[float], kb_ids: list[str] | None, top_k: int,
    ):
        validate_embeddings([query_embedding], 1)
        distance = KnowledgeChunk.embedding.cosine_distance(query_embedding)
        statement = self.statement(kb_ids).add_columns((1 - distance).label("score")).where(
            KnowledgeChunk.embedding.is_not(None),
        ).order_by(distance, KnowledgeChunk.id).limit(top_k)
        rows = (await session.execute(statement)).all()
        return [self.result(row, round(float(row.score), 4), "pgvector")
                for row in rows if row.score is not None and math.isfinite(row.score)]

    async def keyword_search(self, query: str, kb_ids: list[str] | None, top_k: int):
        if not query.strip() or self._session_factory is None:
            return []
        try:
            if settings.elasticsearch_url:
                filters = [{"terms": {"kbId": kb_ids}}] if kb_ids else []
                payload = await knowledge_index.request_index("POST", f"{knowledge_index.INDEX}/_search", {
                    "query": {"bool": {
                        "must": [{"match": {"content": {"query": query, "operator": "or", "fuzziness": "AUTO"}}}],
                        "filter": filters,
                    }},
                    "size": top_k, "_source": ["chunkId"],
                })
                if payload is not None:
                    return await self._hydrate_keyword_hits(payload, kb_ids, top_k)
            return await self._sql_keyword_search(query, kb_ids, top_k)
        except Exception:
            logger.exception("Keyword index recall unavailable; using SQL fallback")
            try:
                return await self._sql_keyword_search(query, kb_ids, top_k)
            except Exception:
                logger.exception("SQL keyword recall unavailable")
                return []

    async def _hydrate_keyword_hits(self, payload: dict, kb_ids: list[str] | None, top_k: int):
        hits = payload.get("hits")
        if not isinstance(hits, dict) or not isinstance(hits.get("hits"), list):
            raise TypeError("Invalid Elasticsearch hits")
        scores = {}
        for item in hits["hits"][:top_k]:
            if not isinstance(item, dict) or not isinstance(item.get("_source"), dict):
                raise TypeError("Invalid Elasticsearch item")
            chunk_id, score = item["_source"].get("chunkId"), item.get("_score", 0)
            if not isinstance(chunk_id, str) or type(score) not in (int, float) or not math.isfinite(score):
                raise ValueError("Invalid Elasticsearch score")
            scores.setdefault(chunk_id, score)
        if not scores:
            return []
        async with self._session_factory() as session:
            rows = (await session.execute(
                self.statement(kb_ids).where(KnowledgeChunk.id.in_(scores)),
            )).all()
        by_id = {row.chunk_id: row for row in rows}
        return [self.result(by_id[chunk_id], score, "elasticsearch")
                for chunk_id, score in scores.items() if chunk_id in by_id]

    async def _sql_keyword_search(self, query: str, kb_ids: list[str] | None, top_k: int):
        terms = re.split(r"\s+", query.strip())[:8]
        conditions = [
            or_(KnowledgeChunk.content.icontains(term, autoescape=True),
                KnowledgeDocument.title.icontains(term, autoescape=True))
            for term in terms if term
        ]
        if not conditions:
            return []
        score = sum(case((condition, 1), else_=0) for condition in conditions)
        async with self._session_factory() as session:
            rows = (await session.execute(self.statement(kb_ids).add_columns(score.label("score")).where(
                or_(*conditions),
            ).order_by(score.desc(), KnowledgeChunk.created_at.desc(), KnowledgeChunk.id).limit(top_k))).all()
        return [self.result(row, row.score / len(conditions), "elasticsearch") for row in rows]

    async def hybrid_search(self, params: HybridSearchParams):
        if not params.query.strip() or self._session_factory is None or params.top_k < 1:
            return []
        top_k = min(params.top_k, 100)
        dense, sparse = await asyncio.gather(
            self.semantic_search(params.query, params.kb_ids, top_k * 5),
            self.keyword_search(params.query, params.kb_ids, top_k * 5),
        )
        candidates = ranking.dedupe(ranking.rrf_fusion(dense, sparse, top_k * 3))
        reranked = await ranking.rerank(params.query, candidates, top_k) if params.use_reranker else []
        return await self.enrich_parents(reranked or candidates[:top_k], params.kb_ids)

    async def retrieve(
        self, query: str, kb_ids: list[str] | None, top_k: int, method: str = "hybrid",
        use_reranker: bool = True, threshold: float = 0,
    ):
        if method == "semantic":
            results = await self.semantic_search(query, kb_ids, top_k)
        elif method == "keyword":
            results = await self.keyword_search(query, kb_ids, top_k)
        else:
            results = await self.hybrid_search(HybridSearchParams(query, kb_ids, top_k, use_reranker))
        return [item for item in results if item.score >= threshold] if threshold > 0 else results

    async def enrich_parents(self, results: list[KnowledgeSearchResult], kb_ids: list[str] | None):
        if not results:
            return results
        parent = aliased(KnowledgeChunk)
        async with self._session_factory() as session:
            statement = select(KnowledgeChunk.id, parent.id, parent.content).join(
                parent, parent.id == KnowledgeChunk.parent_chunk_id,
            ).where(
                KnowledgeChunk.id.in_([item.chunk_id for item in results]),
                parent.document_id == KnowledgeChunk.document_id,
                parent.knowledge_base_id == KnowledgeChunk.knowledge_base_id, parent.enabled.is_(True),
            )
            if kb_ids:
                statement = statement.where(parent.knowledge_base_id.in_(kb_ids))
            rows = (await session.execute(statement)).all()
        parents = {child_id: {"id": parent_id, "content": content} for child_id, parent_id, content in rows}
        return [replace(item, parent_chunk=parents.get(item.chunk_id)) for item in results]


_knowledge_service: PgVectorKnowledgeService | None = None


def get_knowledge_service(session_factory=None) -> PgVectorKnowledgeService:
    global _knowledge_service
    if _knowledge_service is None:
        if session_factory is None:
            from src.db import async_session

            session_factory = async_session
        _knowledge_service = PgVectorKnowledgeService(session_factory)
    return _knowledge_service
