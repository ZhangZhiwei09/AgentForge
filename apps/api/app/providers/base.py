from abc import ABC, abstractmethod
from typing import AsyncGenerator


class LLMProvider(ABC):
    @abstractmethod
    async def stream_chat(
        self,
        messages: list[dict],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[dict, None]:
        """Yield chunks: {"type": "token", "content": str} or {"type": "done", "usage": dict}"""
        ...

    @abstractmethod
    def list_models(self) -> list[dict]:
        ...
