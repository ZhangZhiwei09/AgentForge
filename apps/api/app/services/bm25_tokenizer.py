"""BM25 稀疏向量生成器。

使用 Milvus 2.4+ 内置的 BM25EmbeddingFunction 生成稀疏向量。
文档入库时需先训练（fit 语料），查询时动态编码。
"""

import logging

logger = logging.getLogger(__name__)


class BM25SparseEncoder:
    """BM25 稀疏向量编码器，基于 pymilvus 内置 BM25EmbeddingFunction。"""

    def __init__(self):
        self._bm25 = None
        self._fitted = False

    def _get_bm25(self):
        """懒初始化 BM25EmbeddingFunction。"""
        if self._bm25 is None:
            from pymilvus.model.sparse import BM25EmbeddingFunction

            self._bm25 = BM25EmbeddingFunction()
        return self._bm25

    def fit(self, corpus: list[str]) -> None:
        """在文档语料上训练 BM25。

        Args:
            corpus: 文档文本列表（用于构建词频统计）
        """
        if not corpus:
            return
        try:
            bm25 = self._get_bm25()
            bm25.fit(corpus)
            self._fitted = True
            logger.info(f"BM25 训练完成，语料规模: {len(corpus)} 条")
        except Exception as e:
            logger.warning(f"BM25 训练失败: {e}")
            self._fitted = False

    def encode_documents(self, docs: list[str]) -> list[dict]:
        """编码文档为稀疏向量（用于入库）。

        Args:
            docs: 文档文本列表

        Returns:
            稀疏向量字典列表，每个字典包含非零维度和值
        """
        if not self._fitted:
            return [{} for _ in docs]
        try:
            bm25 = self._get_bm25()
            return bm25.encode_documents(docs)
        except Exception as e:
            logger.warning(f"BM25 文档编码失败: {e}")
            return [{} for _ in docs]

    def encode_queries(self, queries: list[str]) -> list[dict]:
        """编码查询为稀疏向量（用于搜索）。

        Args:
            queries: 查询文本列表

        Returns:
            稀疏向量字典列表
        """
        if not self._fitted:
            return [{} for _ in queries]
        try:
            bm25 = self._get_bm25()
            return bm25.encode_queries(queries)
        except Exception as e:
            logger.warning(f"BM25 查询编码失败: {e}")
            return [{} for _ in queries]

    @classmethod
    def fit_on_corpus(cls, corpus: list[str]) -> "BM25SparseEncoder":
        """工厂方法：创建编码器并在语料上训练。"""
        encoder = cls()
        encoder.fit(corpus)
        return encoder
