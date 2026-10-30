"""Evaluation-only wrappers for observing tool calls without changing tools."""

import time
from collections.abc import Callable
from typing import Any

from src.agent.tools.registry import ToolRegistry
from src.evaluation.types import ToolCallSnapshot


class ObservedToolRegistry:
    """Delegate a ToolRegistry while reporting bounded call facts to a callback."""

    def __init__(
        self,
        registry: ToolRegistry,
        observer: Callable[[ToolCallSnapshot], None],
    ) -> None:
        self._registry = registry
        self._observer = observer

    def init(self) -> None:
        self._registry.init()

    @property
    def context(self):
        return self._registry.context

    def bind(self, context):
        return ObservedToolRegistry(self._registry.bind(context), self._observer)

    def filter(self, names: list[str]):
        return ObservedToolRegistry(self._registry.filter(names), self._observer)

    def get_definitions(self, enabled_tools: list[str] | None = None):
        return self._registry.get_definitions(enabled_tools)

    def get(self, name: str):
        return self._registry.get(name)

    async def execute(self, name: str, args: dict[str, Any], run_id: str) -> dict[str, Any]:
        started = time.perf_counter()
        result: dict[str, Any]
        try:
            result = await self._registry.execute(name, args, run_id)
        except Exception as exc:  # noqa: BLE001 - preserve registry behavior
            result = {"status": "failed", "error": str(exc)}
        self._observer(
            ToolCallSnapshot(
                name=name,
                arguments=dict(args),
                result=result,
                status=result.get("status"),
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                source="observer",
            )
        )
        return result

    def list_names(self) -> list[str]:
        return self._registry.list_names()
