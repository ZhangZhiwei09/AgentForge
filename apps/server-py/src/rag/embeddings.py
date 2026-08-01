"""Embedding Provider —— 文本向量化抽象层。

Phase B: 提供 EmbeddingProvider Protocol + OpenAIEmbeddingProvider。
V1 只支持 OpenAI text-embedding-3-small（1536d），换模型需改 migration。
"""

import logging
from collections.abc import Awaitable
from typing import Protocol

from openai import AsyncOpenAI

from src.config import settings

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# Protocol
# ═══════════════════════════════════════════════════════════


class EmbeddingProvider(Protocol):
    """文本 Embedding 服务协议。

    所有 Embedding 实现（OpenAI / 本地模型 / 其他 API）必须实现此协议。
    """

    @property
    def dimensions(self) -> int:
        """Embedding 向量维度。"""
        ...

    def embed(self, texts: list[str]) -> Awaitable[list[list[float]]]:
        """对文本列表进行向量化。

        Args:
            texts: 文本列表（建议 batch ≤ 100）

        Returns:
            等长的向量列表，每个向量维度 = self.dimensions
        """
        ...


# ═══════════════════════════════════════════════════════════
# OpenAI Implementation
# ═══════════════════════════════════════════════════════════


class OpenAIEmbeddingProvider:
    """OpenAI Embedding 服务。

    使用 text-embedding-3-small 模型，1536 维向量。
    如果 embedding_api_key 为空，fallback 到 openai_api_key。
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ) -> None:
        """初始化 OpenAI Embedding Provider。

        Args:
            api_key: API Key，默认从 settings 读取
            base_url: API Base URL，默认从 settings 读取
            model: 模型名，默认 text-embedding-3-small
        """
        resolved_key = api_key or settings.embedding_api_key or settings.openai_api_key
        if not resolved_key:
            raise ValueError(
                "OpenAI Embedding API key not configured. "
                "Set EMBEDDING_API_KEY or OPENAI_API_KEY in .env"
            )

        self._model = model or settings.embedding_model
        self._dimensions = 1536  # text-embedding-3-small 固定维度

        self._client = AsyncOpenAI(
            api_key=resolved_key,
            base_url=base_url or settings.embedding_base_url,
        )

    @property
    def dimensions(self) -> int:
        return self._dimensions

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """对文本列表进行向量化。

        Args:
            texts: 文本列表（建议 batch ≤ 100）

        Returns:
            等长的向量列表，每个向量 1536 维
        """
        if not texts:
            return []

        try:
            response = await self._client.embeddings.create(
                model=self._model,
                input=texts,
            )
            # 按输入顺序返回
            return [item.embedding for item in response.data]

        except Exception as exc:
            logger.error("OpenAI Embedding failed: %s", exc)
            raise


# ═══════════════════════════════════════════════════════════
# 工厂函数
# ═══════════════════════════════════════════════════════════

_embedding_provider: EmbeddingProvider | None = None


def get_embedding_provider() -> EmbeddingProvider | None:
    """获取 Embedding Provider 实例（惰性初始化）。

    Returns:
        EmbeddingProvider 实例，或 None（当 API Key 未配置时）
    """
    global _embedding_provider
    if _embedding_provider is not None:
        return _embedding_provider

    resolved_key = settings.embedding_api_key or settings.openai_api_key
    if not resolved_key:
        logger.warning(
            "No embedding API key configured. "
            "Embedding features will be unavailable."
        )
        return None

    _embedding_provider = OpenAIEmbeddingProvider(
        api_key=resolved_key,
        base_url=settings.embedding_base_url,
        model=settings.embedding_model,
    )
    return _embedding_provider
