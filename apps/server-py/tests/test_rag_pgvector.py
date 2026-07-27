"""测试：PgVectorKnowledgeService。

当 pgvector 禁用或无数据库时，应优雅降级。
"""

import pytest

from src.config import settings
from src.rag.pgvector import PgVectorKnowledgeService, get_knowledge_service
from src.rag.types import NoopKnowledgeService


class TestPgVectorKnowledgeService:
    """PgVector 知识库服务测试。"""

    @pytest.mark.asyncio
    async def test_search_when_disabled_returns_empty(self, monkeypatch):
        """pgvector 禁用时应返回空结果。"""
        monkeypatch.setattr(settings, "pgvector_enabled", False)
        svc = PgVectorKnowledgeService(session_factory=None)
        results = await svc.search("测试查询")
        assert results == []

    @pytest.mark.asyncio
    async def test_hybrid_search_delegates_to_search(self, monkeypatch):
        """hybrid_search 应委托给 search。"""
        monkeypatch.setattr(settings, "pgvector_enabled", False)
        svc = PgVectorKnowledgeService(session_factory=None)

        from src.rag.types import HybridSearchParams

        params = HybridSearchParams(query="测试", top_k=3)
        results = await svc.hybrid_search(params)
        assert results == []


class TestGetKnowledgeService:
    """get_knowledge_service 工厂测试。"""

    def test_returns_singleton(self):
        """应返回单例。"""
        # 清除缓存
        import src.rag.pgvector as pgv
        pgv._knowledge_service = None

        svc1 = get_knowledge_service()  # 使用默认 session factory
        svc2 = get_knowledge_service()
        assert svc1 is svc2
