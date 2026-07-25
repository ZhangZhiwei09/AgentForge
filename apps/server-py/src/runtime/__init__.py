"""Runtime 模块 —— Agent 执行引擎底盘。

对应 TS: apps/server/src/runtime/

导出清单：
- RunContext: 不可变运行时上下文
- create_run_context / create_child_context: 工厂函数
- ExecutionState: 运行时状态枚举
- TERMINAL_STATES / VALID_TRANSITIONS: 状态转换表
- validate_transition / assert_valid_transition: 状态校验
"""

from src.runtime.context import (
    RunContext,
    create_child_context,
    create_run_context,
)
from src.runtime.state import (
    ExecutionState,
    TERMINAL_STATES,
    VALID_TRANSITIONS,
    assert_valid_transition,
    is_active,
    is_terminal,
    validate_transition,
)

__all__ = [
    # context
    "RunContext",
    "create_run_context",
    "create_child_context",
    # state
    "ExecutionState",
    "TERMINAL_STATES",
    "VALID_TRANSITIONS",
    "validate_transition",
    "assert_valid_transition",
    "is_terminal",
    "is_active",
]
