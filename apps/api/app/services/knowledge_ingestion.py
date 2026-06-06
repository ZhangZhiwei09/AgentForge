"""知识库文档摄取管道。

流程：
1. 创建 DocumentModel，状态标记为 "processing"
2. 用 RecursiveCharacterTextSplitter 将文档切分为 chunk
3. 生成 Dense 向量（Embedding）和 Sparse 向量（BM25）
4. 批量插入 Milvus，获取 milvus_id
5. 保存 ChunkModel 到 PostgreSQL
6. 更新 DocumentModel 状态为 "completed"
"""

import uuid
import logging
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.config import settings
from app.models.knowledge import KnowledgeBaseModel, KnowledgeDocumentModel, KnowledgeChunkModel
from app.services.embeddings.registry import get_default_embedding_provider
from app.services.text_splitter import RecursiveCharacterTextSplitter
from app.services.milvus_async import run_milvus
from app.services.bm25_tokenizer import BM25SparseEncoder

logger = logging.getLogger(__name__)

MILVUS_COLLECTION = "agentforge_knowledge"

# 全局 BM25 编码器（所有知识库共享一个实例，在 fit 时按需重建）
_bm25_encoder: Optional[BM25SparseEncoder] = None


def _get_bm25() -> BM25SparseEncoder:
    global _bm25_encoder
    if _bm25_encoder is None:
        _bm25_encoder = BM25SparseEncoder()
    return _bm25_encoder


class KnowledgeIngestionService:
    """知识库文档摄取服务。"""

    def __init__(self, db: AsyncSession):
        self._db = db
        self._splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        self._collection = None

    def _get_collection(self):
        """获取 Milvus 集合引用（含连接建立）。"""
        if self._collection is not None:
            return self._collection

        from pymilvus import connections, Collection

        connections.connect(
            alias="default",
            host=settings.milvus_host,
            port=settings.milvus_port,
        )
        self._collection = Collection(MILVUS_COLLECTION)
        return self._collection

    # ── 单文档摄取 ─────────────────────────────────────────────

    async def ingest_document(
        self,
        kb_id: str,
        title: str,
        content: str,
    ) -> KnowledgeDocumentModel:
        """将一篇文档切分、向量化、存入 Milvus 和 PostgreSQL。

        Args:
            kb_id: 知识库 ID
            title: 文档标题
            content: 文档正文

        Returns:
            创建好的 KnowledgeDocumentModel（status="completed"）
        """
        # 1. 创建文档记录（processing）
        doc = KnowledgeDocumentModel(
            id=str(uuid.uuid4()),
            knowledge_base_id=kb_id,
            title=title,
            content=content,
            chunk_count=0,
            status="processing",
        )
        self._db.add(doc)
        await self._db.flush()

        try:
            # 2. 文本切分
            chunks = self._splitter.split_text(content)
            if not chunks:
                doc.status = "completed"
                doc.chunk_count = 0
                await self._db.commit()
                return doc

            # 3. 生成向量
            await self._ingest_chunks(doc.id, kb_id, chunks)

            # 4. 更新文档状态
            doc.chunk_count = len(chunks)
            doc.status = "completed"
            await self._db.commit()
            await self._db.refresh(doc)

            logger.info(f"文档摄入完成: {title} ({len(chunks)} chunks)")
            return doc

        except Exception as e:
            logger.error(f"文档摄入失败: {title}, {e}")
            doc.status = "failed"
            await self._db.commit()
            raise

    # ── 批量摄入 ────────────────────────────────────────────────

    async def batch_ingest(
        self,
        kb_id: str,
        documents: list[dict],
    ) -> list[KnowledgeDocumentModel]:
        """批量摄入多篇文档。

        Args:
            kb_id: 知识库 ID
            documents: [{"title": "...", "content": "..."}, ...]

        Returns:
            创建好的文档模型列表
        """
        results = []
        for doc_data in documents:
            doc = await self.ingest_document(
                kb_id=kb_id,
                title=doc_data["title"],
                content=doc_data["content"],
            )
            results.append(doc)
        return results

    # ── 内部：chunk 向量化 + Milvus 入库 ────────────────────────

    async def _ingest_chunks(
        self,
        doc_id: str,
        kb_id: str,
        chunk_texts: list[str],
    ) -> None:
        """对一批 chunk 文本生成 Dense+Sparse 向量并写入 Milvus 和 PG。"""
        provider = get_default_embedding_provider()
        if provider is None:
            raise RuntimeError("未配置 Embedding Provider，无法入库")

        # 1. Dense 向量（批量嵌入）
        dense_vecs = await provider.embed(chunk_texts)
        if dense_vecs is None or len(dense_vecs) != len(chunk_texts):
            raise RuntimeError("向量嵌入失败或返回数量不一致")

        # 2. Sparse 向量（BM25）
        bm25 = _get_bm25()
        sparse_vecs = bm25.encode_documents(chunk_texts)

        # 3. 构建 Milvus 插入实体
        chunk_ids = [str(uuid.uuid4()) for _ in chunk_texts]
        entities = [
            chunk_ids,
            [kb_id] * len(chunk_texts),
            dense_vecs,
            sparse_vecs,
            [t[:4096] for t in chunk_texts],
        ]

        collection = self._get_collection()
        mr = await run_milvus(
            collection.insert,
            entities,
        )
        await run_milvus(collection.flush)

        # 4. 保存 ChunkModel 到 PG
        milvus_ids = mr.primary_keys
        for i, chunk_id in enumerate(chunk_ids):
            milvus_id = milvus_ids[i] if i < len(milvus_ids) else None
            chunk_model = KnowledgeChunkModel(
                id=chunk_id,
                document_id=doc_id,
                knowledge_base_id=kb_id,
                chunk_index=i,
                content=chunk_texts[i],
                token_count=len(chunk_texts[i]),
                milvus_id=milvus_id,
            )
            self._db.add(chunk_model)

        await self._db.flush()

    # ── 删除文档 ────────────────────────────────────────────────

    async def delete_document(self, doc_id: str) -> bool:
        """删除文档及关联的 chunk（PG + Milvus）。"""
        doc = await self._db.get(KnowledgeDocumentModel, doc_id)
        if not doc:
            return False

        # 获取所有关联 chunk 的 milvus_id
        result = await self._db.execute(
            select(KnowledgeChunkModel.milvus_id)
            .where(KnowledgeChunkModel.document_id == doc_id)
        )
        milvus_ids = [row[0] for row in result.all() if row[0] is not None]

        # 从 Milvus 删除
        if milvus_ids:
            try:
                collection = self._get_collection()
                id_expr = ", ".join(str(mid) for mid in milvus_ids)
                await run_milvus(collection.delete, f"id in [{id_expr}]")
            except Exception as e:
                logger.warning(f"Milvus 删除失败: {e}")

        # 从 PG 删除 chunk 和 document
        await self._db.execute(
            delete(KnowledgeChunkModel).where(KnowledgeChunkModel.document_id == doc_id)
        )
        await self._db.delete(doc)
        await self._db.commit()

        logger.info(f"文档已删除: {doc_id}, 清理了 {len(milvus_ids)} 个向量")
        return True

    # ── 重建 BM25 索引 ──────────────────────────────────────────

    @classmethod
    async def rebuild_bm25_index(cls, db: AsyncSession, kb_id: str) -> None:
        """重建指定知识库的 BM25 索引（在文档大量变更后调用）。

        Args:
            db: 数据库会话
            kb_id: 知识库 ID
        """
        result = await db.execute(
            select(KnowledgeChunkModel.content)
            .where(
                KnowledgeChunkModel.knowledge_base_id == kb_id,
                KnowledgeChunkModel.enabled == True,
            )
        )
        corpus = [row[0] for row in result.all()]
        if corpus:
            bm25 = _get_bm25()
            bm25.fit(corpus)
            logger.info(f"BM25 索引重建完成: kb={kb_id}, 语料={len(corpus)}")
