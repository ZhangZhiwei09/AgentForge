"""Compatibility entry for text ingestion through the shared document pipeline."""

import uuid

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.knowledge import KnowledgeDocument
from src.schemas.knowledge import ChunkSettings
from src.services.knowledge_management import get_base


async def ingest_document(
    kb_id: str, title: str, content: str, *,
    session_factory=None, db: AsyncSession | None = None,
    chunk_size: int | None = None, chunk_overlap: int | None = None,
) -> dict:
    from src.services.knowledge_ingestion import IngestionService

    if db is None:
        if session_factory is None:
            from src.db import async_session

            session_factory = async_session
        async with session_factory() as session:
            return await ingest_document(
                kb_id, title, content, db=session, chunk_size=chunk_size, chunk_overlap=chunk_overlap,
            )
    base = await get_base(db, kb_id)
    document_id = str(uuid.uuid4())
    if not content.strip():
        return {"doc_id": document_id, "chunk_count": 0, "status": "empty"}
    overrides = {
        key: value for key, value in {
            "chunk_size_tokens": chunk_size, "chunk_overlap_tokens": chunk_overlap,
        }.items() if value is not None
    }
    try:
        ChunkSettings.model_validate({
            **{field: getattr(base, field) for field in ChunkSettings.model_fields}, **overrides,
        })
    except ValidationError:
        raise HTTPException(422, "Invalid merged chunk configuration") from None
    db.add(KnowledgeDocument(
        id=document_id, knowledge_base_id=kb_id, title=title, content=content,
    ))
    await db.commit()
    result = await IngestionService(db).process(document_id, kb_id, chunk_overrides=overrides)
    if result["status"] == "failed":
        raise RuntimeError("Document ingestion failed; inspect document processing details")
    return result
