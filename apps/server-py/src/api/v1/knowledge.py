"""Knowledge API —— 知识库摄入端点。

POST /api/knowledge/ingest —— 摄入文档（split → embed → store）
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.rag.ingestion import ingest_document

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


class IngestRequest(BaseModel):
    """文档摄入请求。"""

    kb_id: str = Field(..., min_length=1, description="知识库 ID")
    title: str = Field(..., min_length=1, max_length=500, description="文档标题")
    content: str = Field(..., min_length=1, description="文档正文（纯文本）")
    chunk_size: int | None = Field(default=None, description="分片 token 数（可选）")
    chunk_overlap: int | None = Field(default=None, description="重叠 token 数（可选）")


class IngestResponse(BaseModel):
    """文档摄入响应。"""

    doc_id: str
    chunk_count: int
    status: str


@router.post("/ingest", response_model=IngestResponse)
async def ingest(body: IngestRequest):
    """摄入文档：分片 → 向量化 → 存储。

    V1 只接受纯文本 content 字段，不做文件上传和格式解析。
    """
    try:
        result = await ingest_document(
            kb_id=body.kb_id,
            title=body.title,
            content=body.content,
            chunk_size=body.chunk_size,
            chunk_overlap=body.chunk_overlap,
        )
        return IngestResponse(
            doc_id=result["doc_id"],
            chunk_count=result["chunk_count"],
            status=result["status"],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Ingest failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {exc}") from exc
