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
    """路由分类名称。5 条路径覆盖所有用户请求。"""
    SAFETY = "SAFETY"       # 安全合规拦截
    CHAT = "CHAT"           # 闲聊/传统对话
    TASK = "TASK"           # 任务执行（ReAct + Tool）
    HUMAN = "HUMAN"         # 转人工客服
    DIAGNOSIS = "DIAGNOSIS"  # 故障诊断（Multi-Agent 协同排查）


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
    conversation_id: str = ""
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


@dataclass(slots=True)
class DiagnosisStarted:
    """Multi-Agent 诊断启动事件 —— 通知前端开始诊断流程。"""
    type: str = "diagnosis_started"
    message_id: str = ""
    agents: list[dict] = field(default_factory=list)


@dataclass(slots=True)
class DiagnosisPhase:
    """诊断阶段开始事件 —— 某个 Agent 开始排查。"""
    type: str = "diagnosis_phase"
    message_id: str = ""
    phase: int = 0
    agent: str = ""
    label: str = ""


@dataclass(slots=True)
class DiagnosisPhaseDone:
    """诊断阶段完成事件 —— 某个 Agent 完成排查。"""
    type: str = "diagnosis_phase_done"
    message_id: str = ""
    phase: int = 0
    agent: str = ""
    label: str = ""
    summary: str = ""


@dataclass(slots=True)
class DiagnosisCompleted:
    """诊断完成事件 —— 所有 Agent 执行完毕，包含最终诊断结果。"""
    type: str = "diagnosis_completed"
    message_id: str = ""
    output: dict = field(default_factory=dict)


@dataclass(slots=True)
class ClarificationNeeded:
    """诊断信息不足事件 —— 提示用户补充必要信息。"""
    type: str = "clarification_needed"
    message_id: str = ""
    intent: str = ""
    missing_fields: list[str] = field(default_factory=list)
    prompt_message: str = ""
    hints: list[str] = field(default_factory=list)


# Union type alias（Python 3.12+ 的 type statement）
type RouteStreamEvent = (StreamMeta | StreamToken | StreamDone | StreamError
    | DiagnosisStarted | DiagnosisPhase | DiagnosisPhaseDone
    | DiagnosisCompleted | ClarificationNeeded)


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
    prebuilt_messages: list = field(default_factory=list)  # ContextBuilder 预组装的 LangChain messages
    resolved_model: str = ""
    provider_name: str = ""
    within_service_hours: bool = True
    assistant_msg_id: str = ""
    intent: str = ""
    injected_memories: list = field(default_factory=list)


# ═══════════════════════════════════════════════════════════
# RouteAgent Protocol —— 每条路由实现此接口
# ═══════════════════════════════════════════════════════════

@runtime_checkable
class RouteAgent(Protocol):
    """路由 Agent 协议。每条路径（SAFETY/CHAT/TASK/HUMAN/DIAGNOSIS）实现此接口。

    对应 TS: RouteAgent interface。
    """

    @property
    def route(self) -> RouteName:
        """当前 Agent 对应的路由名称。"""
        ...

    async def execute(self, context: RouteContext) -> AsyncIterator[RouteStreamEvent]:
        """执行 Agent 逻辑，流式产出 RouteStreamEvent。"""
        ...
