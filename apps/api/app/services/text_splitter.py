import re


class RecursiveCharacterTextSplitter:
    """递归字符文本分块器，无 langchain 依赖。

    按分隔符优先级递归切分文本，保证每块不超过 chunk_size 字符。
    """

    def __init__(
        self,
        chunk_size: int = 500,
        chunk_overlap: int = 50,
        separators: list[str] | None = None,
    ):
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap
        self._separators = separators or [
            "\n\n",
            "\n",
            ".",
            "！",
            "？",
            "；",
            ". ",
            "! ",
            "? ",
            "; ",
            " ",
            "",
        ]

    def split_text(self, text: str) -> list[str]:
        """将单个文本分割为块列表。"""
        if not text:
            return []
        return self._split_recursive(text, self._separators)

    def split_documents(
        self, documents: list[dict]
    ) -> list[dict]:
        """批量分割文档，返回带 chunk_index 的块列表。

        Args:
            documents: [{"id": "doc-1", "title": "...", "content": "..."}, ...]

        Returns:
            [{"doc_id": "doc-1", "title": "...", "chunk_index": 0, "content": "..."}, ...]
        """
        chunks = []
        for doc in documents:
            texts = self.split_text(doc["content"])
            for i, chunk_text in enumerate(texts):
                chunks.append({
                    "doc_id": doc["id"],
                    "title": doc.get("title", ""),
                    "chunk_index": i,
                    "content": chunk_text,
                })
        return chunks

    def _split_recursive(self, text: str, separators: list[str]) -> list[str]:
        """递归分割核心逻辑。"""
        if not separators:
            return self._force_split(text)

        sep = separators[0]
        remaining = separators[1:]

        if sep == "":
            return self._force_split(text)

        splits = self._split_by_separator(text, sep)

        chunks = []
        current = ""
        for split_text in splits:
            if not split_text:
                continue
            if not current:
                current = split_text
                continue

            combined = current + sep + split_text
            if len(combined) <= self._chunk_size:
                current = combined
            else:
                if len(current) <= self._chunk_size:
                    chunks.append(current)
                else:
                    chunks.extend(self._split_recursive(current, remaining))
                current = split_text

        if current:
            if len(current) <= self._chunk_size:
                chunks.append(current)
            else:
                chunks.extend(self._split_recursive(current, remaining))

        return self._merge_overlap(chunks)

    def _force_split(self, text: str) -> list[str]:
        """无可用的分隔符时，按字符数硬切。"""
        chunks = []
        start = 0
        while start < len(text):
            end = min(start + self._chunk_size, len(text))
            chunks.append(text[start:end])
            start = end - self._chunk_overlap
            if start >= end:
                break
        return chunks

    def _split_by_separator(self, text: str, sep: str) -> list[str]:
        """按分隔符分割文本，保留分隔符两边的片段。"""
        pattern = re.escape(sep)
        parts = re.split(f"({pattern})", text)
        result = []
        for i, part in enumerate(parts):
            if part == sep:
                continue
            result.append(part)
        return result

    def _merge_overlap(self, chunks: list[str]) -> list[str]:
        """为相邻块添加内容重叠。"""
        if self._chunk_overlap <= 0 or len(chunks) <= 1:
            return chunks

        merged = []
        for i, chunk in enumerate(chunks):
            if i == 0:
                merged.append(chunk)
                continue

            prev = chunks[i - 1]
            overlap_text = prev[-self._chunk_overlap:] if len(prev) > self._chunk_overlap else prev

            if len(overlap_text + chunk) <= self._chunk_size:
                merged.append(overlap_text + chunk)
            else:
                merged.append(chunk)

        return merged
