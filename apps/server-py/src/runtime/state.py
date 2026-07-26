"""ExecutionState —— 运行时状态枚举 + 状态转换表。

对应 TS:
- state 枚举: apps/server/src/runtime/results.ts (ExecutionState enum)
- 状态转换表: apps/server/src/runtime/controller.ts (VALID_TRANSITIONS)

设计要点：
- StrEnum 六态：CREATED → RUNNING → COMPLETED/FAILED/CANCELLED/TIMEOUT
- 终态不可逆（Invariant 3）
- validate_transition() 校验合法性，拒绝非法跳转

Python 新概念：
- StrEnum：既是枚举又是 str，可直接 == "completed" 比较，也可序列化为 JSON
- frozenset：不可变集合，hashable，可作 dict key
"""

from enum import StrEnum


class ExecutionState(StrEnum):
    """运行时执行状态。

    六态生命周期：
        CREATED → RUNNING → COMPLETED (正常)
                         → FAILED    (异常)
                         → CANCELLED (取消)
                         → TIMEOUT   (超时)

    终态（COMPLETED/FAILED/CANCELLED/TIMEOUT）不可逆。
    """

    CREATED = "created"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


# ── 终端态集合 ──────────────────────────────────────────
# 对应 TS: TERMINAL_STATES = new Set([COMPLETED, FAILED, CANCELLED, TIMEOUT])

TERMINAL_STATES: frozenset[ExecutionState] = frozenset({
    ExecutionState.COMPLETED,
    ExecutionState.FAILED,
    ExecutionState.CANCELLED,
    ExecutionState.TIMEOUT,
})


# ── 状态转换表 ──────────────────────────────────────────
# 对应 TS: VALID_TRANSITIONS (ReadonlyMap<ExecutionState, ReadonlySet<ExecutionState>>)

VALID_TRANSITIONS: dict[ExecutionState, frozenset[ExecutionState]] = {
    ExecutionState.CREATED: frozenset({
        ExecutionState.RUNNING,
        ExecutionState.CANCELLED,  # 允许未启动就取消（父节点 complete/fail 时清理）
    }),
    ExecutionState.RUNNING: frozenset({
        ExecutionState.COMPLETED,
        ExecutionState.FAILED,
        ExecutionState.CANCELLED,
        ExecutionState.TIMEOUT,
    }),
    # 终态不可逆（Invariant 3）
    ExecutionState.COMPLETED: frozenset(),
    ExecutionState.FAILED: frozenset(),
    ExecutionState.CANCELLED: frozenset(),
    ExecutionState.TIMEOUT: frozenset(),
}


# ── 辅助函数 ────────────────────────────────────────────


def is_terminal(state: ExecutionState) -> bool:
    """判断是否为终端态。"""
    return state in TERMINAL_STATES


def is_active(state: ExecutionState) -> bool:
    """判断是否为活跃态（非终态）。"""
    return state not in TERMINAL_STATES


def validate_transition(
    from_state: ExecutionState,
    to_state: ExecutionState,
) -> bool:
    """验证状态转移是否合法。

    Args:
        from_state: 当前状态
        to_state: 目标状态

    Returns:
        True 表示合法跳转，False 表示非法跳转。
    """
    allowed = VALID_TRANSITIONS.get(from_state)
    return allowed is not None and to_state in allowed


def assert_valid_transition(
    from_state: ExecutionState,
    to_state: ExecutionState,
) -> None:
    """验证状态转移，非法时抛出 ValueError。

    Raises:
        ValueError: 状态转移非法时抛出，带详细错误信息。
    """
    if not validate_transition(from_state, to_state):
        raise ValueError(
            f"[ExecutionState] Invalid state transition: {from_state.value} -> {to_state.value}"
        )
