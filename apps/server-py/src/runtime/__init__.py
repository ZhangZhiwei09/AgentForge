"""Runtime 模块 —— Agent 执行引擎底盘。

对应 TS: apps/server/src/runtime/

导出清单：
- RunContext: 不可变运行时上下文
- ExecutionState: 运行时状态枚举
- ExecutionNode: 执行节点（状态机 + 树结构）
- OutputBuffer: 输出缓冲
- EventBus: 事件总线
- ExecutionController: 编排 Node + State + Events 的异步执行
- ExecutionScope: 运行域（context + node + buffer）
- tree 工具函数: flatten_tree, find_node, walk_tree 等
"""

from src.runtime.buffer import OutputBuffer
from src.runtime.context import (
    RunContext,
    create_child_context,
    create_run_context,
)
from src.runtime.controller import (
    ControllerResult,
    CreateScopeOptions,
    ExecutionController,
    ExecutionScope,
    create_execution_scope,
)
from src.runtime.events import EventBus, RuntimeEvent, RuntimeEventType
from src.runtime.node import (
    ExecutionNode,
    RunResult,
    RunTermination,
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

# tree 函数按需导入（避免循环依赖）
from src.runtime.tree import (
    count_nodes,
    find_node,
    flatten_tree,
    get_active_nodes,
    get_depth,
    get_duration_tree,
    get_root,
    get_terminal_nodes,
    iter_tree,
    walk_tree,
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
    # buffer
    "OutputBuffer",
    # node
    "ExecutionNode",
    "RunTermination",
    "RunResult",
    # controller + scope
    "ExecutionController",
    "ControllerResult",
    "ExecutionScope",
    "CreateScopeOptions",
    "create_execution_scope",
    # events
    "EventBus",
    "RuntimeEvent",
    "RuntimeEventType",
    # tree
    "flatten_tree",
    "iter_tree",
    "find_node",
    "get_root",
    "get_depth",
    "count_nodes",
    "get_terminal_nodes",
    "get_active_nodes",
    "get_duration_tree",
    "walk_tree",
]
