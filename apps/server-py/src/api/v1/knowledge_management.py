"""Authenticated knowledge administration with legacy frontend DTOs."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from src.api.deps import get_current_user, get_db
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.schemas.knowledge import (
    ChunkPreview,
    ChunkSettings,
    ChunkUpdate,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
)
from src.services import knowledge_management as service

router = APIRouter(
    prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(get_current_user)],
)
Db = Annotated[AsyncSession, Depends(get_db)]


@router.post("/bases", status_code=201)
async def create_base(body: KnowledgeBaseCreate, db: Db):
    base = KnowledgeBase(id=str(uuid.uuid4()), **body.model_dump(exclude_none=True))
    db.add(base)
    await db.commit()
    await db.refresh(base)
    return service.base_dto(base, 0)


@router.get("/bases")
async def list_bases(db: Db):
    rows = (await db.execute(select(KnowledgeBase, func.count(KnowledgeDocument.id)).outerjoin(
        KnowledgeDocument, KnowledgeDocument.knowledge_base_id == KnowledgeBase.id,
    ).group_by(KnowledgeBase.id).order_by(KnowledgeBase.created_at.desc(), KnowledgeBase.id.desc()).options(
        noload(KnowledgeBase.documents),
    ))).all()
    return [service.base_dto(base, count) for base, count in rows]


@router.get("/bases/{base_id}")
async def get_base(base_id: str, db: Db):
    base = await service.get_base(db, base_id)
    return service.base_dto(base, await service.document_count(db, base_id))


@router.put("/bases/{base_id}")
async def update_base(base_id: str, body: KnowledgeBaseUpdate, db: Db):
    base = await service.get_base(db, base_id)
    updates = body.model_dump(exclude_unset=True)
    merged = {field: getattr(base, field) for field in ChunkSettings.model_fields}
    merged.update({key: value for key, value in updates.items() if key in merged})
    try:
        ChunkSettings.model_validate(merged)
    except ValidationError:
        raise HTTPException(422, "Invalid merged chunk configuration") from None
    for key, value in updates.items():
        setattr(base, key, value)
    await db.commit()
    await db.refresh(base)
    return service.base_dto(base, await service.document_count(db, base_id))


@router.delete("/bases/{base_id}")
async def delete_base(base_id: str, db: Db):
    await service.remove_base(db, base_id)
    return {"status": "deleted"}


@router.get("/bases/{base_id}/documents")
async def list_documents(base_id: str, db: Db):
    documents = await db.scalars(select(KnowledgeDocument).where(
        KnowledgeDocument.knowledge_base_id == base_id,
    ).order_by(KnowledgeDocument.created_at.desc(), KnowledgeDocument.id.desc()).options(
        noload(KnowledgeDocument.chunks), noload(KnowledgeDocument.knowledge_base),
    ))
    return [service.document_dto(document, full=False) for document in documents]


@router.get("/documents/{document_id}")
async def get_document(document_id: str, db: Db):
    return service.document_dto(await service.get_document(db, document_id))


@router.delete("/documents/{document_id}")
async def delete_document(document_id: str, db: Db):
    await service.remove_document(db, document_id)
    return {"status": "deleted"}


@router.get("/documents/{document_id}/chunks")
async def list_chunks(document_id: str, db: Db):
    chunks = await db.scalars(select(KnowledgeChunk).where(
        KnowledgeChunk.document_id == document_id,
    ).order_by(KnowledgeChunk.chunk_index, KnowledgeChunk.id).options(noload(KnowledgeChunk.document)))
    return [service.chunk_dto(chunk) for chunk in chunks]


@router.put("/chunks/{chunk_id}")
async def update_chunk(chunk_id: str, body: ChunkUpdate, db: Db):
    return service.chunk_dto(await service.edit_chunk(db, chunk_id, body.content))


@router.post("/chunk-preview")
async def chunk_preview(body: ChunkPreview):
    return service.preview_chunks(body.text, body)


@router.get("/stats")
async def stats(db: Db):
    return await service.stats(db)
