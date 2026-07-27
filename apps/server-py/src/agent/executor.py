"""AgentExecutor —— 统一的 TASK 路由 ReAct 执行器（LangGraph 版）。

对应 TS: apps/server/src/services/agent-runtime/agent-executor.ts

Phase A 升级：手写 while 循环 → LangGraph StateGraph + astream_events()。

Graph 结构:
    START → agent_node → (有 tool_calls?) → tools_node → agent_node
                           → (无 tool_calls?) → END

流式策略（astream_events v2）:
    - on_chat_model_stream → yield StreamToken（实时流式）
    - on_chat_model_end → 捕获最终回答（含 tool_calls 检查）
    - on_tool_end → 日志记录

不变项（关键约束）:
    - chat.py 的 _to_sse() 和路由分发逻辑 不修改
    - types.py 的 RouteStreamEvent 和 RouteAgent Protocol 不修改
    - StreamMeta → StreamToken* → StreamDone 事件序列 不变
    - 现有 tests/test_agent.py 必须通过
"""

import asyncio
import json as _json
import logging
from collections.abc import AsyncIterator

from langgraph.graph import END, StateGraph

from src.agent.langchain_adapter import ProviderChatModel, _coerce_to_str
from src.agent.state import AgentState
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
        """执行 ReAct Agent 流程（LangGraph StateGraph 驱动）。

        Args:
            context: RouteContext with user_message, conversation_id, etc.
            system_prompt: Optional custom system prompt.
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
            model_id = resolved["model_id"]

            # ── 获取工具定义 ──
            # 注册中心在此 init（幂等），确保工具就绪
            self._registry.init()
            tool_defs = self._to_openai_tools(self._registry.get_definitions())

            # ── 构建 LangChain 模型适配器 ──
            model = ProviderChatModel(
                provider=provider,
                model_name=model_id,
                temperature=0.7,
                max_tokens=4096,
            )

            effective_system_prompt = (
                system_prompt if system_prompt else REACT_SYSTEM_PROMPT
            )

            # ── 构建 LangGraph StateGraph ──
            graph = self._build_graph(
                model=model,
                tool_defs=tool_defs,
                conversation_id=context.conversation_id,
                system_prompt=effective_system_prompt,
            )

            # ── 初始状态 ──
            from langchain_core.messages import HumanMessage, SystemMessage

            initial_state: AgentState = {
                "messages": [
                    SystemMessage(content=effective_system_prompt),
                    HumanMessage(content=context.user_message),
                ],
                "iteration_count": 0,
            }

            # ── 流式执行 ──
            final_answer = ""
            final_answer_collected = False

            async for event in graph.astream_events(initial_state, version="v2"):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    chunk = event["data"]["chunk"]
                    content = getattr(chunk, "content", None)
                    if content:
                        text = _coerce_to_str(content)
                        if text:
                            yield StreamToken(
                                content=text,
                                message_id=assistant_msg_id,
                            )
                            # 让出事件循环，确保 SSE 数据刷新到网络层
                            await asyncio.sleep(0)

                elif kind == "on_chat_model_end":
                    output = event["data"]["output"]
                    # output 是聚合后的 AIMessage
                    if hasattr(output, "content") and output.content:
                        content_text = _coerce_to_str(output.content)
                        if content_text:
                            final_answer = content_text
                            final_answer_collected = True

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    tool_output = event["data"].get("output", "")
                    logger.info(
                        "Tool executed: %s, output preview: %.100s",
                        tool_name,
                        str(tool_output),
                    )

            # ── Fallback ──
            if not final_answer_collected or not final_answer:
                for char in HARDCODED_FALLBACK:
                    yield StreamToken(content=char, message_id=assistant_msg_id)
                    await asyncio.sleep(0)

            # ── Done ──
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=not final_answer_collected or not bool(final_answer),
            )

        except Exception as exc:
            logger.error("AgentExecutor failed: %s", exc)
            yield StreamError(content=str(exc))
            for char in HARDCODED_FALLBACK:
                yield StreamToken(content=char, message_id=assistant_msg_id)
                await asyncio.sleep(0)
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=True,
            )

    # ── Graph 构建 ─────────────────────────────────────────

    def _build_graph(
        self,
        model: ProviderChatModel,
        tool_defs: list[dict],
        conversation_id: str,
        system_prompt: str,
    ) -> StateGraph:
        """构建 LangGraph StateGraph。

        Graph 结构:
            START → agent → (has tool_calls?) → tools → agent
                            → (no tool_calls?) → END
        """
        registry = self._registry

        # ── 节点定义 ──

        async def call_model(state: AgentState) -> dict:
            """Agent 节点：调用 LLM 模型（带工具定义）。

            使用 astream() 确保 on_chat_model_stream 事件被触发，
            实现实时 token 流式输出到前端。

            Phase C: 每次 LLM 调用包裹在 Langfuse Generation 中。
            """
            from langchain_core.messages import AIMessage as LCAIMessage

            from src.observability import get_observability

            iteration = state.get("iteration_count", 0)
            gen_name = f"agent-reAct-{iteration + 1}"

            content_parts: list[str] = []
            tool_calls: list[dict] = []

            obs = get_observability()
            gen_span = obs.create_generation(
                name=gen_name,
                model=model.model_name,
                input={"messages": str(state["messages"][-2:])},
            )

            try:
                async for chunk in model.astream(
                    state["messages"],
                    tools=tool_defs,
                ):
                    if chunk.content:
                        content_parts.append(_coerce_to_str(chunk.content))
                    if chunk.tool_calls:
                        tool_calls = list(chunk.tool_calls)

                final_content = "".join(content_parts)

                gen_span.end(
                    output=final_content if not tool_calls else None,
                    metadata={
                        "tool_calls": [tc.get("name", "") for tc in tool_calls],
                    } if tool_calls else None,
                )
            except Exception:
                gen_span.end(output=None)
                raise

            response = LCAIMessage(
                content=final_content,
                tool_calls=tool_calls if tool_calls else None,
            )

            return {
                "messages": [response],
                "iteration_count": iteration + 1,
            }

        async def call_tools(state: AgentState) -> dict:
            """工具节点：执行 AIMessage 中的 tool_calls，委托给 ToolRegistry。"""
            from langchain_core.messages import ToolMessage

            messages = state["messages"]
            if not messages:
                return {"messages": []}

            last_message = messages[-1]
            tc_list = getattr(last_message, "tool_calls", None) or []
            if not tc_list:
                return {"messages": []}

            tool_messages: list[ToolMessage] = []
            for tc in tc_list:
                tc_name = tc.get("name", "") if isinstance(tc, dict) else getattr(tc, "name", "")
                tc_args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
                tc_id = tc.get("id", "") if isinstance(tc, dict) else getattr(tc, "id", "")

                try:
                    result = await registry.execute(
                        tc_name, tc_args, conversation_id
                    )
                except Exception as exc:
                    logger.error("Tool %s execution error: %s", tc_name, exc)
                    result = {"status": "failed", "error": str(exc)}

                tool_messages.append(ToolMessage(
                    content=_json.dumps(result, ensure_ascii=False),
                    tool_call_id=tc_id,
                    name=tc_name,
                ))

            return {"messages": tool_messages}

        # ── 条件边 ──

        def should_continue(state: AgentState) -> str:
            """条件边：判断是否继续到工具节点。"""
            messages = state["messages"]
            if not messages:
                return END

            last_message = messages[-1]
            tc_list = getattr(last_message, "tool_calls", None) or []
            iteration = state.get("iteration_count", 0)

            if tc_list and iteration < MAX_ITERATIONS:
                return "tools"
            return END

        # ── 组装 Graph ──

        workflow = StateGraph(AgentState)
        workflow.add_node("agent", call_model)
        workflow.add_node("tools", call_tools)
        workflow.set_entry_point("agent")
        workflow.add_conditional_edges(
            "agent",
            should_continue,
            {"tools": "tools", END: END},
        )
        workflow.add_edge("tools", "agent")

        return workflow.compile()

    # ── 工具方法 ──────────────────────────────────────────

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
