from app.providers.registry import get_provider, resolve_model

CUSTOMER_SERVICE_PROMPT = """
你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。
"""


class CustomerChatService:

    def __init__(self, model_id: str | None = None):
        self.model_id = model_id

    async def stream_chat(self, user_message: str):
        """Stream a customer service chat response."""
        provider_name, resolved_model = resolve_model(self.model_id)
        provider = get_provider(provider_name)

        messages = [
            {"role": "user", "content": user_message}
        ]

        async for chunk in provider.stream_chat(
            messages=messages,
            model=resolved_model,
            system_prompt=CUSTOMER_SERVICE_PROMPT,
        ):
            yield chunk  # {"type": "token", "content": "字"} 或 {"type": "done", ...}