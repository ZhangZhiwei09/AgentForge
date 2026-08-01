"""文档摄入管道 —— split → embed → store。

V1 只接受纯文本 content 字段，不做文件上传和格式解析。
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from src.config import settings
from src.rag.embeddings import get_embedding_provider
from src.rag.splitter import RecursiveTokenTextSplitter, estimate_tokens

logger = logging.getLogger(__name__)


async def ingest_document(
    kb_id: str,
    title: str,
    content: str,
    *,
    session_factory=None,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
) -> dict:
    """摄入单篇文档：split → embed → store。

    流程:
        1. 文本 → RecursiveTokenTextSplitter → Chunk 列表
        2. 每个 Chunk → EmbeddingProvider.embed() → 向量
        3. 向量 + Chunk → knowledge_chunks 表

    Args:
        kb_id: 知识库 ID
        title: 文档标题
        content: 文档正文（纯文本）
        session_factory: AsyncSession 工厂
        chunk_size: 分片 token 数（默认从 settings 读取）
        chunk_overlap: 重叠 token 数（默认从 settings 读取）

    Returns:
        {"doc_id": str, "chunk_count": int, "status": str}
    """
    if session_factory is None:
        from src.db import async_session as default_factory

        session_factory = default_factory

    provider = get_embedding_provider()
    if provider is None:
        raise RuntimeError(
            "Embedding provider not configured. "
            "Set EMBEDDING_API_KEY or OPENAI_API_KEY in .env"
        )

    doc_id = str(uuid.uuid4())

    # ── Step 1: Split ──
    splitter = RecursiveTokenTextSplitter(
        chunk_size=chunk_size or settings.chunk_size_tokens,
        chunk_overlap=chunk_overlap or settings.chunk_overlap_tokens,
    )
    chunk_texts = splitter.split_text(content)

    if not chunk_texts:
        logger.warning("No chunks produced for document '%s'", title)
        return {
            "doc_id": doc_id,
            "chunk_count": 0,
            "status": "empty",
        }

    # ── Step 2: Embed ──
    try:
        embeddings = await provider.embed(chunk_texts)
    except Exception as exc:
        logger.error("Embedding failed for document '%s': %s", title, exc)
        # 记录失败文档
        async with session_factory() as session:
            await session.execute(
                text("""
                    INSERT INTO knowledge_documents
                        (id, knowledge_base_id, title, content, chunk_count,
                         status, error_message, created_at, updated_at)
                    VALUES
                        (:id, :kb_id, :title, :content, 0,
                         'failed', :error, :now, :now)
                """),
                {
                    "id": doc_id,
                    "kb_id": kb_id,
                    "title": title,
                    "content": content,
                    "error": str(exc)[:2000],
                    "now": datetime.now(timezone.utc),
                },
            )
            await session.commit()
        raise

    # ── Step 3: Store ──
    chunk_count = len(chunk_texts)
    now = datetime.now(timezone.utc)

    async with session_factory() as session:
        # 插入文档记录
        await session.execute(
            text("""
                INSERT INTO knowledge_documents
                    (id, knowledge_base_id, title, content, chunk_count,
                     status, enabled, created_at, updated_at)
                VALUES
                    (:id, :kb_id, :title, :content, :chunk_count,
                     'completed', TRUE, :now, :now)
            """),
            {
                "id": doc_id,
                "kb_id": kb_id,
                "title": title,
                "content": content,
                "chunk_count": chunk_count,
                "now": now,
            },
        )

        # 批量插入 chunks + embeddings
        for i, (chunk_text, embedding) in enumerate(
            zip(chunk_texts, embeddings)
        ):
            chunk_id = str(uuid.uuid4())
            await session.execute(
                text("""
                    INSERT INTO knowledge_chunks
                        (id, document_id, knowledge_base_id, chunk_index,
                         content, token_count, embedding, created_at)
                    VALUES
                        (:id, :doc_id, :kb_id, :chunk_index,
                         :content, :token_count, :embedding, :now)
                """),
                {
                    "id": chunk_id,
                    "doc_id": doc_id,
                    "kb_id": kb_id,
                    "chunk_index": i,
                    "content": chunk_text,
                    "token_count": estimate_tokens(chunk_text),
                    "embedding": embedding,
                    "now": now,
                },
            )

        await session.commit()

    logger.info(
        "Document '%s' ingested: %d chunks", title, chunk_count
    )
    return {
        "doc_id": doc_id,
        "chunk_count": chunk_count,
        "status": "completed",
    }
