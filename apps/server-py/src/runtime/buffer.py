"""OutputBuffer —— 纯输出缓冲，无持久化，无生命周期。

对应 TS: apps/server/src/runtime/buffer.ts

被 Chat / Voice / Workflow / AgentTrace 等所有流式场景复用。
V2 预留：泛型 OutputBuffer[T] 支持结构化输出。

Python 新概念：
- 简单的 class 封装字符串拼接，TS 的 getter → Python 的 @property
"""


class OutputBuffer:
    """输出缓冲区，收集流式输出的所有 token。"""

    def __init__(self) -> None:
        self._content = ""

    def append(self, token: str) -> None:
        """追加输出片段（token / chunk / step）。"""
        self._content += token

    def get_content(self) -> str:
        """获取完整输出内容。"""
        return self._content

    def clear(self) -> None:
        """清空缓冲区。"""
        self._content = ""

    @property
    def is_empty(self) -> bool:
        """缓冲区是否为空。类似 TS 的 get isEmpty()。"""
        return len(self._content) == 0

    def __len__(self) -> int:
        """支持 len(buffer)。"""
        return len(self._content)

    def __str__(self) -> str:
        """支持 str(buffer) / print(buffer)。"""
        return self._content
