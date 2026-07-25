"""LLM Provider 抽象协议 —— 所有 LLM 厂商必须实现此接口。

对应 TS: apps/server/src/providers/types.ts

Python 的 Protocol 等价于 TS 的 interface：
- 只定义方法签名，不写实现
- 不需要显式继承，只要类有相同签名的方法就自动满足（duck typing）
- @runtime_checkable 允许 isinstance() 检查
"""

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from src.schemas.chat import ChatMessage, ChatSyncResult, StreamChunk


@runtime_checkable
class LLMProvider(Protocol):
    """LLM Provider 协议——定义流式/同步聊天 + 模型列表的契约。

    所有 Provider（OpenAI、DeepSeek 等）必须实现这三个方法。
    runtime_checkable 允许 isinstance(obj, LLMProvider) 检查，方便调试。
    """

    def stream_chat(
        self,
        messages: list[ChatMessage],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[StreamChunk]:
        """流式聊天，逐个 yield token/tool_call/done 片段。

        返回 AsyncIterator 而非 AsyncGenerator：
        Protocol 不关心是 async def yield 还是手动实现 __aiter__/__anext__，
        只要返回一个异步迭代器即可。
        """
        ...

    async def chat_sync(
        self,
        messages: list[ChatMessage],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> ChatSyncResult:
        """非流式聊天，返回完整结果。

        用于记忆提取、Rerank、结构化 JSON 输出等需要完整响应的场景。
        """
        ...

    def list_models(self) -> list[dict]:
        """返回该厂商支持的模型列表。

        每个 dict 包含：id, name, provider, max_tokens。
        """
        ...
