"""Document ingestion with durable status, bounded claims and atomic chunks."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import anyio
from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.models.knowledge import KnowledgeChunk, KnowledgeDocument
from src.rag.embeddings import get_embedding_provider, validate_embeddings
from src.rag.splitter import RecursiveTokenTextSplitter, estimate_tokens
from src.schemas.knowledge import ChunkSettings
from src.services import document_parser, knowledge_index, knowledge_storage
from src.services.knowledge_management import get_base, get_document

logger = logging.getLogger(__name__)
PROCESSING_STATUSES = ("processing", "downloading", "parsing", "normalizing", "chunking", "embedding", "writing_db")


class IngestionLeaseLost(RuntimeError):
    pass


def ingestion_lease_seconds() -> int:
    return max(settings.ingestion_lease_seconds, settings.ingestion_job_timeout_seconds + 30)


class IngestionService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.started_at = None
        self.document_id = ""

    def condition(self):
        return (
            KnowledgeDocument.id == self.document_id,
            KnowledgeDocument.processing_started_at == self.started_at,
            KnowledgeDocument.status.in_(PROCESSING_STATUSES),
        )

    async def phase(self, name: str, progress: int, message: str, **fields):
        now = datetime.now(UTC)
        result = await self.db.execute(update(KnowledgeDocument).where(*self.condition()).values(
            status=name, processing_detail=json.dumps({
                "phase": name, "progress": progress, "total": 100, "message": message,
                "worker": "python", "startedAt": self.started_at.isoformat(), "updatedAt": now.isoformat(),
            }, ensure_ascii=False),
            updated_at=now, **fields,
        ).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            await self.db.rollback()
            raise IngestionLeaseLost("Document processing claim was superseded")
        await self.db.commit()

    async def process(self, document_id: str, base_id: str, *, chunk_overrides: dict | None = None) -> dict:
        document = await get_document(self.db, document_id)
        if document.knowledge_base_id != base_id:
            raise HTTPException(404, "文档不存在")
        base = await get_base(self.db, base_id)
        if document.status == "completed":
            return {"doc_id": document_id, "status": "completed", "chunk_count": document.chunk_count, "processed": False}
        now = datetime.now(UTC)
        updated_at = document.updated_at or now
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=UTC)
        lease_seconds = ingestion_lease_seconds()
        if document.status in PROCESSING_STATUSES and updated_at > now - timedelta(seconds=lease_seconds):
            return {"doc_id": document_id, "status": "busy", "retryable": True}
        if document.status not in ("pending", "failed", *PROCESSING_STATUSES):
            raise HTTPException(409, "文档当前状态不可处理")
        self.started_at = now
        self.document_id = document_id
        version = KnowledgeDocument.updated_at == document.updated_at
        if self.db.get_bind().dialect.name == "sqlite":
            # SQLite's server clock omits fractional zeros in stored text.
            version = func.julianday(KnowledgeDocument.updated_at) == func.julianday(document.updated_at)
        claimed = await self.db.execute(update(KnowledgeDocument).where(
            KnowledgeDocument.id == document_id, KnowledgeDocument.status == document.status,
            version,
        ).values(
            status="processing", processing_started_at=now, updated_at=now,
            error_message=None, retry_count=document.retry_count + int(document.status != "pending"),
        ).execution_options(synchronize_session=False))
        if claimed.rowcount != 1:
            await self.db.rollback()
            return {"doc_id": document_id, "status": "busy", "retryable": True}
        await self.db.commit()
        await self.db.refresh(document)
        retryable = False
        try:
            # Read configuration at execution time, after the upload wizard saves it.
            config = ChunkSettings.model_validate({
                **{field: getattr(base, field) for field in ChunkSettings.model_fields},
                **(chunk_overrides or {}),
            })
            content = document.content
            pages = None
            try:
                stored_detail = json.loads(document.processing_detail or "{}")
            except (ValueError, TypeError):
                stored_detail = {}
            mime_type = stored_detail.get("mimeType") if isinstance(stored_detail, dict) else None
            if document.original_file_path and not content.strip():
                await self.phase("downloading", 5, "正在读取原始文件")
                raw = await knowledge_storage.read_file(document.original_file_path)
                if len(raw) > 15 * 1024 * 1024:
                    raise ValueError("文件超过 15MB 处理上限")
                await self.phase("parsing", 15, "正在提取文本", downloading_completed_at=datetime.now(UTC))
                parsed = await document_parser.parse_document(
                    raw, document.original_filename or document.original_file_path,
                    mime_type,
                )
                content, pages = parsed.text, parsed.page_count
            await self.phase("normalizing", 25, "正在清洗文本", parsing_completed_at=datetime.now(UTC))
            content = document_parser.normalize_text(
                content, remove_extra_spaces=base.remove_extra_spaces, remove_urls_emails=base.remove_urls_emails,
            )
            density = min(len(content) / max(pages or 1, 1) / 2000, 1)
            if not content or (density < 0.05 and len(content) < 100):
                raise ValueError("SCAN_OR_IMAGE_PDF: 无法提取足够文本内容，可能是扫描件或图片型 PDF")
            quality = "low" if density < 0.1 else "good"
            await self.phase(
                "chunking", 35, "正在切分文本", content=content, quality_label=quality,
                normalizing_completed_at=datetime.now(UTC),
            )
            splitter = RecursiveTokenTextSplitter(
                config.chunk_size_tokens, config.chunk_overlap_tokens,
                fixed_separator=config.custom_separator if config.separator_mode == "custom" else None,
            )
            chunks = []
            leaves = []
            if config.chunk_structure == "hierarchical":
                parents, children = splitter.split_hierarchical(
                    content, config.child_chunk_size_tokens or 400,
                    60 if config.child_chunk_overlap_tokens is None else config.child_chunk_overlap_tokens,
                )
                parent_ids = []
                for index, parent in enumerate(parents):
                    parent_id = str(uuid.uuid4())
                    parent_ids.append(parent_id)
                    chunks.append(self.chunk(document, parent_id, index, parent, quality=quality))
                for index, parent_id in enumerate(parent_ids):
                    for child in children[index]:
                        chunk = self.chunk(document, str(uuid.uuid4()), len(chunks), child, parent_id=parent_id, quality=quality)
                        chunks.append(chunk)
                        leaves.append(chunk)
            else:
                chunks = [
                    self.chunk(document, str(uuid.uuid4()), index, content, quality=quality)
                    for index, content in enumerate(splitter.split_text(content))
                ]
                leaves = chunks
            await self.phase("embedding", 45, "正在生成向量", chunking_completed_at=datetime.now(UTC))
            provider = get_embedding_provider()
            retryable = True
            if provider is None:
                raise RuntimeError("No embedding provider configured")
            for offset in range(0, len(leaves), 64):
                batch = leaves[offset:offset + 64]
                vectors = await provider.embed([chunk.content for chunk in batch])
                validate_embeddings(vectors, len(batch))
                for chunk, vector in zip(batch, vectors, strict=True):
                    chunk.embedding = vector
                await self.phase("embedding", 45 + int(40 * (offset + len(batch)) / max(1, len(leaves))), "正在生成向量")
            await self.phase("writing_db", 90, "正在保存分块", embedding_completed_at=datetime.now(UTC))
            await self.db.scalar(select(KnowledgeDocument.id).where(*self.condition()).with_for_update())
            # A conditional update is also needed for SQLite, where FOR UPDATE is ignored.
            completion = await self.db.execute(update(KnowledgeDocument).where(*self.condition()).values(
                status="completed", chunk_count=len(chunks), error_message=None, updated_at=datetime.now(UTC),
                processing_detail=json.dumps({
                    "phase": "completed", "progress": 100, "total": 100, "message": "处理完成", "worker": "python",
                }, ensure_ascii=False),
            ).execution_options(synchronize_session=False))
            if completion.rowcount != 1:
                raise IngestionLeaseLost("Document processing claim was superseded")
            await self.db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document_id))
            # Flush parents first to satisfy the self-referencing foreign key.
            self.db.add_all([chunk for chunk in chunks if chunk.parent_chunk_id is None])
            await self.db.flush()
            self.db.add_all([chunk for chunk in chunks if chunk.parent_chunk_id is not None])
            await self.db.commit()
            await knowledge_index.remove_documents([document_id])
            await knowledge_index.bulk_index_chunks([{
                "chunkId": chunk.id, "docId": document_id, "kbId": base_id,
                "title": document.title, "content": chunk.content, "sourceType": chunk.source_type,
                "qualityLabel": quality, "createdAt": now.isoformat(),
            } for chunk in leaves])
            return {"doc_id": document_id, "status": "completed", "chunk_count": len(chunks), "processed": True}
        except IngestionLeaseLost:
            await self.db.rollback()
            return {"doc_id": document_id, "status": "busy", "retryable": True}
        except (asyncio.CancelledError, GeneratorExit):
            with anyio.CancelScope(shield=True):
                await self.failed("处理已中断，可重试", retryable=True)
            raise
        except Exception as exc:
            logger.exception("Document ingestion failed document=%s", document_id)
            await self.failed(str(exc)[:2000], retryable=retryable)
            return {"doc_id": document_id, "status": "failed", "retryable": retryable}

    def chunk(
        self, document: KnowledgeDocument, chunk_id: str, index: int, content: str,
        *, parent_id: str | None = None, quality: str,
    ) -> KnowledgeChunk:
        return KnowledgeChunk(
            id=chunk_id, document_id=document.id, knowledge_base_id=document.knowledge_base_id,
            chunk_index=index, content=content, token_count=estimate_tokens(content),
            parent_chunk_id=parent_id, source_type=document.original_file_type or "text", quality_label=quality,
        )

    async def failed(self, message: str, *, retryable: bool) -> None:
        await self.db.rollback()
        await self.db.execute(update(KnowledgeDocument).where(*self.condition()).values(
            status="failed", error_message=message[:2000], updated_at=datetime.now(UTC),
            processing_detail=json.dumps({
                "phase": "failed", "progress": 0, "total": 100, "message": message[:2000],
                "retryable": retryable, "worker": "python",
            }, ensure_ascii=False),
        ).execution_options(synchronize_session=False))
        await self.db.commit()
