"""Agent 模块 —— Router + ReAct Executor + Tool System。

对应 TS:
- apps/server/src/services/agent-runtime/
- apps/server/src/tools/
"""

from src.agent.executor import AgentExecutor
from src.agent.router.pipeline import QueryRouter, quick_route_scan
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
    # router
    "QueryRouter",
    "quick_route_scan",
    # executor
    "AgentExecutor",
]
