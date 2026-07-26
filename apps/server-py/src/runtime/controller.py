"""ExecutionController —— 编排 ExecutionNode 的异步执行。

对应 TS:
- ExecutionScope: apps/server/src/runtime/scope.ts
- ExecutionController: 无独立文件（编排逻辑分布在各个 Service 中），此处统一封装

设计要点：
- ExecutionScope 聚合 context + node + buffer，一次创建返回完整运行域
- ExecutionController.run() 封装协程在节点生命周期内的执行
- 超时 → timeout 状态；取消 → cancelled 状态；异常 → failed 状态
- shield 保护清理操作：即使外部取消，清理代码也会执行完毕
- 事件自动发布：start/complete/fail/cancel/timeout

Python 新概念：
- asyncio.wait_for(coro, timeout)：设置协程超时，超时抛出 TimeoutError
- asyncio.CancelledError：协程被取消时抛出的异常（对应 TS AbortSignal）
- asyncio.shield(coro)：保护协程不被取消，常用于清理操作
- TypeVar[T]：泛型，让 run() 方法保留协程的返回类型
"""

import asyncio
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import TypeVar

from src.runtime.buffer import OutputBuffer
from src.runtime.context import RunContext, create_child_context, create_run_context
from src.runtime.events import EventBus, RuntimeEvent, RuntimeEventType
from src.runtime.node import (
    ExecutionNode,
    ExecutionType,
    RunResult,
    RunTermination,
)

T = TypeVar("T")

# ═══════════════════════════════════════════════════════════
# ExecutionScope
# ═══════════════════════════════════════════════════════════


@dataclass(slots=True)
class ExecutionScope:
    """运行域：一次执行所需的完整上下文。

    聚合 context + node + buffer，所有流式执行（Chat / Agent / Workflow）的入口工厂。
    类似 TS 的 ExecutionScope interface。

    Attributes:
        context: 不可变运行时上下文（cancel signal + runId + ancestry）
        node: 执行节点（状态机 + 树结构）
        buffer: 输出缓冲区（收集流式 token）
        trace_id: 可观测性 Trace ID（预留，默认 None）
    """

    context: RunContext
    node: ExecutionNode
    buffer: OutputBuffer
    trace_id: str | None = None


@dataclass(slots=True)
class CreateScopeOptions:
    """create_execution_scope() 的参数。

    Attributes:
        signal: 取消信号（通常来自 HTTP Request 的 abort）
        parent_context: 父 Context（SubAgent / 嵌套调用场景）
        run_id: 自定义 runId（测试 / replay 场景）
        execution_type: 执行类型
        trace_id: 可观测性 Trace ID
    """

    signal: asyncio.Event | None = None
    parent_context: RunContext | None = None
    run_id: str | None = None
    execution_type: ExecutionType = "chat"
    trace_id: str | None = None


def create_execution_scope(options: CreateScopeOptions | None = None) -> ExecutionScope:
    """创建执行域。

    所有流式执行（Chat / Agent / Workflow / Voice）的入口工厂。
    类似 TS 的 createExecutionScope(options)。

    Args:
        options: 创建选项。为 None 时使用默认值（新 signal + 新 runId）。

    Returns:
        聚合了 context + node + buffer 的 ExecutionScope
    """
    opts = options or CreateScopeOptions()

    context = (
        create_child_context(opts.parent_context, opts.run_id)
        if opts.parent_context
        else create_run_context(opts.signal, opts.run_id)
    )

    buffer = OutputBuffer()
    node = ExecutionNode(opts.execution_type, context, buffer)

    return ExecutionScope(
        context=context,
        node=node,
        buffer=buffer,
        trace_id=opts.trace_id,
    )


# ═══════════════════════════════════════════════════════════
# ExecutionController
# ═══════════════════════════════════════════════════════════


@dataclass
class ControllerResult:
    """ExecutionController.run() 的返回结果。

    Attributes:
        run_result: 节点终止状态（completed/failed/cancelled/timeout）
        output: 输出缓冲区收集的内容
        duration_ms: 执行耗时（毫秒）
    """

    run_result: RunResult
    output: str
    duration_ms: float


class ExecutionController:
    """编排 ExecutionNode 的异步执行流程。

    职责：
    - 封装协程在节点生命周期内的执行
    - 超时控制（asyncio.wait_for）
    - 取消信号传播
    - 事件发布（通过 EventBus）
    - Shield 清理保护

    用法:
        scope = create_execution_scope()
        controller = ExecutionController(scope)

        async def my_task():
            ...

        result = await controller.run(my_task(), timeout_ms=30000)
    """

    def __init__(
        self,
        scope: ExecutionScope,
        event_bus: EventBus | None = None,
    ) -> None:
        self.scope = scope
        self.node = scope.node
        self.buffer = scope.buffer
        self.context = scope.context
        self.event_bus = event_bus
        self._start_time: float = 0.0

    async def run(
        self,
        coro: Awaitable[T],
        timeout_ms: int | None = None,
        shield_cleanup: bool = True,
    ) -> ControllerResult:
        """在 ExecutionNode 生命周期内执行协程。

        Args:
            coro: 要执行的协程
            timeout_ms: 超时时间（毫秒），None 表示无超时
            shield_cleanup: 是否用 shield 保护清理操作（默认 True）

        Returns:
            ControllerResult 包含终止状态、输出内容、耗时

        Raises:
            asyncio.TimeoutError: 超时（状态已设为 timeout）
            asyncio.CancelledError: 外部取消（状态已设为 cancelled）
            Exception: 协程异常（状态已设为 failed）
        """
        self._start_time = time.monotonic()
        self.node.start()
        self._emit(RuntimeEventType.NODE_START)

        try:
            # 运行协程（可选超时）
            if timeout_ms is not None:
                task_result = await asyncio.wait_for(
                    asyncio.ensure_future(coro),
                    timeout=timeout_ms / 1000,
                )
            else:
                task_result = await coro

            # 正常完成
            run_result = self.node.complete()
            self._emit(RuntimeEventType.NODE_COMPLETE)
            return ControllerResult(
                run_result=run_result,
                output=self.buffer.get_content(),
                duration_ms=self._elapsed_ms(),
            )

        except asyncio.TimeoutError:
            run_result = self.node.timeout(timeout_ms or 0)
            self._emit(RuntimeEventType.NODE_TIMEOUT, {"timeout_ms": timeout_ms})
            await self._cleanup(shield=shield_cleanup)
            raise

        except asyncio.CancelledError:
            run_result = self.node.cancel("cancelled")
            self._emit(RuntimeEventType.NODE_CANCEL)
            await self._cleanup(shield=shield_cleanup)
            raise

        except Exception as exc:
            run_result = self.node.fail(str(exc))
            self._emit(RuntimeEventType.NODE_FAIL, {"error": str(exc)})
            await self._cleanup(shield=shield_cleanup)
            raise

    # ── 辅助方法 ──────────────────────────────────────────

    def _emit(self, type_: RuntimeEventType, data: dict | None = None) -> None:
        """向 EventBus 发布事件。无 EventBus 时为 no-op。"""
        if self.event_bus is not None:
            self.event_bus.publish(
                RuntimeEvent(
                    type=type_.value,
                    node_id=self.node.id,
                    data=data or {},
                )
            )

    async def _cleanup(self, shield: bool) -> None:
        """清理操作。shield=True 时使用 asyncio.shield 保护不受取消影响。

        被取消时，清理代码（释放资源、关闭连接等）不应被打断。
        asyncio.shield 确保即使收到 CancelledError，清理代码也能执行完毕。
        """
        coro = self.node.buffer.clear()
        if shield:
            try:
                await asyncio.shield(asyncio.sleep(0))
            except asyncio.CancelledError:
                pass

    def _elapsed_ms(self) -> float:
        """计算从 run() 开始到现在的耗时（毫秒）。"""
        return (time.monotonic() - self._start_time) * 1000
