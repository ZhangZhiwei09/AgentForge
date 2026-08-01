"""build_react_graph —— LangGraph ReAct StateGraph 构建工厂。

从 AgentExecutor._build_graph 抽出，供 TASK 路由（executor.py）与
DIAGNOSIS 多 Agent 编排（diagnosis/graph.py）复用。

对应 python-core-upgrade-plan.md: Phase A（LangGraph ReAct）

Graph 结构:
    START → agent → (有 tool_calls?) → tools → agent
                    → (无 tool_calls?) → END

不变量:
    - 使用现有 ProviderChatModel 适配器 + ToolRegistry，不引入 create_react_agent
    - system prompt 由调用方注入初始 state，节点内不重复引用
"""

import json as _json
import logging

from langgraph.graph import END, StateGraph

from src.agent.langchain_adapter import ProviderChatModel, _coerce_to_str
from src.agent.state import AgentState
from src.agent.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# 默认 ReAct 迭代上限（截断保护）
DEFAULT_MAX_ITERATIONS = 5


def build_react_graph(
    model: ProviderChatModel,
    tool_defs: list[dict],
    system_prompt: str,
    registry: ToolRegistry,
    conversation_id: str,
    checkpointer=None,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
) -> StateGraph:
    """构建 LangGraph ReAct StateGraph。

    Args:
        model: ProviderChatModel 适配器（包装现有 LLMProvider）。
        tool_defs: OpenAI function calling 格式的工具定义列表。
        system_prompt: system prompt（保留参数；当前由初始 state 注入，
            节点内不使用）。
        registry: ToolRegistry，工具节点执行委托对象。
        conversation_id: 会话 ID，透传给工具执行。
        checkpointer: 可选的 LangGraph checkpointer。
        max_iterations: ReAct 迭代上限（截断保护）。
    """
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

        # langchain_core 1.5.1 下 AIMessage(tool_calls=None) 会触发 pydantic
        # ValidationError（tool_calls 必须是 list）。空 list 语义等价且合法。
        response = LCAIMessage(
            content=final_content,
            tool_calls=tool_calls,
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

        if tc_list and iteration < max_iterations:
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

    return workflow.compile(checkpointer=checkpointer)
