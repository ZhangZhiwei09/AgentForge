from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ── Knowledge Base ──────────────────────────────────────────

class KnowledgeBaseCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None


class KnowledgeBaseUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    enabled: Optional[bool] = None


class KnowledgeBaseResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    enabled: bool
    document_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Knowledge Document ──────────────────────────────────────

class KnowledgeDocumentCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., min_length=1)


class KnowledgeDocumentUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=500)
    content: Optional[str] = Field(None, min_length=1)
    enabled: Optional[bool] = None


class KnowledgeDocumentResponse(BaseModel):
    id: str
    knowledge_base_id: str
    title: str
    content: str
    chunk_count: int
    status: str
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Knowledge Chunk ─────────────────────────────────────────

class KnowledgeChunkResponse(BaseModel):
    id: str
    document_id: str
    knowledge_base_id: str
    chunk_index: int
    content: str
    token_count: int
    milvus_id: Optional[int] = None
    enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Search ──────────────────────────────────────────────────

class KnowledgeSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, description="搜索查询文本")
    kb_ids: Optional[list[str]] = Field(None, description="限定知识库 ID 列表，为空则搜索所有")
    top_k: int = Field(3, ge=1, le=20, description="返回结果数量")


class KnowledgeSearchResult(BaseModel):
    chunk_id: str
    doc_id: str
    kb_id: str
    content: str
    score: float
    chunk_index: int


class KnowledgeSearchResponse(BaseModel):
    results: list[KnowledgeSearchResult]
    query: str
    total: int
    cache_hit: bool = False


# ── Batch Ingest ────────────────────────────────────────────

class BatchDocumentCreate(BaseModel):
    documents: list[KnowledgeDocumentCreate] = Field(..., min_length=1, max_length=100)


class BatchIngestResponse(BaseModel):
    kb_id: str
    doc_ids: list[str]
    status: str
    message: str
