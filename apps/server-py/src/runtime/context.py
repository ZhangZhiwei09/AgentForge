"""RunContext —— 不可变运行时上下文。

对应 TS: apps/server/src/runtime/context.ts

设计要点：
- 全部字段通过 frozen=True 禁止修改，防止 Tool/Agent 污染上游
- ancestry 用 tuple（不可变序列）替代 TS 的 readonly 数组，直接表达完整运行树
- create_child_context() 由调用者决定何时创建，不由底层自动生成

Python 新概念：
- @dataclass(frozen=True, slots=True)：不可变数据类，类似 TS Readonly<{...}> + Object.freeze()
- slots=True：禁止动态属性，节省内存，类似 TS 的 sealed object
- asyncio.Event：asyncio 取消信号，类似 TS 的 AbortSignal
- uuid.uuid4()：类似 TS crypto.randomUUID()
"""

import asyncio
import uuid
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class RunContext:
    """不可变运行时上下文，支持运行树。

    Attributes:
        signal: 取消信号，贯穿全链路。is_set() 为 True 表示已取消。
        run_id: 本次执行的唯一 ID。
        ancestry: 运行树路径（tuple 不可变）。
                  例: ("root-chat-001", "agent-002", "tool-search-003")
                  Tracing / Replay / Debug 直接读取此元组重建运行树。
    """

    signal: asyncio.Event = field(default_factory=asyncio.Event)
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    ancestry: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_aborted(self) -> bool:
        """检查取消信号是否已触发。类似 TS 的 signal.aborted。"""
        return self.signal.is_set()

    def abort(self) -> None:
        """触发取消信号。幂等（重复调用无副作用）。"""
        self.signal.set()


def create_run_context(
    signal: asyncio.Event | None = None,
    run_id: str | None = None,
) -> RunContext:
    """创建根 RunContext。

    Chat / CustomerChat / Workflow 入口调用。
    类似 TS 的 createRunContext(signal, runId?)。
    """
    _id = run_id or str(uuid.uuid4())
    return RunContext(
        signal=signal or asyncio.Event(),
        run_id=_id,
        ancestry=(_id,),
    )


def create_child_context(
    parent: RunContext,
    child_run_id: str | None = None,
) -> RunContext:
    """创建子 RunContext。

    Agent 调用 Tool / SubAgent 时，由调用者调用此函数创建子 Context。
    子 Context 继承父的 signal，拥有独立的 run_id，
    ancestry 自动追加，形成完整运行树。

    类似 TS 的 createChildContext(parent, childRunId?)。
    """
    _id = child_run_id or str(uuid.uuid4())
    return RunContext(
        signal=parent.signal,  # 继承父的取消信号
        run_id=_id,
        ancestry=parent.ancestry + (_id,),
    )
