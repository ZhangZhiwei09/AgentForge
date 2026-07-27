"""Tool Registry —— 工具注册中心。

对应 TS: apps/server/src/tools/registry.ts

设计要点：
- 单例模式，惰性初始化
- 统一 register / get_definitions / execute 接口
- V1 简化版：不做 Circuit Breaker（留给 Step 10 后期或 Step 11）
- execute() 内置超时控制（asyncio.wait_for）

Python 新概念：
- asyncio.wait_for: 给工具执行加超时
- 模块级 _initialized 保护惰性初始化幂等
"""

import asyncio
import time
from typing import Any

from src.agent.tools.base import RISK_TIMEOUTS, RegisteredTool, ToolDefinition
from src.agent.tools.builtins import search_knowledge_tool


class ToolRegistry:
    """工具注册中心。

    用法:
        registry = ToolRegistry()
        registry.init()  # 惰性初始化，幂等
        tools = registry.get_definitions()  # 获取发给 LLM 的工具列表
        result = await registry.execute("search_knowledge_base", {"query": "..."}, run_id)
    """

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}
        self._initialized = False

    def init(self) -> None:
        """惰性初始化，注册所有内置工具。幂等。"""
        if self._initialized:
            return

        # Lazy import to avoid circular dependency:
        # executor → registry → diagnosis/tools → diagnosis/__init__ → mode → executor
        from src.agent.diagnosis.tools import DIAGNOSIS_TOOLS  # noqa: PLC0415

        all_tools = [
            search_knowledge_tool,
            *DIAGNOSIS_TOOLS,
        ]
        for tool in all_tools:
            self.register(tool)

        self._initialized = True

    def register(self, tool: RegisteredTool) -> None:
        """注册单个工具。同名工具会被覆盖。"""
        name = tool.definition.function.name
        self._tools[name] = tool

    def get_definitions(self, enabled_tools: list[str] | None = None) -> list[ToolDefinition]:
        """获取发给 LLM 的工具定义列表。

        Args:
            enabled_tools: 允许的工具名称列表，None 表示全部返回
        """
        self.init()
        definitions: list[ToolDefinition] = []
        for name, tool in self._tools.items():
            if enabled_tools is None or name in enabled_tools:
                definitions.append(tool.definition)
        return definitions

    async def execute(
        self,
        name: str,
        args: dict[str, Any],
        run_id: str,
    ) -> dict[str, Any]:
        """执行工具。

        Phase C: 每次工具执行包裹在 Langfuse Tool Span 中。

        Args:
            name: 工具名称
            args: LLM 传入的参数
            run_id: 当前运行 ID

        Returns:
            dict with status + output/error
        """
        self.init()

        tool = self._tools.get(name)
        if tool is None:
            return {
                "status": "failed",
                "error": f"Unknown tool '{name}'. Available: {self.list_names()}",
            }

        # Phase C: 创建工具执行 Span
        from src.observability import get_observability  # noqa: PLC0415

        obs = get_observability()
        tool_span = obs.create_tool_span(
            name=f"tool-{name}",
            input=args,
        )

        timeout = tool.timeout or RISK_TIMEOUTS.get(tool.risk_level, 30000)

        try:
            start = time.monotonic()
            result = await asyncio.wait_for(
                tool.execute(args, run_id),
                timeout=timeout / 1000,
            )
            elapsed = (time.monotonic() - start) * 1000

            # 注入耗时（如果工具未提供）
            if "duration_ms" not in result:
                result["duration_ms"] = round(elapsed, 2)

            tool_span.end(
                output=result,
                metadata={"duration_ms": round(elapsed, 2)},
            )

            return result

        except asyncio.TimeoutError:
            result = {
                "status": "timeout",
                "error": f"Tool '{name}' timed out after {timeout}ms",
            }
            tool_span.end(output=result)
            return result
        except Exception as exc:
            result = {
                "status": "failed",
                "error": f"Tool '{name}' execution error: {exc}",
            }
            tool_span.end(output=result)
            return result

    def filter(self, tool_names: list[str]) -> "ToolRegistry":
        """创建仅包含指定工具的过滤副本。

        用于多 Agent 场景下按角色限制可用工具集。
        对应 TS: AgentService.run() 的 tools 参数。
        """
        filtered = ToolRegistry()
        self.init()
        for name in tool_names:
            if name in self._tools:
                filtered._tools[name] = self._tools[name]
        filtered._initialized = True
        return filtered

    def list_names(self) -> list[str]:
        """列出所有已注册工具名称。"""
        self.init()
        return list(self._tools.keys())

    def list_categories(self) -> list[dict[str, Any]]:
        """列出所有工具分类及计数。"""
        self.init()
        cats: dict[str, int] = {}
        for tool in self._tools.values():
            cats[tool.category] = cats.get(tool.category, 0) + 1
        return [{"category": k, "count": v} for k, v in cats.items()]


# 模块级单例
tool_registry = ToolRegistry()
