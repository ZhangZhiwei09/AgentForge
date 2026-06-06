from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    """嵌入模型抽象基类，参考 LLMProvider 设计模式。"""

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """将文本列表转为向量列表。

        Args:
            texts: 待向量化的文本列表

        Returns:
            向量列表，每个向量为 float 列表，长度等于 dimension
        """
        ...

    async def embed_single(self, text: str) -> list[float]:
        """将单个文本转为向量，默认复用 embed 方法。"""
        results = await self.embed([text])
        return results[0]

    @property
    @abstractmethod
    def dimension(self) -> int:
        """向量维度。"""
        ...

    @property
    @abstractmethod
    def model_name(self) -> str:
        """嵌入模型名称。"""
        ...