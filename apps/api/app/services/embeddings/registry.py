from app.config import settings
from app.services.embeddings.base import EmbeddingProvider
from app.services.embeddings.openai_embedding import OpenAIEmbeddingProvider


_providers: dict[str, EmbeddingProvider] = {}
_initialized = False


def _init_providers() -> None:
    global _providers, _initialized
    if _initialized:
        return

    if settings.openai_api_key:
        _providers["openai"] = OpenAIEmbeddingProvider(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.embedding_model,
        )

    _initialized = True


def init_embedding_providers() -> None:
    """显式初始化（供 lifespan 启动时调用）。"""
    _init_providers()


def get_embedding_provider(name: str) -> EmbeddingProvider:
    _init_providers()
    if name not in _providers:
        raise ValueError(f"Embedding provider '{name}' not found. Available: {list(_providers.keys())}")
    return _providers[name]


def get_default_embedding_provider() -> EmbeddingProvider | None:
    _init_providers()
    if not _providers:
        return None
    return next(iter(_providers.values()))


def list_embedding_providers() -> list[dict]:
    _init_providers()
    return [
        {"name": name, "model": p.model_name, "dimension": p.dimension}
        for name, p in _providers.items()
    ]


class EmbeddingRegistry:
    """Embedding 提供者注册中心（OOP 封装）。"""

    @staticmethod
    def get(name: str) -> EmbeddingProvider:
        return get_embedding_provider(name)

    @staticmethod
    def get_default() -> EmbeddingProvider | None:
        return get_default_embedding_provider()

    @staticmethod
    def list_all() -> list[dict]:
        return list_embedding_providers()