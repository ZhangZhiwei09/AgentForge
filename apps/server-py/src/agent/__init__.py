"""Agent 模块 —— Router + ReAct Executor（LangGraph）+ Tool System。

对应 TS:
- apps/server/src/services/agent-runtime/
- apps/server/src/tools/

Phase A: AgentExecutor 已迁移至 LangGraph StateGraph 驱动。
"""

from src.agent.chat_agent import ChatAgent
from src.agent.executor import AgentExecutor
from src.agent.langchain_adapter import ProviderChatModel
from src.agent.router.pipeline import QueryRouter, quick_route_scan
from src.agent.state import AgentState
from src.agent.types import (
    RouteAgent,
    RouteContext,
    RouteName,
    RouterDecision,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)

__all__ = [
    # types
    "RouteName",
    "RouterDecision",
    "RouteContext",
    "RouteAgent",
    "StreamMeta",
    "StreamToken",
    "StreamDone",
    "StreamError",
    # state
    "AgentState",
    # router
    "QueryRouter",
    "quick_route_scan",
    # executor
    "AgentExecutor",
    # chat
    "ChatAgent",
    # adapter
    "ProviderChatModel",
]
