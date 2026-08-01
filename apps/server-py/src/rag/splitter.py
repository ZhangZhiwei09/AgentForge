"""RecursiveTokenTextSplitter —— CJK 启发式 token 估算的递归文本分片器。

对应 LangChain RecursiveCharacterTextSplitter，但使用 token 计数替代字符计数。
CJK 文本的 token 估算规则：
    - CJK 字符（汉字/日文/韩文）：约 1.5 token/字符
    - ASCII 单词：约 1.3 token/单词
    - 数字/标点：1 token/字符
"""

import re
from collections.abc import Sequence

from src.config import settings

# ── 分隔符优先级（从大到小）──
DEFAULT_SEPARATORS = [
    "\n\n",    # 段落
    "\n",      # 行
    "。",      # 中文句号
    "；",      # 中文分号
    "，",      # 中文逗号
    ". ",      # 英文句号
    "; ",      # 英文分号
    ", ",      # 英文逗号
    " ",       # 空格
    "",        # 字符级
]

# CJK Unicode 范围
CJK_RANGES = [
    (0x4E00, 0x9FFF),    # CJK Unified Ideographs
    (0x3400, 0x4DBF),    # CJK Unified Ideographs Extension A
    (0x20000, 0x2A6DF),  # CJK Unified Ideographs Extension B
    (0x2A700, 0x2B73F),  # CJK Unified Ideographs Extension C
    (0x2B740, 0x2B81F),  # CJK Unified Ideographs Extension D
    (0x2B820, 0x2CEAF),  # CJK Unified Ideographs Extension E
    (0xF900, 0xFAFF),    # CJK Compatibility Ideographs
    (0x2F800, 0x2FA1F),  # CJK Compatibility Ideographs Supplement
    (0x3040, 0x309F),    # Hiragana
    (0x30A0, 0x30FF),    # Katakana
    (0xAC00, 0xD7AF),    # Hangul Syllables
]


def _is_cjk(char: str) -> bool:
    """判断单字符是否属于 CJK 范围。"""
    cp = ord(char)
    return any(low <= cp <= high for low, high in CJK_RANGES)


def estimate_tokens(text: str) -> int:
    """CJK 启发式 token 估算。

    规则：
        - CJK 字符: ~1.5 tokens/char
        - ASCII 单词: ~1.3 tokens/word
        - 其他（数字/标点等）: ~1 token/char

    注意：ASCII 单词内的字母不计入 other，避免双重计数。

    Args:
        text: 输入文本

    Returns:
        估算的 token 数（向上取整）
    """
    cjk_chars = 0
    other = 0

    # 统计 CJK 字符 + 非字母 ASCII 字符
    for char in text:
        if _is_cjk(char):
            cjk_chars += 1
        elif char.isspace():
            other += 1
        elif ord(char) < 128 and not char.isalpha():
            # 数字、标点等非字母 ASCII
            other += 1
        elif ord(char) >= 128:
            # 非 ASCII 非 CJK 字符
            other += 1
        # ASCII 字母不计入 other（由 ascii_words 统计）

    # 统计 ASCII 单词数：移除 CJK 字符后按空格分词
    ascii_only = re.sub(
        r"[一-鿿㐀-䶿豈-﫿"
        r"぀-ゟ゠-ヿ가-힯]", " ", text
    )
    ascii_words = len([w for w in ascii_only.split() if w.strip()])

    # 估算
    estimated = (cjk_chars * 1.5) + (ascii_words * 1.3) + other
    return max(1, round(estimated))


def _split_by_separator(text: str, separator: str) -> list[str]:
    """按分隔符分割文本，保留分隔符。"""
    if not separator:
        # 字符级分割
        return list(text)

    # 分割并保留分隔符
    parts = text.split(separator)
    # 在每个非末尾部分后加回分隔符
    result: list[str] = []
    for i, part in enumerate(parts):
        if i > 0:
            result.append(separator + part)
        else:
            result.append(part)
    return [p for p in result if p]  # 过滤空字符串


class RecursiveTokenTextSplitter:
    """递归 token 文本分片器。

    用法:
        splitter = RecursiveTokenTextSplitter(chunk_size=512, chunk_overlap=64)
        chunks = splitter.split_text("长文本...")
    """

    def __init__(
        self,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
        separators: Sequence[str] | None = None,
    ) -> None:
        """初始化分片器。

        Args:
            chunk_size: 每个 chunk 的目标 token 数
            chunk_overlap: chunk 之间的重叠 token 数
            separators: 分隔符优先级列表（从大到小）
        """
        self._chunk_size = chunk_size or settings.chunk_size_tokens
        self._chunk_overlap = chunk_overlap or settings.chunk_overlap_tokens
        self._separators = list(separators) if separators else DEFAULT_SEPARATORS

    def split_text(self, text: str) -> list[str]:
        """将文本分割为 chunk 列表。

        Args:
            text: 输入文本

        Returns:
            按 token 估算分割的 chunk 列表
        """
        if not text.strip():
            return []

        chunks = self._split_recursive(text, self._separators)
        return self._merge_chunks(chunks)

    def _split_recursive(self, text: str, separators: list[str]) -> list[str]:
        """递归分割：按分隔符优先级逐级拆分。"""
        if not separators:
            return [text]

        separator = separators[0]
        remaining_separators = separators[1:]

        # 如果当前分隔符不在文本中，跳到下一级
        if separator and separator not in text:
            return self._split_recursive(text, remaining_separators)

        parts = _split_by_separator(text, separator)

        result: list[str] = []
        for part in parts:
            if estimate_tokens(part) <= self._chunk_size:
                result.append(part)
            else:
                # 该部分仍然太大，用下一级分隔符继续拆分
                result.extend(
                    self._split_recursive(part, remaining_separators)
                )

        return result

    def _merge_chunks(self, chunks: list[str]) -> list[str]:
        """合并过小的 chunk，同时确保每个 chunk 不超过 chunk_size。"""
        if not chunks:
            return []

        merged: list[str] = []
        current = ""

        for chunk in chunks:
            combined = current + chunk if current else chunk
            if estimate_tokens(combined) <= self._chunk_size:
                current = combined
            else:
                if current:
                    merged.append(current)
                current = chunk

        if current:
            merged.append(current)

        return merged
