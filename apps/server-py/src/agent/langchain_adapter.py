"""ProviderChatModel —— 包装现有 LLMProvider 的 LangChain BaseChatModel 适配器。

此适配器让 LangGraph 的 StateGraph / ToolNode / astream_events() 可以直接
复用现有的 Provider 层（OpenAI / DeepSeek 等），无需引入 langchain-openai。

核心要点：
- 只实现 _agenerate 和 _astream 两个 async 方法
- _generate（sync）委托给 _agenerate 的 asyncio.run()
- 工具定义通过 kwargs["tools"] 透传（已是 OpenAI function calling 格式）
- Tool calls 在流式响应中正确累积并转换为 LangChain ToolCall 格式
"""

import asyncio
import json as _json
import logging
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.messages.ai import UsageMetadata
from langchain_core.messages.tool import ToolCall
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from src.schemas.chat import ChatMessage

logger = logging.getLogger(__name__)


class ProviderChatModel(BaseChatModel):
    """LangChain BaseChatModel 适配器，包装现有 LLMProvider。

    用法:
        provider = get_provider("openai")
        model = ProviderChatModel(
            provider=provider,
            model_name="gpt-4o-mini",
            temperature=0.7,
            max_tokens=4096,
        )
        # 用于 LangGraph StateGraph:
        graph = StateGraph(AgentState)
        graph.add_node("agent", agent_node)
        ...
        # 流式执行:
        async for event in graph.astream_events(initial_state, version="v2"):
            ...
    """

    # ── 公开字段（LangChain 通过 model_fields 自动识别）──
    provider: Any = None  # LLMProvider 实例（Any 避免 Pydantic 类型检查问题）
    model_name: str = ""
    temperature: float = 0.7
    max_tokens: int = 4096
    system_prompt: str = ""

    def __init__(
        self,
        provider: Any,
        model_name: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str = "",
        **kwargs: Any,
    ) -> None:
        """初始化适配器。

        Args:
            provider: LLMProvider 实例（实现 src.providers.base.LLMProvider 协议）
            model_name: 模型 ID，如 "gpt-4o-mini"
            temperature: 生成温度
            max_tokens: 最大输出 token
            system_prompt: 系统提示词（可选，通过 kwargs 传入）
        """
        super().__init__(**kwargs)
        # 使用 object.__setattr__ 绕过 Pydantic 的验证（provider 类型为 Any）
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "model_name", model_name)
        object.__setattr__(self, "temperature", temperature)
        object.__setattr__(self, "max_tokens", max_tokens)
        object.__setattr__(self, "system_prompt", system_prompt)

    # ── 标识属性 ──────────────────────────────────────────

    @property
    def _llm_type(self) -> str:
        """LangChain 模型类型标识。"""
        return "provider_chat"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        """模型标识参数（用于 LangSmith / 调试）。"""
        return {
            "provider_type": type(self.provider).__name__,
            "model_name": self.model_name,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }

    # ── Sync Generate（委托给 async）──────────────────────

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        """同步生成 —— 委托给 _agenerate。

        注：在实际使用中（FastAPI + LangGraph），始终走 async 路径。
        此方法仅为 LangChain 的同步兼容性保留。
        """
        try:
            loop = asyncio.get_running_loop()
            # 在 async 上下文中被同步调用 —— 不推荐但提供降级路径
            logger.warning(
                "ProviderChatModel._generate() called from async context — "
                "this creates a new event loop and may cause issues. "
                "Use ainvoke() or astream() instead."
            )
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(
                    asyncio.run,
                    self._agenerate(messages, stop, None, **kwargs),
                )
                return future.result(timeout=120)
        except RuntimeError:
            # 无运行中的 event loop —— 安全使用 asyncio.run()
            return asyncio.run(
                self._agenerate(messages, stop, None, **kwargs)
            )

    # ── Async Generate ─────────────────────────────────────

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        """异步非流式生成。

        通过收集 _astream 的全部输出来实现，确保 tool_calls 被正确捕获。
        """
        chunks: list[ChatGenerationChunk] = []
        async for chunk in self._astream(messages, stop, run_manager, **kwargs):
            chunks.append(chunk)

        # 聚合所有 chunk 为最终 AIMessage
        if not chunks:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=""))])

        # LangChain 的 chunk 聚合：最后一个 chunk 的 message 是完整结果
        # 我们需要手动合并 content 和 tool_calls
        content_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        usage: UsageMetadata | None = None

        for chunk in chunks:
            msg = chunk.message
            if msg.content:
                content_parts.append(_coerce_to_str(msg.content))
            if msg.tool_calls:
                tool_calls = list(msg.tool_calls)
            if msg.tool_call_chunks and not tool_calls:
                # 从增量 chunk 重建（兜底）
                tool_calls = _rebuild_tool_calls_from_chunks(msg.tool_call_chunks)
            if msg.usage_metadata:
                usage = msg.usage_metadata
            # response_metadata 合并
            if msg.response_metadata:
                pass  # 保留最后一个

        final_content = "".join(content_parts)
        # langchain_core 1.5.1 下 AIMessage(tool_calls=None) 触发 pydantic
        # ValidationError（tool_calls 必须是 list）。空 list 语义等价且合法。
        final_message = AIMessage(
            content=final_content,
            tool_calls=tool_calls,
            usage_metadata=usage,
        )

        return ChatResult(
            generations=[ChatGeneration(message=final_message)],
            llm_output=(
                {"usage": {
                    "input_tokens": usage["input_tokens"],
                    "output_tokens": usage["output_tokens"],
                    "total_tokens": usage["total_tokens"],
                }}
                if usage
                else None
            ),
        )

    # ── Async Stream ───────────────────────────────────────

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        """异步流式生成 —— 核心方法。

        从 LLMProvider.stream_chat() 获取 StreamChunk，转换为 LangChain 的
        ChatGenerationChunk 流。

        流式策略（对应 Phase A 设计）：
        - token → AIMessageChunk(content=text) → 实时流式
        - tool_call → 内部累积，流结束时作为带 tool_calls 的 chunk 产出
        - done → 产出 usage_metadata
        """
        provider_msgs = self._to_provider_messages(messages)
        tools = kwargs.get("tools")  # OpenAI function calling 格式，直接透传

        accumulated_tool_calls: list[dict] = []
        prompt_tokens = 0
        completion_tokens = 0

        async for chunk in self.provider.stream_chat(
            messages=provider_msgs,
            model=self.model_name,
            system_prompt=self.system_prompt,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            tools=tools,
        ):
            if chunk.type == "token" and chunk.content:
                # 实时文本 token → 立即 yield
                if run_manager:
                    await run_manager.on_llm_new_token(chunk.content)
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content=chunk.content),
                )

            elif chunk.type == "tool_call" and chunk.tool_call:
                # 累积完整的 tool_call（Provider 已做跨 chunk 拼接）
                accumulated_tool_calls.append(chunk.tool_call)

            elif chunk.type == "done":
                if chunk.usage:
                    prompt_tokens = chunk.usage.get("prompt_tokens", 0)
                    completion_tokens = chunk.usage.get("completion_tokens", 0)

        # ── 流结束：产出累积的 tool_calls + usage ──
        if accumulated_tool_calls:
            lc_tool_calls: list[ToolCall] = []
            for tc in accumulated_tool_calls:
                try:
                    args = _json.loads(tc.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}
                lc_tool_calls.append(
                    ToolCall(
                        name=tc.get("name", ""),
                        args=args,
                        id=tc.get("id"),
                    )
                )

            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_calls=lc_tool_calls,
                    usage_metadata=UsageMetadata(
                        input_tokens=prompt_tokens,
                        output_tokens=completion_tokens,
                        total_tokens=prompt_tokens + completion_tokens,
                    ) if prompt_tokens or completion_tokens else None,
                ),
            )
        elif prompt_tokens or completion_tokens:
            # 无 tool_calls 但有 usage → 产出 usage-only chunk
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    usage_metadata=UsageMetadata(
                        input_tokens=prompt_tokens,
                        output_tokens=completion_tokens,
                        total_tokens=prompt_tokens + completion_tokens,
                    ),
                ),
            )

    # ── 消息转换辅助方法 ───────────────────────────────────

    @staticmethod
    def _to_provider_messages(messages: list[BaseMessage]) -> list[ChatMessage]:
        """将 LangChain BaseMessage 列表转为 Provider 的 ChatMessage 列表。

        转换规则：
        - SystemMessage → ChatMessage(role="system")
        - HumanMessage  → ChatMessage(role="user")
        - AIMessage     → ChatMessage(role="assistant", tool_calls=[...])
        - ToolMessage   → ChatMessage(role="tool", tool_call_id=...)
        """
        result: list[ChatMessage] = []
        for msg in messages:
            role = _lc_role_to_provider(msg)
            if role is None:
                continue

            tool_calls = None
            tool_call_id = None
            name = None

            if isinstance(msg, AIMessage) and msg.tool_calls:
                tool_calls = [
                    {
                        "id": tc.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": tc.get("name", ""),
                            "arguments": _json.dumps(tc.get("args", {}), ensure_ascii=False),
                        },
                    }
                    for tc in msg.tool_calls
                ]

            if isinstance(msg, ToolMessage):
                tool_call_id = msg.tool_call_id
                name = msg.name

            result.append(ChatMessage(
                role=role,
                content=_coerce_to_str(msg.content) if msg.content else None,
                tool_calls=tool_calls,
                tool_call_id=tool_call_id,
                name=name,
            ))

        return result


# ── 模块级辅助函数 ─────────────────────────────────────────


def _lc_role_to_provider(msg: BaseMessage) -> str | None:
    """将 LangChain 消息类型映射为 Provider 的 role 字符串。"""
    if isinstance(msg, SystemMessage):
        return "system"
    elif isinstance(msg, HumanMessage):
        return "user"
    elif isinstance(msg, AIMessage):
        return "assistant"
    elif isinstance(msg, ToolMessage):
        return "tool"
    else:
        # 未知消息类型 → 按 role 属性回退
        return getattr(msg, "role", None)


def _coerce_to_str(content: str | list[str | dict]) -> str:
    """将 LangChain 的 content（可能为 str 或 list）强制转为纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(item.get("text", "") or _json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(content)


def _rebuild_tool_calls_from_chunks(tool_call_chunks: list) -> list[ToolCall]:
    """从增量 ToolCallChunk 列表中重建完整的 ToolCall 列表（兜底逻辑）。"""
    # 按 index 分组
    groups: dict[int, dict] = {}
    for chunk in tool_call_chunks:
        idx = chunk.get("index", 0) if isinstance(chunk, dict) else getattr(chunk, "index", 0)
        name = chunk.get("name") if isinstance(chunk, dict) else getattr(chunk, "name", None)
        args = chunk.get("args") if isinstance(chunk, dict) else getattr(chunk, "args", None)
        tc_id = chunk.get("id") if isinstance(chunk, dict) else getattr(chunk, "id", None)

        if idx not in groups:
            groups[idx] = {"name": "", "args": "", "id": None}
        if name:
            groups[idx]["name"] += name
        if args:
            groups[idx]["args"] += args
        if tc_id:
            groups[idx]["id"] = tc_id

    result: list[ToolCall] = []
    for g in groups.values():
        if g["name"]:
            try:
                parsed_args = _json.loads(g["args"]) if g["args"] else {}
            except (_json.JSONDecodeError, TypeError):
                parsed_args = {}
            result.append(ToolCall(name=g["name"], args=parsed_args, id=g["id"]))
    return result
