"""RAG 模块 —— 检索增强生成。

Phase B: pgvector 语义搜索 + 文档摄入管道。
"""

from src.rag.embeddings import (
    EmbeddingProvider,
    OpenAIEmbeddingProvider,
    get_embedding_provider,
)
from src.rag.ingestion import ingest_document
from src.rag.pgvector import PgVectorKnowledgeService, get_knowledge_service
from src.rag.splitter import RecursiveTokenTextSplitter, estimate_tokens
from src.rag.types import (
    HybridSearchParams,
    KnowledgeSearchResult,
    KnowledgeService,
    NoopKnowledgeService,
)

__all__ = [
    # types
    "KnowledgeSearchResult",
    "HybridSearchParams",
    "KnowledgeService",
    "NoopKnowledgeService",
    # embeddings
    "EmbeddingProvider",
    "OpenAIEmbeddingProvider",
    "get_embedding_provider",
    # splitter
    "RecursiveTokenTextSplitter",
    "estimate_tokens",
    # pgvector
    "PgVectorKnowledgeService",
    "get_knowledge_service",
    # ingestion
    "ingest_document",
]
