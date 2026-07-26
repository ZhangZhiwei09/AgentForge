"""Agent 模块共享类型。

对应 TS: apps/server/src/services/agent-runtime/types.ts

Python 新概念：
- StrEnum: 路由名称枚举，既是 str 又可模式匹配
- Protocol + @runtime_checkable: 定义 RouteAgent 接口（鸭子类型）
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol, runtime_checkable


class RouteName(StrEnum):
    """路由分类名称。4 条路径覆盖所有用户请求。"""
    SAFETY = "SAFETY"   # 安全合规拦截
    CHAT = "CHAT"        # 闲聊/传统对话
    TASK = "TASK"        # 任务执行（ReAct + Tool）
    HUMAN = "HUMAN"      # 转人工客服


@dataclass(slots=True)
class RouterDecision:
    """路由决策结果。

    Attributes:
        route: 目标路由
        confidence: 置信度 0.0 ~ 1.0
        reasoning: 分类理由（审计/debug 用）
    """
    route: RouteName
    confidence: float
    reasoning: str = ""


# ═══════════════════════════════════════════════════════════
# RouteStreamEvent —— SSE 流事件
# ═══════════════════════════════════════════════════════════

@dataclass(slots=True)
class StreamMeta:
    """流元信息事件。"""
    type: str = "meta"
    message_id: str = ""
    session_id: str | None = None
    model: str = ""
    provider: str = ""
    route: str = ""
    intent: str = ""
    knowledge: list = field(default_factory=list)
    within_service_hours: bool = True
    memory_count: int = 0


@dataclass(slots=True)
class StreamToken:
    """流式 token 事件。"""
    type: str = "token"
    content: str = ""
    message_id: str = ""


@dataclass(slots=True)
class StreamDone:
    """流结束事件。"""
    type: str = "done"
    message_id: str = ""
    usage: dict = field(default_factory=dict)
    suggestions: list[str] | None = None
    validated: bool = True
    fallback_used: bool = False
    route: str = ""


@dataclass(slots=True)
class StreamError:
    """流错误事件。"""
    type: str = "error"
    content: str = ""


# Union type alias（Python 3.12+ 的 type statement）
type RouteStreamEvent = StreamMeta | StreamToken | StreamDone | StreamError


# ═══════════════════════════════════════════════════════════
# RouteContext —— Agent 执行上下文
# ═══════════════════════════════════════════════════════════

@dataclass(slots=True)
class RouteContext:
    """Agent 执行上下文，包含一次请求的全部信息。

    对应 TS: RouteContext interface。
    """
    conversation_id: str = ""
    session_id: str | None = None
    user_message: str = ""
    history: list = field(default_factory=list)
    resolved_model: str = ""
    provider_name: str = ""
    within_service_hours: bool = True
    assistant_msg_id: str = ""
    intent: str = ""


# ═══════════════════════════════════════════════════════════
# RouteAgent Protocol —— 每条路由实现此接口
# ═══════════════════════════════════════════════════════════

@runtime_checkable
class RouteAgent(Protocol):
    """路由 Agent 协议。每条路径（SAFETY/CHAT/TASK/HUMAN）实现此接口。

    对应 TS: RouteAgent interface。
    """

    @property
    def route(self) -> RouteName:
        """当前 Agent 对应的路由名称。"""
        ...

    async def execute(self, context: RouteContext) -> AsyncIterator[RouteStreamEvent]:
        """执行 Agent 逻辑，流式产出 RouteStreamEvent。"""
        ...
