from unittest.mock import AsyncMock

import httpx
import pytest
from openai import APIConnectionError

from src.providers.openai_provider import OpenAIProvider
from src.schemas.chat import ChatMessage


@pytest.mark.parametrize("streaming", [False, True])
async def test_connection_errors_identify_model_service_without_credentials(streaming):
    provider = OpenAIProvider(
        api_key="private-test-key",
        base_url="https://username:private-password@models.example.com/v1",
    )
    provider.client.chat.completions.create = AsyncMock(
        side_effect=APIConnectionError(
            request=httpx.Request("POST", "https://models.example.com/v1/chat/completions"),
        ),
    )
    messages = [ChatMessage(role="user", content="hello")]
    try:
        with pytest.raises(RuntimeError) as error:
            if streaming:
                async for _ in provider.stream_chat(messages, model="test-model"):
                    pass
            else:
                await provider.chat_sync(messages, model="test-model")
        message = str(error.value)
        assert "models.example.com" in message
        assert "test-model" in message
        assert "private" not in message
        assert "username" not in message
        assert isinstance(error.value.__cause__, APIConnectionError)
    finally:
        await provider.client.close()
