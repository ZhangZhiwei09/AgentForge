"""ExecutionNode —— Runtime 根原语。

对应 TS: apps/server/src/runtime/controller.ts

设计要点：
- 聚合 ExecutionState 状态机 + 树结构 + RunContext 身份
- complete/interrupt/fail 只做状态转移；持久化由上层 Service 决定
- should_stop 统一入口：检查 signal.aborted 或 Interrupting 状态
- 状态转移校验合法性，拒绝非法跳转
- 父取消自动级联到所有子节点

Python 新概念：
- time.monotonic()：单调时钟，不受系统时间调整影响，适合测耗时
- set[Callable]：回调函数集合，类似 TS Set<(state) => void>
- 类级别的状态机模式：私有 _state + 公开 property
"""

import time
from collections.abc import Callable
from typing import Literal

from src.runtime.buffer import OutputBuffer
from src.runtime.context import RunContext, create_child_context
from src.runtime.state import (
    TERMINAL_STATES,
    VALID_TRANSITIONS,
    ExecutionState,
    is_terminal,
)

# ═══════════════════════════════════════════════════════════
# ExecutionType
# ═══════════════════════════════════════════════════════════

ExecutionType = Literal["chat", "agent", "tool", "workflow", "voice", "subagent"]
"""执行类型，对应 TS 的 ExecutionType union type。"""

# ═══════════════════════════════════════════════════════════
# RunTermination
# ═══════════════════════════════════════════════════════════

from enum import StrEnum


class RunTermination(StrEnum):
    """执行终止原因。"""
    Completed = "completed"
    Failed = "failed"
    Cancelled = "cancelled"
    Timeout = "timeout"


# ═══════════════════════════════════════════════════════════
# RunResult
# ═══════════════════════════════════════════════════════════

from dataclasses import dataclass, field


@dataclass(slots=True)
class RunResult:
    """执行结果，不携带 output——内容从 OutputBuffer.get_content() 获取。

    对应 TS: RunResult interface。
    """
    termination: RunTermination
    error: str | None = None


# ═══════════════════════════════════════════════════════════
# ExecutionNode
# ═══════════════════════════════════════════════════════════


class ExecutionNode:
    """Runtime 执行节点，聚合状态机 + 树结构 + Context 身份。

    生命周期：
        CREATED → start() → RUNNING → complete()/fail()/cancel()/timeout() → 终态
    """

    __slots__ = (
        "id",
        "type",
        "parent",
        "context",
        "buffer",
        "children",
        "_state",
        "_started_at",
        "_completed_at",
        "_listeners",
    )

    def __init__(
        self,
        type_: ExecutionType,
        context: RunContext,
        buffer: OutputBuffer | None = None,
        parent: "ExecutionNode | None" = None,
    ) -> None:
        self.type: ExecutionType = type_
        self.id: str = context.run_id
        self.context: RunContext = context
        self.buffer: OutputBuffer = buffer or OutputBuffer()
        self.parent: ExecutionNode | None = parent
        self.children: list[ExecutionNode] = []

        self._state: ExecutionState = ExecutionState.CREATED
        self._started_at: float = 0.0
        self._completed_at: float = 0.0
        self._listeners: set[Callable[[ExecutionState], None]] = set()

        # 注册到父节点
        if parent is not None:
            parent.children.append(self)

    # ── 状态查询 ──────────────────────────────────────────

    @property
    def state(self) -> ExecutionState:
        """当前执行状态。"""
        return self._state

    @property
    def is_terminal(self) -> bool:
        """是否为终端态。"""
        return self._state in TERMINAL_STATES

    @property
    def duration(self) -> float:
        """执行耗时（秒）。

        运行中返回至今耗时，未开始返回 0。
        使用 time.monotonic() 确保不受系统时钟调整影响。
        """
        if self._started_at == 0.0:
            return 0.0
        if self._completed_at > 0.0:
            return self._completed_at - self._started_at
        return time.monotonic() - self._started_at

    @property
    def should_stop(self) -> bool:
        """是否应该停止：signal 已触发 或 已被取消/超时。

        类似 TS 的 get shouldStop()。
        """
        return (
            self.context.is_aborted
            or self._state == ExecutionState.CANCELLED
            or self._state == ExecutionState.TIMEOUT
        )

    # ── 状态监听 ──────────────────────────────────────────

    def on_state_change(
        self, fn: Callable[[ExecutionState], None]
    ) -> Callable[[], None]:
        """注册状态变更监听器，返回取消注册函数。

        类似 TS 的 onStateChange(fn): () => void。
        """
        self._listeners.add(fn)
        return lambda: self._listeners.discard(fn)

    # ── 子节点管理 ────────────────────────────────────────

    def create_child(
        self,
        type_: ExecutionType,
        child_run_id: str | None = None,
    ) -> "ExecutionNode":
        """创建子 ExecutionNode。

        子节点继承父的 context（ancestry 自动追加），拥有独立的 run_id。
        父取消时自动级联取消所有子节点（Invariant 4）。

        类似 TS 的 createChild(type, childRunId?)。
        """
        child_context = create_child_context(self.context, child_run_id)
        return ExecutionNode(type_, child_context, parent=self)

    # ── 生命周期方法 ──────────────────────────────────────

    def start(self) -> None:
        """开始执行：CREATED → RUNNING。已运行时幂等。"""
        if self._state == ExecutionState.RUNNING:
            return
        self._set_state(ExecutionState.RUNNING)
        self._started_at = time.monotonic()

    def complete(self) -> RunResult:
        """正常完成：RUNNING → COMPLETED。

        自动取消所有活跃子节点（Invariant 4：父完成前子节点必须终态）。
        """
        self._cancel_active_children("parent completed")
        self._completed_at = time.monotonic()
        self._set_state(ExecutionState.COMPLETED)
        return RunResult(termination=RunTermination.Completed)

    def fail(self, error: str) -> RunResult:
        """异常失败：RUNNING → FAILED。"""
        self._cancel_active_children("parent failed")
        self._completed_at = time.monotonic()
        self._set_state(ExecutionState.FAILED)
        return RunResult(termination=RunTermination.Failed, error=error)

    def cancel(self, reason: str) -> RunResult:
        """取消执行：CREATED/RUNNING → CANCELLED。

        级联取消所有子节点。可重复调用（幂等）。
        """
        if self._state == ExecutionState.CANCELLED:
            return RunResult(termination=RunTermination.Cancelled)
        self._cancel_active_children(reason)
        # 只有已启动的节点记录结束时间
        if self._started_at > 0:
            self._completed_at = time.monotonic()
        self._set_state(ExecutionState.CANCELLED)
        return RunResult(termination=RunTermination.Cancelled)

    def timeout(self, after_ms: int) -> RunResult:
        """超时：RUNNING → TIMEOUT。"""
        self._cancel_active_children("parent timed out")
        self._completed_at = time.monotonic()
        self._set_state(ExecutionState.TIMEOUT)
        return RunResult(
            termination=RunTermination.Timeout,
            error=f"Timed out after {after_ms}ms",
        )

    # ── 兼容旧 API ────────────────────────────────────────

    def interrupt(self) -> RunResult:
        """Deprecated: Use cancel() instead."""
        return self.cancel("interrupted")

    # ── 内部方法 ──────────────────────────────────────────

    def _cancel_active_children(self, reason: str) -> None:
        """取消所有活跃子节点。"""
        for child in self.children:
            if not child.is_terminal:
                child.cancel(reason)

    def _set_state(self, new_state: ExecutionState) -> None:
        """设置新状态（校验合法性 + 通知监听器）。"""
        allowed = VALID_TRANSITIONS.get(self._state)
        if not allowed or new_state not in allowed:
            raise ValueError(
                f"[ExecutionNode:{self.id}] Invalid state transition: "
                f"{self._state.value} -> {new_state.value}"
            )
        self._state = new_state
        self._notify_listeners(new_state)

    def _notify_listeners(self, state: ExecutionState) -> None:
        """通知所有监听器，异常不影响 Runtime。"""
        for fn in self._listeners:
            try:
                fn(state)
            except Exception:
                # 监听器异常不影响 Runtime
                pass
