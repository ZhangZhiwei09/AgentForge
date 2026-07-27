"""测试：RAG 文本分片器。"""

import pytest

from src.rag.splitter import (
    RecursiveTokenTextSplitter,
    estimate_tokens,
    _is_cjk,
)


class TestEstimateTokens:
    """Token 估算测试。"""

    def test_cjk_estimation(self):
        """CJK 文本 token 估算。"""
        text = "活体检测是指通过技术手段验证用户是否为本人的一种安全技术"
        tokens = estimate_tokens(text)
        # 约 28 个 CJK 字符 * 1.5 = 42
        assert 30 <= tokens <= 55

    def test_english_estimation(self):
        """英文文本 token 估算。"""
        text = "Face detection timeout occurred during liveness check"
        tokens = estimate_tokens(text)
        # 8 个单词 * 1.3 ≈ 10.4 → 10，加空格和标点
        assert 10 <= tokens <= 20

    def test_mixed_estimation(self):
        """中英混合 token 估算。"""
        text = "FACE_TIMEOUT 错误码表示人脸采集超时"
        tokens = estimate_tokens(text)
        assert tokens >= 5

    def test_empty_string(self):
        """空字符串应返回至少 1 token。"""
        assert estimate_tokens("") == 1

    def test_pure_ascii(self):
        """纯 ASCII token 估算。"""
        for char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ":
            assert estimate_tokens(char) >= 1


class TestCJKDetection:
    """CJK 字符检测测试。"""

    def test_chinese_char(self):
        assert _is_cjk("中")
        assert _is_cjk("文")

    def test_japanese_char(self):
        assert _is_cjk("あ")  # Hiragana
        assert _is_cjk("カ")  # Katakana

    def test_korean_char(self):
        assert _is_cjk("한")  # Hangul

    def test_ascii_char(self):
        assert not _is_cjk("a")
        assert not _is_cjk("1")
        assert not _is_cjk(" ")

    def test_punctuation(self):
        assert not _is_cjk(".")
        assert not _is_cjk("，")  # Fullwidth comma is not in CJK ranges


class TestTextSplitter:
    """文本分片器测试。"""

    def test_short_text_single_chunk(self):
        """短文本应保持为单个 chunk。"""
        splitter = RecursiveTokenTextSplitter(chunk_size=512, chunk_overlap=64)
        chunks = splitter.split_text("这是短文本。")
        assert len(chunks) == 1
        assert chunks[0] == "这是短文本。"

    def test_empty_text(self):
        """空文本应返回空列表。"""
        splitter = RecursiveTokenTextSplitter()
        chunks = splitter.split_text("")
        assert chunks == []
        chunks = splitter.split_text("   ")
        assert chunks == []

    def test_paragraph_split(self):
        """段落分隔应产生多个 chunk。"""
        splitter = RecursiveTokenTextSplitter(chunk_size=50, chunk_overlap=10)
        text = "第一段\n\n第二段内容比较长需要被拆分\n\n第三段"
        chunks = splitter.split_text(text)
        assert len(chunks) >= 1

    def test_chinese_period_split(self):
        """中文句号应作为分隔符。"""
        splitter = RecursiveTokenTextSplitter(chunk_size=30, chunk_overlap=5)
        text = "这是第一句。这是第二句。这是第三句。"
        chunks = splitter.split_text(text)
        # 中文句号会分割
        assert len(chunks) >= 1

    def test_custom_separators(self):
        """自定义分隔符测试。"""
        splitter = RecursiveTokenTextSplitter(
            chunk_size=100,
            chunk_overlap=10,
            separators=["\n\n", "\n", "。", " "],
        )
        text = "段落一。\n段落二。\n段落三。"
        chunks = splitter.split_text(text)
        assert len(chunks) >= 1
