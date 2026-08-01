"""Tests for Blackboard — shared context store for multi-agent collaboration.
"""

import json

from src.agent.diagnosis.blackboard import Blackboard


class TestBlackboard:
    """Blackboard tests."""

    def setup_method(self):
        self.bb = Blackboard()

    def test_write_and_read(self):
        self.bb.write("task", "排查刷脸失败", "system")
        assert self.bb.read("task") == "排查刷脸失败"

    def test_read_missing_key(self):
        assert self.bb.read("nonexistent") is None

    def test_get_entry(self):
        entry = self.bb.write("key1", "value1", "agent_a")
        retrieved = self.bb.get_entry("key1")
        assert retrieved is not None
        assert retrieved.key == "key1"
        assert retrieved.value == "value1"
        assert retrieved.written_by == "agent_a"
        assert retrieved.version == 1

    def test_version_increment(self):
        self.bb.write("key1", "v1", "agent_a")
        self.bb.write("key1", "v2", "agent_b")
        entry = self.bb.get_entry("key1")
        assert entry is not None
        assert entry.version == 2
        assert entry.value == "v2"
        assert entry.written_by == "agent_b"

    def test_has_key(self):
        assert not self.bb.has("task")
        self.bb.write("task", "test", "system")
        assert self.bb.has("task")

    def test_snapshot(self):
        self.bb.write("k1", "v1", "agent_a")
        self.bb.write("k2", {"nested": True}, "agent_b")
        snap = self.bb.snapshot()
        assert snap == {"k1": "v1", "k2": {"nested": True}}

    def test_entries_by_agent(self):
        self.bb.write("k1", "v1", "agent_a")
        self.bb.write("k2", "v2", "agent_b")
        self.bb.write("k3", "v3", "agent_a")

        a_entries = self.bb.entries_by_agent("agent_a")
        assert len(a_entries) == 2

        b_entries = self.bb.entries_by_agent("agent_b")
        assert len(b_entries) == 1

    def test_history(self):
        self.bb.write("key1", "v1", "agent_a")
        self.bb.write("key1", "v2", "agent_a")
        self.bb.write("key2", "v1", "agent_b")

        hist = self.bb.get_history("key1")
        assert len(hist) == 2
        assert hist[0].version == 1
        assert hist[1].version == 2

    def test_delete_own_entry(self):
        self.bb.write("key1", "value", "agent_a")
        assert self.bb.delete("key1", "agent_a") is True
        assert not self.bb.has("key1")

    def test_delete_other_agent_entry(self):
        self.bb.write("key1", "value", "agent_a")
        assert self.bb.delete("key1", "agent_b") is False
        assert self.bb.has("key1")

    def test_keys(self):
        self.bb.write("a", 1, "x")
        self.bb.write("b", 2, "x")
        assert set(self.bb.keys()) == {"a", "b"}

    def test_size(self):
        assert self.bb.size == 0
        self.bb.write("a", 1, "x")
        assert self.bb.size == 1
        self.bb.write("b", 2, "x")
        assert self.bb.size == 2
        # Overwrite
        self.bb.write("a", 3, "y")
        assert self.bb.size == 2

    def test_history_count(self):
        assert self.bb.history_count == 0
        self.bb.write("a", 1, "x")
        assert self.bb.history_count == 1
        self.bb.write("a", 2, "x")  # Overwrite adds to history
        assert self.bb.history_count == 2

    def test_to_context_string_empty(self):
        ctx = self.bb.to_context_string()
        assert "为空" in ctx

    def test_to_context_string_with_entries(self):
        self.bb.write("task", "排查刷脸失败", "system")
        self.bb.write("frontend_conclusion", "摄像头权限被拒绝", "frontend_agent")
        ctx = self.bb.to_context_string()
        assert "task" in ctx
        assert "frontend_conclusion" in ctx
        assert "system" in ctx
        assert "frontend_agent" in ctx
        assert "排查刷脸失败" in ctx
        assert "摄像头权限被拒绝" in ctx

    def test_serialize(self):
        self.bb.write("k1", "v1", "agent_a")
        self.bb.write("k2", {"key": "val"}, "agent_b")
        data = self.bb.serialize()
        assert data == {"k1": "v1", "k2": {"key": "val"}}

    def test_clear(self):
        self.bb.write("k1", "v1", "agent_a")
        self.bb.clear()
        assert self.bb.size == 0
        assert self.bb.history_count == 0
        assert self.bb.keys() == []


class TestBlackboardSerializeRoundtrip:
    """serialize() 的 JSON 往返守卫（multi-agent-langgraph-plan.md §3.3）。"""

    def test_json_roundtrip(self):
        bb = Blackboard()
        bb.write("k1", "v1", "agent_a")
        bb.write("k2", {"key": "val", "n": 3, "flag": True}, "agent_b")
        data = bb.serialize()
        # JSON 往返成功，且值不被改写
        assert json.loads(json.dumps(data)) == data
        assert data == {"k1": "v1", "k2": {"key": "val", "n": 3, "flag": True}}

    def test_non_json_value_degrades_to_str(self):
        bb = Blackboard()
        # 类型层之外的非法值（运行时绕过 JSONValue 注解）
        bb.write("bad", object(), "agent_a")
        data = bb.serialize()
        assert isinstance(data["bad"], str)
        # 降级后整表仍可 JSON 序列化
        assert json.loads(json.dumps(data)) == data
