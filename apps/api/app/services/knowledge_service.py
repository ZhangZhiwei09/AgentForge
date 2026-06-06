"""知识库核心服务：混合检索 + LLM 重排序。

检索流程：
1. 将查询文本向量化（Dense）和 BM25 编码（Sparse）
2. 在 Milvus 中执行混合搜索（WeightedRanker: 0.6 dense + 0.4 sparse）
3. 用 Milvus 返回的 chunk_id 回查 PostgreSQL 获取完整内容
4. （可选）LLM 重排序：让 LLM 基于查询相关性对候选结果重新打分排序
"""

import json
import logging
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.models.knowledge import KnowledgeBaseModel, KnowledgeChunkModel
from app.schemas.knowledge import KnowledgeSearchResult
from app.services.embeddings.registry import get_default_embedding_provider
from app.services.milvus_async import run_milvus
from app.services.bm25_tokenizer import BM25SparseEncoder

logger = logging.getLogger(__name__)

MILVUS_COLLECTION = "agentforge_knowledge"
DENSE_DIM = 1536

# 混合检索权重：0.6 语义 + 0.4 关键词
DENSE_WEIGHT = 0.6
SPARSE_WEIGHT = 0.4

# LLM 重排序的 System Prompt
RERANK_SYSTEM_PROMPT = """你是一个搜索相关性评估助手。根据用户的查询，对给定的候选文档片段进行相关性打分。

返回一个 JSON 数组，每个元素包含：
- "index": 候选文档的索引（对应输入中的编号）
- "score": 0.0 到 1.0 之间的相关性分数（1.0 = 完全相关，0.0 = 完全不相关）
- "reason": 简短说明打分的理由

只返回分数最高的前 3 个结果。不相关的文档可以不返回。"""


class KnowledgeService:
    """知识库检索服务，封装混合搜索和 LLM 重排序逻辑。"""

    def __init__(self, db: AsyncSession):
        self._db = db
        self._collection = None
        self._bm25_encoder = None

    # ── Milvus 集合管理 ──────────────────────────────────────

    def _get_collection(self):
        """懒初始化 Milvus 知识库集合（含 Dense + Sparse 双向量字段）。"""
        if self._collection is not None:
            return self._collection

        from pymilvus import connections, Collection, FieldSchema, CollectionSchema, DataType
        from pymilvus import utility

        connections.connect(
            alias="default",
            host=settings.milvus_host,
            port=settings.milvus_port,
        )

        if utility.has_collection(MILVUS_COLLECTION):
            self._collection = Collection(MILVUS_COLLECTION)
        else:
            fields = [
                FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
                FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="kb_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="dense_vector", dtype=DataType.FLOAT_VECTOR, dim=DENSE_DIM),
                FieldSchema(name="sparse_vector", dtype=DataType.SPARSE_FLOAT_VECTOR),
                FieldSchema(name="content", dtype=DataType.VARCHAR, max_length=4096),
            ]
            schema = CollectionSchema(fields, description="AgentForge knowledge base")
            self._collection = Collection(MILVUS_COLLECTION, schema)

            # Dense 向量索引
            self._collection.create_index(
                field_name="dense_vector",
                index_params={
                    "metric_type": "COSINE",
                    "index_type": "IVF_FLAT",
                    "params": {"nlist": 128},
                },
            )
            # Sparse 向量索引
            self._collection.create_index(
                field_name="sparse_vector",
                index_params={
                    "metric_type": "IP",
                    "index_type": "SPARSE_INVERTED_INDEX",
                    "params": {"drop_ratio_build": 0.2},
                },
            )

        self._collection.load()
        return self._collection

    def _get_bm25(self) -> BM25SparseEncoder:
        """获取 BM25 编码器（全局单例）。"""
        if self._bm25_encoder is None:
            self._bm25_encoder = BM25SparseEncoder()
        return self._bm25_encoder

    # ── 混合搜索 ─────────────────────────────────────────────

    async def search(
        self,
        query: str,
        kb_ids: Optional[list[str]] = None,
        top_k: int = 5,
    ) -> list[KnowledgeSearchResult]:
        """混合搜索：Dense 语义 + Sparse 关键词，WeightedRanker 融合排序。

        Args:
            query: 用户查询文本
            kb_ids: 限定知识库 ID 列表，为空则搜索全部
            top_k: 返回结果数量

        Returns:
            按混合分数降序排列的搜索结果
        """
        if not query.strip():
            return []

        collection = self._get_collection()

        # 1. 生成 Dense 向量
        provider = get_default_embedding_provider()
        if provider is None:
            logger.warning("未配置 Embedding Provider，跳过向量搜索")
            return []

        dense_vec = await provider.embed_single(query)
        if dense_vec is None:
            return []

        # 2. 生成 Sparse 向量
        bm25 = self._get_bm25()
        sparse_vecs = bm25.encode_queries([query])
        sparse_vec = sparse_vecs[0] if sparse_vecs else {}

        # 3. 构建过滤表达式
        expr = None
        if kb_ids:
            kb_filter = ", ".join(f'"{kb_id}"' for kb_id in kb_ids)
            expr = f"kb_id in [{kb_filter}]"

        # 4. 混合搜索
        search_params = {
            "metric_type": "COSINE",
            "params": {"nprobe": 16},
        }

        try:
            from pymilvus import WeightedRanker, AnnSearchRequest

            dense_req = AnnSearchRequest(
                data=[dense_vec],
                anns_field="dense_vector",
                param=search_params,
                limit=top_k * 2,
                expr=expr,
            )
            sparse_req = AnnSearchRequest(
                data=[sparse_vec],
                anns_field="sparse_vector",
                param={"metric_type": "IP"},
                limit=top_k * 2,
                expr=expr,
            )

            ranker = WeightedRanker(DENSE_WEIGHT, SPARSE_WEIGHT)
            results = await run_milvus(
                collection.hybrid_search,
                reqs=[dense_req, sparse_req],
                rerank=ranker,
                limit=top_k,
                output_fields=["chunk_id", "kb_id", "content", "id"],
            )
        except Exception as e:
            logger.warning(f"混合搜索失败: {e}")
            return []

        if not results or not results[0]:
            return []

        # 5. 组装结果
        search_results = []
        for hit in results[0]:
            chunk_id = hit.entity.get("chunk_id")
            kb_id = hit.entity.get("kb_id")
            content = hit.entity.get("content", "")
            score = float(hit.score)

            # 从 PostgreSQL 补充 chunk_index 和 doc_id
            meta = await self._get_chunk_meta(chunk_id)
            search_results.append(
                KnowledgeSearchResult(
                    chunk_id=chunk_id,
                    doc_id=meta.get("doc_id", ""),
                    kb_id=kb_id,
                    content=content,
                    score=round(score, 4),
                    chunk_index=meta.get("chunk_index", 0),
                )
            )

        return search_results

    # ── LLM 重排序 ───────────────────────────────────────────

    async def search_with_rerank(
        self,
        query: str,
        kb_ids: Optional[list[str]] = None,
        top_k: int = 5,
        llm_provider_name: Optional[str] = None,
    ) -> list[KnowledgeSearchResult]:
        """混合搜索 + LLM 重排序：先用混合搜索召回候选，再用 LLM 精排。

        Args:
            query: 用户查询文本
            kb_ids: 限定知识库 ID 列表
            top_k: 最终返回数量
            llm_provider_name: LLM provider 名称（如 "openai"），不传则跳过重排序

        Returns:
            重排序后的搜索结果
        """
        # 召回阶段：多拉一些候选（top_k * 3）
        candidates = await self.search(query, kb_ids, top_k=top_k * 3)

        if not candidates or len(candidates) <= top_k:
            return candidates

        # 如果没有 LLM provider，直接返回混合搜索 top_k 结果
        if not llm_provider_name:
            return candidates[:top_k]

        # 重排序阶段
        try:
            reranked = await self._llm_rerank(query, candidates, top_k, llm_provider_name)
            if reranked:
                return reranked
        except Exception as e:
            logger.warning(f"LLM 重排序失败，降级到混合搜索结果: {e}")

        return candidates[:top_k]

    async def _llm_rerank(
        self,
        query: str,
        candidates: list[KnowledgeSearchResult],
        top_k: int,
        provider_name: str,
    ) -> Optional[list[KnowledgeSearchResult]]:
        """调用 LLM 对候选结果重新排序。"""
        from app.providers.registry import get_provider as get_llm_provider

        provider = get_llm_provider(provider_name)

        # 构建 LLM 输入：编号 + 内容
        candidate_texts = []
        for i, c in enumerate(candidates):
            candidate_texts.append(f"[{i}] {c.content[:800]}")

        user_message = f"查询：{query}\n\n候选文档：\n" + "\n\n".join(candidate_texts)

        # 非流式调用 LLM 做重排序
        from openai import AsyncOpenAI

        if provider_name == "openai" and settings.openai_api_key:
            client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
            )
            model = "gpt-4o-mini"
        else:
            client = AsyncOpenAI(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
            )
            model = "deepseek-chat"

        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": RERANK_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.1,
            max_tokens=500,
        )

        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        scores = json.loads(raw)
        if not isinstance(scores, list):
            return None

        # 按 LLM 分数重排
        reranked = []
        for item in scores:
            idx = item.get("index")
            new_score = item.get("score", 0)
            if idx is not None and 0 <= idx < len(candidates):
                c = candidates[idx]
                reranked.append(
                    KnowledgeSearchResult(
                        chunk_id=c.chunk_id,
                        doc_id=c.doc_id,
                        kb_id=c.kb_id,
                        content=c.content,
                        score=round(float(new_score), 4),
                        chunk_index=c.chunk_index,
                    )
                )

        reranked.sort(key=lambda x: x.score, reverse=True)
        return reranked[:top_k]

    # ── 辅助方法 ─────────────────────────────────────────────

    async def _get_chunk_meta(self, chunk_id: str) -> dict:
        """从 PostgreSQL 查询 chunk 的元数据（doc_id, chunk_index）。"""
        result = await self._db.execute(
            select(KnowledgeChunkModel).where(KnowledgeChunkModel.id == chunk_id)
        )
        chunk = result.scalars().first()
        if chunk:
            return {"doc_id": chunk.document_id, "chunk_index": chunk.chunk_index}
        return {}

    async def get_collection_stats(self) -> dict:
        """获取知识库集合统计信息。"""
        try:
            collection = self._get_collection()
            num_entities = await run_milvus(collection.num_entities)
            return {"collection": MILVUS_COLLECTION, "total_vectors": num_entities}
        except Exception as e:
            logger.warning(f"获取集合统计失败: {e}")
            return {"collection": MILVUS_COLLECTION, "total_vectors": 0}
