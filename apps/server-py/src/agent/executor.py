"""AgentExecutor —— 统一的 TASK 路由 ReAct 执行器。

对应 TS: apps/server/src/services/agent-runtime/agent-executor.ts

核心流程：
    用户消息 → ReAct Loop → Tool 调用 → SSE Stream

ReAct 循环:
    1. think: LLM 分析用户意图 + 决定是否调工具
    2. act: 执行工具（如果 LLM 返回 tool_calls）
    3. observe: 将工具结果注入对话
    4. respond: 流式输出最终回复（实时流式，非缓冲后输出）

V1 简化版：
- 不支持 simple_qa 快速路径
- 不支持 Citation 引证校验
- 不做业务回复校验

Python 新概念：
- AsyncGenerator[yield]: 流式产出事件的异步生成器
- OpenAI tool_calls 累积: 跨 chunk 累积 tool call 片段
- ReAct 循环控制: max_iterations + timeout 保护
- 实时流式: token 从 Provider 到达后立即 yield 到 SSE，不做缓冲等待
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from src.agent.tools.registry import ToolRegistry, tool_registry
from src.agent.types import (
    RouteContext,
    RouteName,
    RouteStreamEvent,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)
from src.providers.registry import get_provider, resolve_model
from src.schemas.chat import ChatMessage

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────
MAX_ITERATIONS = 5
HARDCODED_FALLBACK = "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。"

# ReAct 系统提示词（中文）
REACT_SYSTEM_PROMPT = """你是一个专业的 AI 助手。你可以使用工具来帮助用户解决问题。

## 回答规则
1. 先理解用户的请求，判断是否需要使用工具
2. 如果需要查询知识库，使用 search_knowledge_base 工具
3. 基于工具返回的结果，用自然语言回答用户
4. 回答要简洁、专业、友好
5. 如果工具没有返回有用信息，如实告诉用户
6. 使用 Markdown 格式组织回答（列表、表格等）

## 重要
- 不要编造信息，严格基于工具返回的数据回答
- 每次只调用一个工具，等待结果后再决定下一步"""


class AgentExecutor:
    """ReAct Agent 执行器，实现 RouteAgent 协议。

    用法:
        executor = AgentExecutor()
        async for event in executor.execute(context):
            if isinstance(event, StreamToken):
                print(event.content, end="")
            elif isinstance(event, StreamDone):
                break
    """

    route = RouteName.TASK

    def __init__(self, registry: ToolRegistry | None = None) -> None:
        self._registry = registry or tool_registry

    async def execute(
        self,
        context: RouteContext,
        system_prompt: str | None = None,
    ) -> AsyncIterator[RouteStreamEvent]:
        """执行 ReAct Agent 流程。

        Args:
            context: RouteContext with user_message, conversation_id, etc.
            system_prompt: Optional custom system prompt. Defaults to REACT_SYSTEM_PROMPT.
        """
        assistant_msg_id = context.assistant_msg_id
        resolved_model = context.resolved_model

        # ── 发送 meta ──
        yield StreamMeta(
            message_id=assistant_msg_id,
            session_id=context.session_id,
            model=resolved_model,
            provider=context.provider_name,
            route=self.route.value,
            intent=context.intent,
        )

        try:
            # ── 解析 Provider + Model ──
            resolved = resolve_model(resolved_model)
            provider = get_provider(resolved["provider_name"])
            model = resolved["model_id"]

            # ── 获取工具定义 ──
            tool_defs = self._to_openai_tools(self._registry.get_definitions())

            # ── 构建消息列表 ──
            effective_system_prompt = (
                system_prompt if system_prompt else REACT_SYSTEM_PROMPT
            )
            messages: list[dict] = [
                {"role": "system", "content": effective_system_prompt},
                {"role": "user", "content": context.user_message},
            ]

            # ── ReAct 循环 ──
            final_answer = ""

            for _iteration in range(MAX_ITERATIONS):
                # 调 LLM 流式 —— 实时产出 token 到 SSE
                content_parts: list[str] = []
                tool_calls_acc: dict[int, dict] = {}

                async for chunk in provider.stream_chat(
                    messages=self._dicts_to_chat_messages(messages),
                    model=model,
                    temperature=0.7,
                    max_tokens=4096,
                    tools=tool_defs,
                ):
                    if chunk.type == "tool_call" and chunk.tool_call:
                        idx = len(tool_calls_acc)  # 按到达顺序分配 index
                        tool_calls_acc[idx] = chunk.tool_call

                    elif chunk.type == "token" and chunk.content:
                        content_parts.append(chunk.content)
                        # 实时流式输出：OpenAI tool_calls 总是在 text 之前到达，
                        # 所以此时未见到 tool_call 就是最终文本回复，直接 yield。
                        if not tool_calls_acc:
                            yield StreamToken(
                                content=chunk.content,
                                message_id=assistant_msg_id,
                            )
                            # 让出事件循环，确保 SSE 数据刷新到网络层
                            await asyncio.sleep(0)

                    # done chunk: 跳过（provider 层已 yield done）

                content_text = "".join(content_parts)

                # ── 有 tool_calls → 执行工具 ──
                if tool_calls_acc:
                    tool_calls_list = list(tool_calls_acc.values())

                    # 记录 assistant 消息（含 tool_calls）
                    messages.append({
                        "role": "assistant",
                        "content": content_text or None,
                        "tool_calls": [
                            {
                                "id": tc["id"],
                                "type": "function",
                                "function": {
                                    "name": tc["name"],
                                    "arguments": tc.get("arguments", "{}"),
                                },
                            }
                            for tc in tool_calls_list
                        ],
                    })

                    # 执行每个工具
                    for tc in tool_calls_list:
                        tool_name = tc.get("name", "")
                        try:
                            tool_args = json.loads(tc.get("arguments", "{}"))
                        except json.JSONDecodeError:
                            tool_args = {}

                        result = await self._registry.execute(
                            tool_name, tool_args, context.conversation_id
                        )

                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "content": json.dumps(result, ensure_ascii=False),
                        })

                    continue  # 继续 ReAct 循环

                # ── 无 tool_calls → 最终回复（token 已在上面实时 yield）──
                final_answer = content_text
                break  # 退出循环

            # ── Fallback ──
            if not final_answer:
                for char in HARDCODED_FALLBACK:
                    yield StreamToken(content=char, message_id=assistant_msg_id)

            # ── Done ──
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=not bool(final_answer),
            )

        except Exception as exc:
            logger.error("AgentExecutor failed: %s", exc)
            yield StreamError(content=str(exc))
            for char in HARDCODED_FALLBACK:
                yield StreamToken(content=char, message_id=assistant_msg_id)
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=True,
            )

    # ── 工具方法 ──────────────────────────────────────────

    @staticmethod
    def _dicts_to_chat_messages(messages: list[dict]) -> list[ChatMessage]:
        """将原始 dict 消息列表转为 ChatMessage 列表。"""
        result: list[ChatMessage] = []
        for m in messages:
            result.append(ChatMessage(
                role=m["role"],
                content=m.get("content"),
                tool_calls=m.get("tool_calls"),
                tool_call_id=m.get("tool_call_id"),
                name=m.get("name"),
            ))
        return result

    @staticmethod
    def _to_openai_tools(definitions) -> list[dict]:
        """将 ToolDefinition 列表转为 OpenAI function calling 格式。"""
        tools: list[dict] = []
        for d in definitions:
            tools.append({
                "type": d.type,
                "function": {
                    "name": d.function.name,
                    "description": d.function.description,
                    "parameters": d.function.parameters,
                },
            })
        return tools
