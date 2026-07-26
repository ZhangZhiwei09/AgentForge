"""Blackboard —— 多 Agent 共享上下文黑板。

对应 TS: apps/server/src/teams/blackboard.ts

所有 Agent 通过 Blackboard 读写共享状态，实现累积式知识构建。
支持版本控制和历史追踪。
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass(slots=True)
class BlackboardEntry:
    """Blackboard 中的一条记录。"""
    key: str
    value: object
    written_by: str
    timestamp: str
    version: int
    metadata: dict | None = None


class Blackboard:
    """共享上下文黑板 —— 版本控制的键值存储。

    用法:
        bb = Blackboard()
        bb.write("task", "排查刷脸失败", "system")
        bb.write("conclusion", {...}, "frontend_agent")
        ctx = bb.to_context_string()  # 注入 Agent prompt
    """

    def __init__(self) -> None:
        self._entries: dict[str, BlackboardEntry] = {}
        self._history: list[BlackboardEntry] = []

    def write(
        self,
        key: str,
        value: object,
        agent_name: str,
        metadata: dict | None = None,
    ) -> BlackboardEntry:
        """写入一个值（带版本控制）。

        如果 key 已存在，版本号自动递增。
        """
        prev = self._entries.get(key)
        entry = BlackboardEntry(
            key=key,
            value=value,
            written_by=agent_name,
            timestamp=datetime.now(timezone.utc).isoformat(),
            version=(prev.version + 1) if prev else 1,
            metadata=metadata,
        )
        self._entries[key] = entry
        self._history.append(entry)
        return entry

    def read(self, key: str) -> object | None:
        """读取 key 的最新值。"""
        entry = self._entries.get(key)
        return entry.value if entry else None

    def get_entry(self, key: str) -> BlackboardEntry | None:
        """获取完整 entry（含元数据、版本等）。"""
        return self._entries.get(key)

    def has(self, key: str) -> bool:
        """检查 key 是否存在。"""
        return key in self._entries

    def snapshot(self) -> dict[str, object]:
        """获取所有当前 entry 的快照（plain dict）。"""
        return {key: entry.value for key, entry in self._entries.items()}

    def entries_by_agent(self, agent_name: str) -> list[BlackboardEntry]:
        """获取某个 Agent 写入的所有 entry（跨所有 key）。"""
        return [e for e in self._history if e.written_by == agent_name]

    def get_history(self, key: str) -> list[BlackboardEntry]:
        """获取某个 key 的完整版本历史。"""
        return [e for e in self._history if e.key == key]

    def delete(self, key: str, agent_name: str) -> bool:
        """删除一个 key（仅写入者可以删除）。"""
        entry = self._entries.get(key)
        if entry and entry.written_by == agent_name:
            del self._entries[key]
            return True
        return False

    def keys(self) -> list[str]:
        """获取所有 key。"""
        return list(self._entries.keys())

    @property
    def size(self) -> int:
        """当前 entry 数量。"""
        return len(self._entries)

    @property
    def history_count(self) -> int:
        """历史记录总数（含所有版本）。"""
        return len(self._history)

    def serialize(self) -> dict[str, object]:
        """序列化为 plain dict（用于 DB 持久化）。"""
        return self.snapshot()

    def to_context_string(self) -> str:
        """转换为 context string，用于注入 Agent System Prompt。

        格式为中文 markdown，与 TS 版本保持一致。
        """
        if not self._entries:
            return "(Blackboard 为空)"

        lines = ["## 共享 Blackboard (最新值):\n"]
        for key, entry in self._entries.items():
            if isinstance(entry.value, str):
                val = entry.value
            else:
                import json as _json
                val = _json.dumps(entry.value, ensure_ascii=False)
            lines.append(
                f"- **{key}** (由 {entry.written_by} 写入, v{entry.version}): "
                f"{val[:300]}"
            )
        return "\n".join(lines)

    def clear(self) -> None:
        """清空所有 entry 和历史。"""
        self._entries.clear()
        self._history.clear()
