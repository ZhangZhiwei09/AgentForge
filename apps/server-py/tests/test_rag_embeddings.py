"""测试：Embedding Provider。"""

import pytest

from src.rag.embeddings import get_embedding_provider


class TestEmbeddingProviderFactory:
    """Embedding Provider 工厂测试。"""

    def test_get_provider_without_key_returns_none(self, monkeypatch):
        """无 API Key 时应返回 None。"""
        # 直接修改 settings 对象（monkeypatch.setenv 不影响已加载的 pydantic-settings）
        monkeypatch.setattr(
            "src.rag.embeddings.settings.openai_api_key", ""
        )
        monkeypatch.setattr(
            "src.rag.embeddings.settings.embedding_api_key", ""
        )
        # 清除缓存
        import src.rag.embeddings as emb
        emb._embedding_provider = None

        provider = get_embedding_provider()
        assert provider is None


class TestOpenAIEmbeddingProvider:
    """OpenAI Embedding Provider 测试。"""

    def test_dimensions(self):
        """维度应为 1536（text-embedding-3-small）。"""
        from src.rag.embeddings import OpenAIEmbeddingProvider
        # 使用 fake key 创建实例，不实际调用 API
        provider = OpenAIEmbeddingProvider(
            api_key="sk-test-fake-key",
            base_url="https://api.openai.com/v1",
        )
        assert provider.dimensions == 1536
