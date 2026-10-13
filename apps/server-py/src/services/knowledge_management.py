"""Knowledge resource serialization, validated edits and transactional deletion."""

import json
import logging
import math
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from src.config import settings
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.rag.embeddings import get_embedding_provider
from src.rag.splitter import RecursiveTokenTextSplitter, estimate_tokens
from src.schemas.knowledge import ChunkSettings
from src.services import knowledge_index

logger = logging.getLogger(__name__)

BASE_FIELDS = (
    "id", "name", "description", "enabled", "chunk_size_tokens", "chunk_overlap_tokens",
    "separator_mode", "custom_separator", "chunk_structure", "child_chunk_size_tokens",
    "child_chunk_overlap_tokens", "remove_extra_spaces", "remove_urls_emails", "created_at", "updated_at",
)
DOCUMENT_FIELDS = {
    "knowledge_base_id": "knowledgeBaseId", "chunk_count": "chunkCount", "created_at": "createdAt",
    "updated_at": "updatedAt", "original_filename": "originalFilename", "original_file_type": "originalFileType",
    "original_file_size": "originalFileSize", "original_file_path": "originalFilePath",
    "error_message": "errorMessage", "retry_count": "retryCount", "quality_label": "qualityLabel",
    "processing_started_at": "processingStartedAt", "downloading_completed_at": "downloadingCompletedAt",
    "parsing_completed_at": "parsingCompletedAt", "normalizing_completed_at": "normalizingCompletedAt",
    "chunking_completed_at": "chunkingCompletedAt", "embedding_completed_at": "embeddingCompletedAt",
}


async def get_base(db: AsyncSession, base_id: str) -> KnowledgeBase:
    base = await db.scalar(select(KnowledgeBase).where(KnowledgeBase.id == base_id).options(noload(KnowledgeBase.documents)))
    if base is None:
        raise HTTPException(404, "知识库不存在")
    return base


async def get_document(db: AsyncSession, document_id: str) -> KnowledgeDocument:
    document = await db.scalar(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id).options(
        noload(KnowledgeDocument.chunks), noload(KnowledgeDocument.knowledge_base),
    ))
    if document is None:
        raise HTTPException(404, "文档不存在")
    return document


def base_dto(base: KnowledgeBase, document_count: int) -> dict:
    return {**{field: getattr(base, field) for field in BASE_FIELDS}, "document_count": document_count}


def document_dto(document: KnowledgeDocument, *, full: bool = True) -> dict:
    result = {field: getattr(document, field) for field in ("id", "title", "status", "enabled")}
    result.update({target: getattr(document, source) for source, target in DOCUMENT_FIELDS.items()})
    if full:
        result["content"] = document.content
    else:
        result.pop("originalFilePath")
    detail = document.processing_detail
    try:
        result["processingDetail"] = json.loads(detail) if detail else None
    except (ValueError, TypeError):
        result["processingDetail"] = detail
    return result


def chunk_dto(chunk: KnowledgeChunk) -> dict:
    return {
        "id": chunk.id, "documentId": chunk.document_id, "knowledgeBaseId": chunk.knowledge_base_id,
        "content": chunk.content, "chunkIndex": chunk.chunk_index, "tokenCount": chunk.token_count,
        "enabled": chunk.enabled, "qualityLabel": chunk.quality_label, "sourceType": chunk.source_type,
        "parentChunkId": chunk.parent_chunk_id, "createdAt": chunk.created_at,
    }


async def document_count(db: AsyncSession, base_id: str) -> int:
    return await db.scalar(select(func.count()).select_from(KnowledgeDocument).where(
        KnowledgeDocument.knowledge_base_id == base_id,
    ))


def preview_chunks(text: str, config: ChunkSettings) -> dict:
    splitter = RecursiveTokenTextSplitter(
        config.chunk_size_tokens, config.chunk_overlap_tokens,
        fixed_separator=config.custom_separator if config.separator_mode == "custom" else None,
    )

    def snippet(index: int, content: str, length: int) -> dict:
        return {
            "index": index, "content": content[:length] + ("..." if len(content) > length else ""),
            "token_count": estimate_tokens(content),
        }

    if config.chunk_structure == "hierarchical":
        parents, children = splitter.split_hierarchical(
            text, config.child_chunk_size_tokens or 400,
            60 if config.child_chunk_overlap_tokens is None else config.child_chunk_overlap_tokens,
        )
        return {
            "chunk_structure": "hierarchical", "total_parents": len(parents),
            "total_children": sum(len(group) for group in children.values()),
            "preview": [
                {**snippet(index, parent, 500), "children": [
                    snippet(child_index, child, 300) for child_index, child in enumerate(children[index])
                ]}
                for index, parent in enumerate(parents)
            ],
        }
    chunks = splitter.split_text(text)
    return {
        "chunk_structure": "paragraph", "total": len(chunks),
        "preview": [snippet(index, chunk, 500) for index, chunk in enumerate(chunks)],
    }


async def edit_chunk(db: AsyncSession, chunk_id: str, content: str) -> KnowledgeChunk:
    chunk = await db.scalar(select(KnowledgeChunk).where(KnowledgeChunk.id == chunk_id).options(
        noload(KnowledgeChunk.document),
    ))
    if chunk is None:
        raise HTTPException(404, "切片不存在")
    provider = get_embedding_provider()
    if provider is None:
        raise HTTPException(503, "No embedding provider configured")
    try:
        vectors = await provider.embed([content])
        if (len(vectors) != 1 or len(vectors[0]) != 1024
                or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vectors[0])):
            raise ValueError("Embedding must contain one finite 1024-dimensional vector")
    except Exception as exc:
        logger.exception("Chunk embedding failed chunk=%s", chunk_id)
        raise HTTPException(503, "Chunk embedding failed") from exc
    title = await db.scalar(select(KnowledgeDocument.title).where(KnowledgeDocument.id == chunk.document_id))
    chunk.content = content
    chunk.token_count = estimate_tokens(content)
    chunk.embedding = vectors[0]
    await db.commit()
    await knowledge_index.update_chunk({
        "chunkId": chunk.id, "kbId": chunk.knowledge_base_id, "docId": chunk.document_id,
        "title": title, "content": content, "sourceType": chunk.source_type,
        "qualityLabel": chunk.quality_label,
        "createdAt": (chunk.created_at or datetime.now(UTC)).isoformat(),
    })
    return chunk


async def remove_document(db: AsyncSession, document_id: str) -> None:
    await get_document(db, document_id)
    await db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document_id))
    await db.execute(delete(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    await db.commit()
    await knowledge_index.remove_documents([document_id])


async def remove_base(db: AsyncSession, base_id: str) -> None:
    await get_base(db, base_id)
    documents = list(await db.scalars(select(KnowledgeDocument.id).where(KnowledgeDocument.knowledge_base_id == base_id)))
    await db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.knowledge_base_id == base_id))
    await db.execute(delete(KnowledgeDocument).where(KnowledgeDocument.knowledge_base_id == base_id))
    await db.execute(delete(KnowledgeBase).where(KnowledgeBase.id == base_id))
    await db.commit()
    await knowledge_index.remove_documents(documents)


async def stats(db: AsyncSession) -> dict:
    es_available, es_count = await knowledge_index.index_stats()
    chunks = await db.scalar(select(func.count()).select_from(KnowledgeChunk))
    enabled = await db.scalar(select(func.count()).select_from(KnowledgeChunk).where(KnowledgeChunk.enabled.is_(True)))
    embedded = await db.scalar(select(func.count()).select_from(KnowledgeChunk).where(
        KnowledgeChunk.enabled.is_(True), KnowledgeChunk.embedding.is_not(None),
    ))
    return {
        "knowledge_bases": await db.scalar(select(func.count()).select_from(KnowledgeBase)),
        "documents": await db.scalar(select(func.count()).select_from(KnowledgeDocument)),
        "chunks": chunks,
        "retrieval": {
            "totalChunks": enabled, "chunksWithEmbedding": embedded,
            "pgvectorEnabled": settings.pgvector_enabled, "elasticsearchAvailable": es_available,
            "elasticsearchIndexedChunks": es_count,
        },
    }
