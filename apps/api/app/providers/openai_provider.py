from typing import AsyncGenerator
from openai import AsyncOpenAI
from app.providers.base import LLMProvider


class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1"):
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def list_models(self) -> list[dict]:
        return [
            {"id": "gpt-4o", "name": "GPT-4o", "provider": "openai", "max_tokens": 128000},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "provider": "openai", "max_tokens": 128000},
            {"id": "gpt-4-turbo", "name": "GPT-4 Turbo", "provider": "openai", "max_tokens": 128000},
        ]

    async def stream_chat(
        self,
        messages: list[dict],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[dict, None]:
        full_messages = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        full_messages.extend(messages)

        stream = await self.client.chat.completions.create(
            model=model,
            messages=full_messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )

        prompt_tokens = 0
        completion_tokens = 0

        try:
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    yield {"type": "token", "content": delta.content}
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens
        finally:
            yield {
                "type": "done",
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            }
