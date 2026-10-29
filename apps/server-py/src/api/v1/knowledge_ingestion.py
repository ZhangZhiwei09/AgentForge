"""Document creation, upload and explicit ingestion dispatch."""

import json
import re
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_db, require_admin
from src.config import settings
from src.jobs.ingestion import dispatch_ingestion
from src.models.knowledge import KnowledgeDocument
from src.services import document_parser, knowledge_storage
from src.services.knowledge_management import document_dto, get_base

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(require_admin)])
Db = Annotated[AsyncSession, Depends(get_db)]
MAX_UPLOAD = 15 * 1024 * 1024


class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1, max_length=MAX_UPLOAD)


class BatchDocumentCreate(BaseModel):
    documents: list[DocumentCreate] = Field(min_length=1, max_length=100)


@router.post("/bases/{base_id}/documents", status_code=201)
async def create_document(base_id: str, body: DocumentCreate, db: Db):
    await get_base(db, base_id)
    document = KnowledgeDocument(
        id=str(uuid.uuid4()), knowledge_base_id=base_id, title=body.title, content=body.content,
    )
    db.add(document)
    await db.commit()
    await dispatch_ingestion(db, document.id, base_id)
    await db.refresh(document)
    return document_dto(document)


@router.post("/bases/{base_id}/documents/batch")
async def create_documents(base_id: str, body: BatchDocumentCreate, db: Db):
    await get_base(db, base_id)
    documents = [KnowledgeDocument(
        id=str(uuid.uuid4()), knowledge_base_id=base_id, title=item.title, content=item.content,
    ) for item in body.documents]
    db.add_all(documents)
    await db.commit()
    document_ids = [document.id for document in documents]
    for document_id in document_ids:
        await dispatch_ingestion(db, document_id, base_id)
    return {
        "kb_id": base_id, "doc_ids": document_ids,
        "status": "pending" if settings.ingestion_async_enabled else "completed",
        "message": f"成功接收 {len(documents)} 篇文档",
    }


@router.post("/bases/{base_id}/documents/upload", status_code=201)
async def upload_document(base_id: str, request: Request, db: Db):
    await get_base(db, base_id)
    async with request.form(max_files=1, max_fields=5, max_part_size=MAX_UPLOAD) as form:
        file = form.get("file")
        # Starlette constructs UploadFile instances, rather than FastAPI's subclass.
        from starlette.datastructures import UploadFile as StarletteUploadFile

        if not isinstance(file, (UploadFile, StarletteUploadFile)):
            raise HTTPException(400, "请上传文件（字段名：file）")
        filename = re.split(r"[/\\]", file.filename or "uploaded_file")[-1]
        filename = re.sub(r"[\x00-\x1f]", "", filename)
        if not filename or filename in (".", "..") or len(filename) > 500:
            raise HTTPException(400, "文件名无效")
        parser = document_parser.parser_name(filename, file.content_type)
        if parser is None:
            raise HTTPException(400, "不支持的文件类型。支持 PDF、Word、图片和文本")
        raw = await file.read(MAX_UPLOAD + 1)
        if len(raw) > MAX_UPLOAD:
            raise HTTPException(400, "文件过大，最大支持 15MB")
        content = ""
        if parser == "text":
            content = raw.decode("utf-8-sig", errors="replace")
            if not content.strip():
                raise HTTPException(400, "文件内容为空")
        document_id = str(uuid.uuid4())
        stored_path = None
        if parser != "text":
            stored_path = await knowledge_storage.save_file(f"{document_id}/{filename}", raw)
        document = KnowledgeDocument(
            id=document_id, knowledge_base_id=base_id, title=Path(filename).stem or filename,
            content=content, original_filename=filename, original_file_type=Path(filename).suffix.lstrip(".").lower(),
            original_file_size=len(raw), original_file_path=stored_path,
            processing_detail=json.dumps({"phase": "pending", "mimeType": file.content_type}),
        )
        db.add(document)
        try:
            await db.commit()
        except Exception:
            if stored_path:
                await knowledge_storage.delete_file(stored_path)
            raise
        if request.query_params.get("process") != "false":
            await dispatch_ingestion(db, document_id, base_id)
        await db.refresh(document)
        return {**document_dto(document), "file_name": filename, "file_size": len(raw)}


@router.post("/bases/{base_id}/process")
async def process_documents(base_id: str, db: Db):
    await get_base(db, base_id)
    document_ids = list(await db.scalars(select(KnowledgeDocument.id).where(
        KnowledgeDocument.knowledge_base_id == base_id, KnowledgeDocument.status == "pending",
    )))
    processed = 0
    failed = 0
    for document_id in document_ids:
        try:
            await dispatch_ingestion(db, document_id, base_id)
            processed += 1
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            failed += 1
    result = {"processed": processed, "message": f"已接收 {processed} 篇文档"}
    if failed:
        result["failed"] = failed
    return result
