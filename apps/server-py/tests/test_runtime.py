"""测试：Runtime 模块 (Step 7-9)。"""

import asyncio

import pytest

from src.runtime.context import RunContext, create_child_context, create_run_context
from src.runtime.events import EventBus, RuntimeEvent
from src.runtime.node import ExecutionNode, RunTermination
from src.runtime.state import (
    TERMINAL_STATES,
    VALID_TRANSITIONS,
    ExecutionState,
    assert_valid_transition,
    is_terminal,
    validate_transition,
)
from src.runtime.tree import count_nodes, find_node, flatten_tree, get_depth, get_root


# ═══════════════════════════════════════════════════════════
# RunContext
# ═══════════════════════════════════════════════════════════


class TestRunContext:
    """RunContext 不可变上下文测试。"""

    def test_create_root_context(self):
        """根 Context 的 run_id 应在 ancestry[0] 中。"""
        ctx = create_run_context()
        assert len(ctx.ancestry) == 1
        assert ctx.run_id == ctx.ancestry[0]

    def test_create_child_context(self):
        """子 Context 继承 signal，ancestry 追加。"""
        parent = create_run_context()
        child = create_child_context(parent)
        assert len(child.ancestry) == 2
        assert child.ancestry[0] == parent.run_id
        assert child.ancestry[1] == child.run_id
        assert child.signal is parent.signal

    def test_context_is_frozen(self):
        """frozen dataclass 禁止字段赋值。"""
        ctx = create_run_context()
        with pytest.raises(Exception):
            ctx.run_id = "hacked"  # type: ignore[misc]

    def test_abort_signal(self):
        """取消信号应传播到所有子 Context。"""
        parent = create_run_context()
        child = create_child_context(parent)
        assert not parent.is_aborted
        assert not child.is_aborted
        parent.abort()
        assert parent.is_aborted
        assert child.is_aborted

    def test_custom_run_id(self):
        """自定义 run_id 应生效。"""
        ctx = create_run_context(run_id="custom-1")
        assert ctx.run_id == "custom-1"
        assert ctx.ancestry == ("custom-1",)


# ═══════════════════════════════════════════════════════════
# ExecutionState
# ═══════════════════════════════════════════════════════════


class TestExecutionState:
    """状态机测试。"""

    def test_valid_transition_created_to_running(self):
        assert validate_transition(ExecutionState.CREATED, ExecutionState.RUNNING) is True

    def test_valid_transition_running_to_completed(self):
        assert validate_transition(ExecutionState.RUNNING, ExecutionState.COMPLETED) is True

    def test_valid_transition_created_to_cancelled(self):
        """允许未启动就取消。"""
        assert validate_transition(ExecutionState.CREATED, ExecutionState.CANCELLED) is True

    def test_invalid_transition_completed_to_running(self):
        """终态不可逆。"""
        assert validate_transition(ExecutionState.COMPLETED, ExecutionState.RUNNING) is False

    def test_invalid_transition_guard(self):
        """非法转换应抛出 ValueError。"""
        with pytest.raises(ValueError, match="Invalid state transition"):
            assert_valid_transition(ExecutionState.COMPLETED, ExecutionState.RUNNING)

    def test_terminal_states(self):
        for state in TERMINAL_STATES:
            assert is_terminal(state) is True

    def test_active_states(self):
        assert is_terminal(ExecutionState.CREATED) is False
        assert is_terminal(ExecutionState.RUNNING) is False

    def test_transition_table_completeness(self):
        """每个非终态都应有合法转换目标。"""
        for state in ExecutionState:
            targets = VALID_TRANSITIONS.get(state)
            assert targets is not None, f"Missing transitions for {state}"


# ═══════════════════════════════════════════════════════════
# ExecutionNode
# ═══════════════════════════════════════════════════════════


class TestExecutionNode:
    """ExecutionNode 生命周期测试。"""

    def test_initial_state(self):
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        assert node.state == ExecutionState.CREATED
        assert not node.is_terminal

    def test_start_and_complete(self):
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        node.start()
        assert node.state == ExecutionState.RUNNING
        result = node.complete()
        assert result.termination == RunTermination.Completed
        assert node.is_terminal

    def test_fail(self):
        ctx = create_run_context()
        node = ExecutionNode("agent", ctx)
        node.start()
        result = node.fail("test error")
        assert result.termination == RunTermination.Failed
        assert result.error == "test error"

    def test_cancel_idempotent(self):
        """cancel() 可重复调用。"""
        ctx = create_run_context()
        node = ExecutionNode("tool", ctx)
        node.start()
        r1 = node.cancel("reason 1")
        r2 = node.cancel("reason 2")
        assert r1.termination == RunTermination.Cancelled
        assert r2.termination == RunTermination.Cancelled

    def test_cancel_before_start(self):
        """允许取消未启动的节点。"""
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        result = node.cancel("early cancel")
        assert result.termination == RunTermination.Cancelled

    def test_timeout(self):
        ctx = create_run_context()
        node = ExecutionNode("workflow", ctx)
        node.start()
        result = node.timeout(3000)
        assert result.termination == RunTermination.Timeout
        assert "3000ms" in str(result.error)

    def test_invalid_transition(self):
        """终态 → start 应报错。"""
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        node.start()
        node.complete()
        with pytest.raises(ValueError, match="Invalid state transition"):
            node.start()

    def test_create_child(self):
        ctx = create_run_context()
        parent = ExecutionNode("chat", ctx)
        child = parent.create_child("tool")
        assert len(parent.children) == 1
        assert child.parent is parent
        assert len(child.context.ancestry) == 2

    def test_parent_complete_cancels_children(self):
        """父 completed → 活跃子节点被取消。"""
        ctx = create_run_context()
        parent = ExecutionNode("chat", ctx)
        child = parent.create_child("tool")
        child.start()
        parent.start()
        parent.complete()
        assert child.state == ExecutionState.CANCELLED

    def test_state_change_listener(self):
        """状态变更应通知监听器。"""
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        states = []
        unsub = node.on_state_change(lambda s: states.append(s))
        node.start()
        node.complete()
        assert states == [ExecutionState.RUNNING, ExecutionState.COMPLETED]
        unsub()

    def test_duration(self):
        """duration 应在 start 后 > 0。"""
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        assert node.duration == 0.0
        node.start()
        assert node.duration >= 0.0

    def test_should_stop(self):
        """取消后 should_stop 应为 True。"""
        ctx = create_run_context()
        node = ExecutionNode("chat", ctx)
        assert not node.should_stop
        ctx.abort()
        assert node.should_stop


# ═══════════════════════════════════════════════════════════
# Tree operations
# ═══════════════════════════════════════════════════════════


class TestTree:
    """树操作测试。"""

    def test_flatten_tree(self):
        ctx = create_run_context()
        root = ExecutionNode("chat", ctx)
        a = root.create_child("agent")
        b = a.create_child("tool")
        flat = flatten_tree(root)
        assert len(flat) == 3
        assert flat[0] is root
        assert flat[1] is a
        assert flat[2] is b

    def test_find_node(self):
        ctx = create_run_context()
        root = ExecutionNode("chat", ctx)
        child = root.create_child("tool")
        found = find_node(root, child.id)
        assert found is child
        assert find_node(root, "nonexistent") is None

    def test_get_root(self):
        ctx = create_run_context()
        root = ExecutionNode("chat", ctx)
        leaf = root.create_child("tool")
        assert get_root(leaf) is root

    def test_get_depth(self):
        ctx = create_run_context()
        root = ExecutionNode("chat", ctx)
        child = root.create_child("agent")
        grandchild = child.create_child("tool")
        assert get_depth(root) == 0
        assert get_depth(child) == 1
        assert get_depth(grandchild) == 2

    def test_count_nodes(self):
        ctx = create_run_context()
        root = ExecutionNode("chat", ctx)
        root.create_child("agent")
        root.create_child("tool")
        assert count_nodes(root) == 3


# ═══════════════════════════════════════════════════════════
# EventBus
# ═══════════════════════════════════════════════════════════


class TestEventBus:
    """EventBus pub/sub 测试。"""

    def test_publish_and_receive(self):
        bus = EventBus()
        q = bus.subscribe("test:event")
        bus.publish(RuntimeEvent(type="test:event", node_id="n1"))
        event = q.get_nowait()
        assert event.type == "test:event"
        assert event.node_id == "n1"

    def test_unsubscribe(self):
        bus = EventBus()
        q = bus.subscribe("test:event")
        bus.unsubscribe("test:event", q)
        assert bus.subscriber_count == 0

    def test_close_with_sentinel(self):
        bus = EventBus()
        q = bus.subscribe("test:event")
        bus.close("test:event")
        sentinel = q.get_nowait()
        assert sentinel is None

    def test_no_subscriber_no_error(self):
        """发布到无人订阅的类型不应报错。"""
        bus = EventBus()
        bus.publish(RuntimeEvent(type="nobody:listens", node_id="x"))
        # no error = pass

    def test_multiple_subscribers(self):
        bus = EventBus()
        q1 = bus.subscribe("test:event")
        q2 = bus.subscribe("test:event")
        bus.publish(RuntimeEvent(type="test:event", node_id="n1"))
        assert q1.get_nowait().node_id == "n1"
        assert q2.get_nowait().node_id == "n1"
