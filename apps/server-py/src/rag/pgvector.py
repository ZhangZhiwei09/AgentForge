"""PgVectorKnowledgeService —— 基于 pgvector 的语义搜索知识库服务。

实现 KnowledgeService Protocol，使用 pgvector 的余弦相似度（<=>）做向量检索。
V1 只做纯向量检索；hybrid_search 委托给 search()，双路扩展点保留。
"""

import logging
import uuid
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.rag.embeddings import EmbeddingProvider, get_embedding_provider
from src.rag.types import HybridSearchParams, KnowledgeSearchResult

logger = logging.getLogger(__name__)


class PgVectorKnowledgeService:
    """pgvector 知识库检索服务。

    实现 KnowledgeService Protocol：
        - search(): 语义向量搜索
        - hybrid_search(): 混合搜索（V1 委托给 search）

    需要 pgvector 扩展 + embedding 列已存在。
    """

    def __init__(
        self,
        session_factory,
        embedding_provider: EmbeddingProvider | None = None,
    ) -> None:
        """初始化 PgVector 知识库服务。

        Args:
            session_factory: AsyncSession 工厂（如 async_sessionmaker）
            embedding_provider: Embedding Provider，默认从配置获取
        """
        self._session_factory = session_factory
        self._embedding_provider = embedding_provider

    @property
    def embedding_provider(self) -> EmbeddingProvider | None:
        if self._embedding_provider is not None:
            return self._embedding_provider
        self._embedding_provider = get_embedding_provider()
        return self._embedding_provider

    # ── KnowledgeService Protocol 实现 ────────────────────

    async def search(
        self,
        query: str,
        kb_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> list[KnowledgeSearchResult]:
        """语义向量搜索。

        Args:
            query: 自然语言查询
            kb_ids: 限制知识库 ID 列表（None=全部）
            top_k: 返回结果数

        Returns:
            按余弦相似度降序排列的搜索结果
        """
        if not settings.pgvector_enabled:
            logger.debug("pgvector disabled, returning empty results")
            return []

        provider = self.embedding_provider
        if provider is None:
            logger.warning("No embedding provider available")
            return []

        try:
            # 1. 向量化查询
            embeddings = await provider.embed([query])
            if not embeddings:
                return []
            query_embedding = embeddings[0]

            # 2. pgvector 余弦相似度搜索
            async with self._session_factory() as session:
                results = await self._vector_search(
                    session, query_embedding, kb_ids, top_k
                )
                return results

        except Exception as exc:
            logger.error("PgVector search failed: %s", exc)
            return []

    async def hybrid_search(
        self,
        params: HybridSearchParams,
    ) -> list[KnowledgeSearchResult]:
        """混合搜索（V1 委托给 search，双路扩展点保留）。

        未来可扩展为：向量 + 关键词 → RRF 融合。
        """
        return await self.search(
            query=params.query,
            kb_ids=params.kb_ids,
            top_k=params.top_k,
        )

    # ── 内部方法 ─────────────────────────────────────────

    async def _vector_search(
        self,
        session: AsyncSession,
        query_embedding: list[float],
        kb_ids: list[str] | None,
        top_k: int,
    ) -> list[KnowledgeSearchResult]:
        """执行 pgvector 余弦相似度搜索。

        使用 <=> 运算符（余弦距离），1 - 距离 = 相似度。
        """
        # 构建 SQL：按余弦距离排序
        # asyncpg 要求 vector 传字符串字面量；查询向量转成 '[0.1,...]' 内联
        #（float 值无注入风险），避免 list 参数报 "expected str, got list"。
        if kb_ids:
            kb_filter = "AND kc.knowledge_base_id = ANY(:kb_ids)"
        else:
            kb_filter = ""

        vec_str = "[" + ",".join(repr(x) for x in query_embedding) + "]"
        sql = f"""
            SELECT
                kc.id AS chunk_id,
                kc.document_id AS doc_id,
                kc.knowledge_base_id AS kb_id,
                kc.content,
                kc.chunk_index,
                kc.token_count,
                1 - (kc.embedding <=> '{vec_str}'::vector) AS score,
                kd.title AS doc_title
            FROM knowledge_chunks kc
            JOIN knowledge_documents kd ON kc.document_id = kd.id
            WHERE kc.embedding IS NOT NULL
              AND kc.enabled = TRUE
              {kb_filter}
            ORDER BY kc.embedding <=> '{vec_str}'::vector
            LIMIT :top_k
        """

        params: dict = {"top_k": top_k}
        if kb_ids:
            params["kb_ids"] = kb_ids

        result = await session.execute(text(sql), params)
        rows = result.fetchall()

        return [
            KnowledgeSearchResult(
                chunk_id=row.chunk_id,
                doc_id=row.doc_id,
                kb_id=row.kb_id,
                content=row.content or "",
                score=round(float(row.score), 4) if row.score else 0.0,
                chunk_index=row.chunk_index or 0,
                doc_title=row.doc_title or "",
            )
            for row in rows
        ]


# ═══════════════════════════════════════════════════════════
# 工厂
# ═══════════════════════════════════════════════════════════

_knowledge_service: PgVectorKnowledgeService | None = None


def get_knowledge_service(
    session_factory=None,
) -> PgVectorKnowledgeService:
    """获取 PgVectorKnowledgeService 单例（惰性初始化）。

    Args:
        session_factory: AsyncSession 工厂，首次调用时必须提供

    Returns:
        PgVectorKnowledgeService 实例
    """
    global _knowledge_service
    if _knowledge_service is not None:
        return _knowledge_service

    if session_factory is None:
        from src.db import async_session

        session_factory = async_session

    _knowledge_service = PgVectorKnowledgeService(
        session_factory=session_factory,
    )
    return _knowledge_service
