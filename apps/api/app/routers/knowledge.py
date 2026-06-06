from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.database.session import get_db
from app.models.knowledge import KnowledgeBaseModel, KnowledgeDocumentModel, KnowledgeChunkModel
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeBaseResponse,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    KnowledgeDocumentResponse,
    KnowledgeChunkResponse,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSearchResult,
    BatchDocumentCreate,
    BatchIngestResponse,
)
from app.services.knowledge_service import KnowledgeService
from app.services.knowledge_ingestion import KnowledgeIngestionService

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


# ── 知识库 CRUD ──────────────────────────────────────────────

@router.post("/bases", response_model=KnowledgeBaseResponse, status_code=201)
async def create_knowledge_base(
    data: KnowledgeBaseCreate,
    db: AsyncSession = Depends(get_db),
):
    kb = KnowledgeBaseModel(name=data.name, description=data.description)
    db.add(kb)
    await db.commit()
    await db.refresh(kb)
    return KnowledgeBaseResponse(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        enabled=kb.enabled,
        document_count=0,
        created_at=kb.created_at,
        updated_at=kb.updated_at,
    )


@router.get("/bases", response_model=list[KnowledgeBaseResponse])
async def list_knowledge_bases(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(KnowledgeBaseModel).order_by(KnowledgeBaseModel.created_at.desc()))
    bases = result.scalars().all()

    responses = []
    for kb in bases:
        count_result = await db.execute(
            select(func.count()).select_from(KnowledgeDocumentModel).where(
                KnowledgeDocumentModel.knowledge_base_id == kb.id
            )
        )
        doc_count = count_result.scalar() or 0
        responses.append(
            KnowledgeBaseResponse(
                id=kb.id,
                name=kb.name,
                description=kb.description,
                enabled=kb.enabled,
                document_count=doc_count,
                created_at=kb.created_at,
                updated_at=kb.updated_at,
            )
        )
    return responses


@router.get("/bases/{kb_id}", response_model=KnowledgeBaseResponse)
async def get_knowledge_base(kb_id: str, db: AsyncSession = Depends(get_db)):
    kb = await db.get(KnowledgeBaseModel, kb_id)
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")

    count_result = await db.execute(
        select(func.count()).select_from(KnowledgeDocumentModel).where(
            KnowledgeDocumentModel.knowledge_base_id == kb.id
        )
    )
    doc_count = count_result.scalar() or 0
    return KnowledgeBaseResponse(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        enabled=kb.enabled,
        document_count=doc_count,
        created_at=kb.created_at,
        updated_at=kb.updated_at,
    )


@router.put("/bases/{kb_id}", response_model=KnowledgeBaseResponse)
async def update_knowledge_base(
    kb_id: str,
    data: KnowledgeBaseUpdate,
    db: AsyncSession = Depends(get_db),
):
    kb = await db.get(KnowledgeBaseModel, kb_id)
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")

    if data.name is not None:
        kb.name = data.name
    if data.description is not None:
        kb.description = data.description
    if data.enabled is not None:
        kb.enabled = data.enabled

    await db.commit()
    await db.refresh(kb)

    count_result = await db.execute(
        select(func.count()).select_from(KnowledgeDocumentModel).where(
            KnowledgeDocumentModel.knowledge_base_id == kb.id
        )
    )
    doc_count = count_result.scalar() or 0
    return KnowledgeBaseResponse(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        enabled=kb.enabled,
        document_count=doc_count,
        created_at=kb.created_at,
        updated_at=kb.updated_at,
    )


@router.delete("/bases/{kb_id}")
async def delete_knowledge_base(kb_id: str, db: AsyncSession = Depends(get_db)):
    kb = await db.get(KnowledgeBaseModel, kb_id)
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")
    await db.delete(kb)
    await db.commit()
    return {"status": "deleted"}


# ── 文档 CRUD ────────────────────────────────────────────────

@router.get("/bases/{kb_id}/documents", response_model=list[KnowledgeDocumentResponse])
async def list_documents(kb_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(KnowledgeDocumentModel)
        .where(KnowledgeDocumentModel.knowledge_base_id == kb_id)
        .order_by(KnowledgeDocumentModel.created_at.desc())
    )
    return [KnowledgeDocumentResponse.model_validate(doc) for doc in result.scalars().all()]


@router.get("/documents/{doc_id}", response_model=KnowledgeDocumentResponse)
async def get_document(doc_id: str, db: AsyncSession = Depends(get_db)):
    doc = await db.get(KnowledgeDocumentModel, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    return KnowledgeDocumentResponse.model_validate(doc)


@router.post(
    "/bases/{kb_id}/documents",
    response_model=KnowledgeDocumentResponse,
    status_code=201,
)
async def create_document(
    kb_id: str,
    data: KnowledgeDocumentCreate,
    db: AsyncSession = Depends(get_db),
):
    kb = await db.get(KnowledgeBaseModel, kb_id)
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")

    ingestion = KnowledgeIngestionService(db)
    doc = await ingestion.ingest_document(
        kb_id=kb_id,
        title=data.title,
        content=data.content,
    )
    return KnowledgeDocumentResponse.model_validate(doc)


@router.post("/bases/{kb_id}/documents/batch", response_model=BatchIngestResponse)
async def batch_create_documents(
    kb_id: str,
    data: BatchDocumentCreate,
    db: AsyncSession = Depends(get_db),
):
    kb = await db.get(KnowledgeBaseModel, kb_id)
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")

    ingestion = KnowledgeIngestionService(db)
    docs_data = [{"title": d.title, "content": d.content} for d in data.documents]
    docs = await ingestion.batch_ingest(kb_id, docs_data)

    return BatchIngestResponse(
        kb_id=kb_id,
        doc_ids=[d.id for d in docs],
        status="completed",
        message=f"成功摄入 {len(docs)} 篇文档",
    )


@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, db: AsyncSession = Depends(get_db)):
    ingestion = KnowledgeIngestionService(db)
    deleted = await ingestion.delete_document(doc_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="文档不存在")
    return {"status": "deleted"}


# ── 文档 Chunk 查询 ──────────────────────────────────────────

@router.get("/documents/{doc_id}/chunks", response_model=list[KnowledgeChunkResponse])
async def list_chunks(doc_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(KnowledgeChunkModel)
        .where(KnowledgeChunkModel.document_id == doc_id)
        .order_by(KnowledgeChunkModel.chunk_index)
    )
    return [KnowledgeChunkResponse.model_validate(c) for c in result.scalars().all()]


# ── 搜索 ─────────────────────────────────────────────────────

@router.post("/search", response_model=KnowledgeSearchResponse)
async def search_knowledge(
    req: KnowledgeSearchRequest,
    db: AsyncSession = Depends(get_db),
):
    service = KnowledgeService(db)
    results = await service.search(
        query=req.query,
        kb_ids=req.kb_ids,
        top_k=req.top_k,
    )
    return KnowledgeSearchResponse(
        results=results,
        query=req.query,
        total=len(results),
    )


# ── 统计 ─────────────────────────────────────────────────────

@router.get("/stats")
async def get_knowledge_stats(db: AsyncSession = Depends(get_db)):
    service = KnowledgeService(db)
    milvus_stats = await service.get_collection_stats()

    kb_count_result = await db.execute(
        select(func.count()).select_from(KnowledgeBaseModel)
    )
    doc_count_result = await db.execute(
        select(func.count()).select_from(KnowledgeDocumentModel)
    )
    chunk_count_result = await db.execute(
        select(func.count()).select_from(KnowledgeChunkModel)
    )

    return {
        "knowledge_bases": kb_count_result.scalar() or 0,
        "documents": doc_count_result.scalar() or 0,
        "chunks": chunk_count_result.scalar() or 0,
        "milvus": milvus_stats,
    }
