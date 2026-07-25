"""OpenAI Provider —— 封装 AsyncOpenAI，实现 LLMProvider 协议。

对应 TS: apps/server/src/providers/openai.ts

Python 新概念：async generator（async def + yield）
- 用 async for 迭代 OpenAI 的流式响应
- 用 yield 逐个产出 StreamChunk 给上层
- finally 块确保无论流正常结束还是中断，都 yield done 片段
"""

from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from src.schemas.chat import ChatMessage, ChatSyncResult, StreamChunk


class OpenAIProvider:
    """OpenAI LLM Provider，支持流式 token 输出 + function calling。

    虽然没有显式写 `class OpenAIProvider(LLMProvider)`，
    但它实现了 Protocol 定义的全部方法，自动满足 LLMProvider 协议。
    """

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1"):
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    # ---- 模型列表 ----
    def list_models(self) -> list[dict]:
        """返回 OpenAI 目前支持的模型列表。"""
        return [
            {"id": "gpt-4o", "name": "GPT-4o", "provider": "openai", "max_tokens": 128000},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "provider": "openai", "max_tokens": 128000},
            {"id": "gpt-4-turbo", "name": "GPT-4 Turbo", "provider": "openai", "max_tokens": 128000},
        ]

    # ---- 非流式聊天 ----
    async def chat_sync(
        self,
        messages: list[ChatMessage],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> ChatSyncResult:
        """非流式聊天 —— 用于记忆提取、结构化 JSON 输出等场景。

        Pydantic 序列化：model_dump(exclude_none=True)
        只会输出非 None 的字段，避免把 None 传给 OpenAI API。
        """
        full_messages: list[dict] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        for m in messages:
            full_messages.append(m.model_dump(exclude_none=True))

        params: dict = {
            "model": model,
            "messages": full_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            params["response_format"] = {"type": "json_object"}

        response = await self.client.chat.completions.create(**params)  # type: ignore[arg-type]

        return ChatSyncResult(
            content=response.choices[0].message.content.strip() or "",
            usage={
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
            },
        )

    # ---- 流式聊天 ----
    async def stream_chat(
        self,
        messages: list[ChatMessage],
        model: str,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[StreamChunk]:
        """流式聊天 —— async generator，逐个 yield StreamChunk。

        流程：
        1. 构建 full_messages（system prompt + 历史消息）
        2. 发起 stream=True 请求
        3. async for 迭代 OpenAI 的 SSE 流
        4. 每个 chunk 分析 delta.content / delta.tool_calls
        5. yield token / tool_call 片段
        6. finally 块 yield done（传递 token 用量）

        Python async generator 要点：
        - 函数体有 yield = 调用不执行，返回 async generator 对象
        - 上层用 async for 迭代时，每次迭代执行到下一个 yield
        - finally 在迭代结束或提前退出时执行（类似 TS 的 try/finally）
        """
        full_messages: list[dict] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        for m in messages:
            full_messages.append(m.model_dump(exclude_none=True))

        params: dict = {
            "model": model,
            "messages": full_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},  # 让最后一个 chunk 带 usage
        }

        stream = await self.client.chat.completions.create(**params)  # type: ignore[arg-type]

        prompt_tokens = 0
        completion_tokens = 0

        # Tool call 累加器 —— OpenAI 的 tool_calls 是分片到达的
        tool_call_acc: dict[int, dict] = {}

        try:
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None

                if delta is None:
                    continue

                # Handle tool call deltas — accumulate across chunks
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_call_acc:
                            tool_call_acc[idx] = {"id": "", "name": "", "arguments": ""}
                        acc = tool_call_acc[idx]
                        if tc.id:
                            acc["id"] = tc.id
                        if tc.function and tc.function.name:
                            acc["name"] += tc.function.name
                        if tc.function and tc.function.arguments:
                            acc["arguments"] += tc.function.arguments

                # Handle text content tokens
                if delta.content:
                    # Flush pending completed tool calls before yielding text
                    for idx, tc in list(tool_call_acc.items()):
                        if tc["name"] and tc["arguments"]:
                            yield StreamChunk(
                                type="tool_call",
                                tool_call={
                                    "id": tc["id"],
                                    "name": tc["name"],
                                    "arguments": tc["arguments"],
                                },
                            )
                            del tool_call_acc[idx]
                    yield StreamChunk(type="token", content=delta.content)

                # 部分 chunk 附带 usage 信息
                if chunk.usage:
                    prompt_tokens = chunk.usage.prompt_tokens or 0
                    completion_tokens = chunk.usage.completion_tokens or 0

            # Flush remaining tool calls at stream end
            for tc in tool_call_acc.values():
                if tc["name"]:
                    yield StreamChunk(
                        type="tool_call",
                        tool_call={
                            "id": tc["id"],
                            "name": tc["name"],
                            "arguments": tc["arguments"] or "{}",
                        },
                    )
        finally:
            # 无论流正常结束还是中断，都 yield done 片段
            yield StreamChunk(
                type="done",
                usage={
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            )
