"""API adapters around the shared knowledge service."""

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.models.knowledge_regression import KnowledgeQueryLog
from src.rag.pgvector import PgVectorKnowledgeService
from src.rag.types import KnowledgeSearchResult

logger = logging.getLogger(__name__)


def retrieval_service(db: AsyncSession) -> PgVectorKnowledgeService:
    return PgVectorKnowledgeService(async_sessionmaker(db.bind, expire_on_commit=False))


def result_dto(item: KnowledgeSearchResult) -> dict:
    result = {
        "chunkId": item.chunk_id, "docId": item.doc_id, "kbId": item.kb_id,
        "content": item.content, "score": item.score, "chunkIndex": item.chunk_index,
        "docTitle": item.doc_title, "recallSources": item.recall_sources,
    }
    for key, value in (
        ("scoreType", item.score_type), ("sourceScore", item.source_score),
        ("fusionScore", item.fusion_score), ("rerankScore", item.rerank_score),
        ("parentChunk", item.parent_chunk),
    ):
        if value is not None:
            result[key] = value
    return result


async def audit_query(
    db: AsyncSession, kb_id: str, query: str, method: str, count: int, elapsed_ms: int,
) -> None:
    try:
        db.add(KnowledgeQueryLog(
            id=str(uuid.uuid4()), kb_id=kb_id, query=query, method=method, results=count,
            source="hit_testing", elapsed_ms=elapsed_ms,
        ))
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception("Knowledge query audit write failed")
