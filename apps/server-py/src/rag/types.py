"""RAG（检索增强生成）模块 —— 知识库检索抽象。

对应 TS: apps/server/src/services/knowledge.ts

设计要点：
- 定义知识库检索的抽象协议，不绑定具体基础设施
- V1: 提供类型定义 + 协议接口，Step 11+ 实现真实向量检索
- KnowledgeService Protocol: search() 核心方法

Python 新概念：
- Protocol: 定义抽象服务接口，类似 TS interface + abstract class
"""

from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Protocol


# ═══════════════════════════════════════════════════════════
# 类型定义
# ═══════════════════════════════════════════════════════════


@dataclass(slots=True)
class KnowledgeSearchResult:
    """知识库单条检索结果。

    Attributes:
        chunk_id: 分片 ID
        doc_id: 文档 ID
        kb_id: 知识库 ID
        content: 分片文本内容
        score: 相关度分数
        chunk_index: 分片在文档中的序号
        doc_title: 文档标题
    """
    chunk_id: str = ""
    doc_id: str = ""
    kb_id: str = ""
    content: str = ""
    score: float = 0.0
    chunk_index: int = 0
    doc_title: str = ""


@dataclass(slots=True)
class HybridSearchParams:
    """混合搜索参数。

    Attributes:
        query: 搜索查询
        kb_ids: 限制搜索的知识库 ID 列表（None=全部）
        top_k: 返回结果数
        use_reranker: 是否启用重排序
    """
    query: str
    kb_ids: list[str] | None = None
    top_k: int = 5
    use_reranker: bool = True


# ═══════════════════════════════════════════════════════════
# 服务协议
# ═══════════════════════════════════════════════════════════


class KnowledgeService(Protocol):
    """知识库检索服务协议。

    所有知识库检索实现（Elasticsearch、PGVector、Milvus 等）
    必须实现此协议。
    """

    def search(
        self,
        query: str,
        kb_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> Awaitable[list[KnowledgeSearchResult]]:
        """语义搜索知识库。

        Args:
            query: 搜索查询（自然语言）
            kb_ids: 限制知识库（None=全部）
            top_k: 返回结果数

        Returns:
            按相关度降序排列的搜索结果列表
        """
        ...

    def hybrid_search(
        self,
        params: HybridSearchParams,
    ) -> Awaitable[list[KnowledgeSearchResult]]:
        """混合搜索（语义 + 关键词 + RRF 融合）。

        Args:
            params: 搜索参数

        Returns:
            融合重排后的搜索结果列表
        """
        ...


# ═══════════════════════════════════════════════════════════
# 空实现（Noop）—— 无知识库时使用
# ═══════════════════════════════════════════════════════════


class NoopKnowledgeService:
    """空知识库服务 —— 无配置时返回空结果。"""

    async def search(
        self,
        query: str,
        kb_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> list[KnowledgeSearchResult]:
        return []

    async def hybrid_search(
        self,
        params: HybridSearchParams,
    ) -> list[KnowledgeSearchResult]:
        return []
