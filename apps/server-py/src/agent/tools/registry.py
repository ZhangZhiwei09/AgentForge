"""Tool Registry —— 工具注册中心。

对应 TS: apps/server/src/tools/registry.ts

设计要点：
- 单例模式，惰性初始化
- 统一 register / get_definitions / execute 接口
- 执行上下文授权、工具范围限制和共享熔断状态
- execute() 内置超时控制（asyncio.wait_for）

Python 新概念：
- asyncio.wait_for: 给工具执行加超时
- 模块级 _initialized 保护惰性初始化幂等
"""

import asyncio
import logging
import time
from dataclasses import dataclass, replace
from typing import Any

from src.agent.tools.base import RISK_TIMEOUTS, RegisteredTool, ToolDefinition
from src.agent.tools.builtins import search_knowledge_tool
from src.observability.metrics import tool_calls, tool_duration
from src.services.execution_policy import ToolExecutionContext, platform_tool_names

logger = logging.getLogger(__name__)


@dataclass
class CircuitState:
    failures: int = 0
    opened_at: float = 0
    probing: bool = False


class ToolRegistry:
    """工具注册中心。

    用法:
        registry = ToolRegistry()
        registry.init()  # 惰性初始化，幂等
        registry = registry.bind(execution_context)  # 服务端身份和策略
        tools = registry.get_definitions()  # 获取发给 LLM 的工具列表
        result = await registry.execute("search_knowledge_base", {"query": "..."}, conversation_id)
    """

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}
        self._initialized = False
        self._circuits: dict[str, CircuitState] = {}
        self.context: ToolExecutionContext | None = None

    def init(self) -> None:
        """惰性初始化，注册所有内置工具。幂等。"""
        if self._initialized:
            return

        # Lazy import to avoid circular dependency:
        # executor → registry → diagnosis/tools → diagnosis/__init__ → mode → executor
        from src.agent.diagnosis.tools import DIAGNOSIS_TOOLS
        from src.agent.tools.builtins.operational import OPERATIONAL_TOOLS

        all_tools = [
            search_knowledge_tool,
            *DIAGNOSIS_TOOLS,
            *OPERATIONAL_TOOLS,
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
        allowed = set(self.list_names())
        for name, tool in self._tools.items():
            if name in allowed and (enabled_tools is None or name in enabled_tools):
                definitions.append(tool.definition)
        return definitions

    def bind(self, context: ToolExecutionContext) -> "ToolRegistry":
        """Create an isolated view; rebinding cannot widen an existing grant."""
        if self.context is not None:
            if (self.context.actor_id, self.context.conversation_id) != (
                context.actor_id, context.conversation_id,
            ):
                raise ValueError("Cannot rebind tool execution to a different principal or conversation")
            context = context.restrict(self.context.policy)
        self.init()
        bound = ToolRegistry()
        bound._tools = dict(self._tools)
        bound._initialized = True
        bound._circuits = self._circuits
        bound.context = context
        return bound

    def _authorized(self, name: str, conversation_id: str) -> bool:
        return (
            self.context is not None
            and self.context.conversation_id == conversation_id
            and name in self.context.policy.tools
            and name in platform_tool_names()
        )

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
            run_id: 历史参数名；调用方传入会话 ID，必须匹配绑定上下文的 conversation_id

        Returns:
            dict with status + output/error
        """
        self.init()

        if not self._authorized(name, run_id):
            return {"status": "failed", "error": "Tool is not authorized for this execution"}
        tool = self._tools.get(name)
        if tool is None:
            return {
                "status": "failed",
                "error": f"Unknown tool '{name}'. Available: {self.list_names()}",
            }

        # Phase C: 创建工具执行 Span
        circuit = self._circuits.setdefault(name, CircuitState())
        if circuit.failures >= 5:
            if time.monotonic() - circuit.opened_at < 60 or circuit.probing:
                return {"status": "failed", "error": f"Tool '{name}' circuit is open"}
            circuit.probing = True

        from src.observability import get_observability

        obs = get_observability()
        tool_span = obs.create_tool_span(
            name=f"tool-{name}",
            input=args,
        )

        timeout = tool.timeout or RISK_TIMEOUTS.get(tool.risk_level, 30000)

        start = time.monotonic()
        result = None
        try:
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

        except TimeoutError:
            result = {
                "status": "timeout",
                "error": f"Tool '{name}' timed out after {timeout}ms",
            }
            tool_span.end(output=result)
            return result
        except asyncio.CancelledError:
            tool_span.end(output={"status": "cancelled"})
            raise
        except Exception as exc:
            logger.exception("Tool execution failed name=%s", name)
            result = {
                "status": "failed",
                "error": f"Tool '{name}' execution error: {exc}",
            }
            tool_span.end(output=result)
            return result
        finally:
            status = result.get("status", "error") if isinstance(result, dict) else "cancelled"
            circuit.probing = False
            if status in {"success", "partial"}:
                circuit.failures = 0
            elif status != "cancelled":
                circuit.failures += 1
                if circuit.failures >= 5:
                    circuit.opened_at = time.monotonic()
            tool_calls.labels("agentforge", name, status).inc()
            tool_duration.labels("agentforge", name).observe((time.monotonic() - start) * 1000)

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
        filtered._circuits = self._circuits
        filtered.context = self.context
        if filtered.context is not None:
            filtered.context = filtered.context.restrict(
                filtered.context.policy.model_copy(update={"tools": tuple(tool_names)}),
            )
        return filtered

    def list_names(self) -> list[str]:
        """列出所有已注册工具名称。"""
        self.init()
        allowed = platform_tool_names()
        if self.context is not None:
            allowed &= set(self.context.policy.tools)
        return [name for name in self._tools if name in allowed]

    def get(self, name: str) -> RegisteredTool | None:
        """Look up execution policy as well as the public tool definition."""
        self.init()
        tool = self._tools.get(name)
        if tool is None:
            return None

        async def authorized(args: dict, run_id: str):
            if not self._authorized(name, run_id):
                return {"status": "failed", "error": "Tool is not authorized for this execution"}
            return await tool.execute(args, run_id)

        return replace(tool, execute=authorized)

    def list_categories(self) -> list[dict[str, Any]]:
        """列出所有工具分类及计数。"""
        self.init()
        cats: dict[str, int] = {}
        for name in self.list_names():
            tool = self._tools[name]
            cats[tool.category] = cats.get(tool.category, 0) + 1
        return [{"category": k, "count": v} for k, v in cats.items()]


# 模块级单例
tool_registry = ToolRegistry()
