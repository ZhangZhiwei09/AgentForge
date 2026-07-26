"""Tool 协议与类型定义。

对应 TS: apps/server/src/tools/types.ts

Python 新概念：
- Protocol: 定义 ToolExecutor 可调用协议
- RiskLevel StrEnum: 风险等级枚举
- ToolDefinition: 符合 OpenAI function calling 格式的 JSON Schema
"""

from collections.abc import Awaitable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol


class RiskLevel(StrEnum):
    """工具风险等级，用于审批门控和沙箱隔离。"""
    SAFE = "safe"            # 安全操作（获取时间、计算）
    READ_ONLY = "read_only"  # 只读操作（搜索、查询）
    MUTATION = "mutation"    # 变更操作（HTTP POST、创建工单）
    DESTRUCTIVE = "destructive"  # 破坏性操作（删除、格式化）


# 默认超时（毫秒）
RISK_TIMEOUTS: dict[RiskLevel, int] = {
    RiskLevel.SAFE: 5000,
    RiskLevel.READ_ONLY: 15000,
    RiskLevel.MUTATION: 30000,
    RiskLevel.DESTRUCTIVE: 60000,
}


# ── Tool Definition ───────────────────────────────────────
# 符合 OpenAI function calling 格式


@dataclass(slots=True)
class ToolFunction:
    """工具函数定义。"""
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolDefinition:
    """工具定义，符合 OpenAI function calling JSON Schema。

    Example:
        ToolDefinition(
            type="function",
            function=ToolFunction(
                name="get_current_time",
                description="获取当前时间",
                parameters={"type": "object", "properties": {...}},
            ),
        )
    """
    type: str = "function"
    function: ToolFunction = field(default_factory=lambda: ToolFunction(name="", description=""))


# ── Tool Executor ─────────────────────────────────────────


class ToolExecutor(Protocol):
    """工具执行函数协议。

    签名: (args: dict[str, Any], run_id: str) -> dict[str, Any]
    - args: LLM 传入的参数
    - run_id: 当前运行的 ID（用于日志追踪）

    返回 dict 包含:
    - status: "success" | "partial" | "failed" | "cancelled" | "timeout"
    - output: 执行结果字符串
    - error: 错误信息（仅 failed 状态）
    """

    async def __call__(self, args: dict[str, Any], run_id: str) -> dict[str, Any]:
        ...


# ── Registered Tool ───────────────────────────────────────


@dataclass(slots=True)
class RegisteredTool:
    """注册到 ToolRegistry 的完整工具。

    Attributes:
        definition: 工具 JSON Schema 定义（发给 LLM）
        execute: 执行函数
        risk_level: 风险等级
        timeout: 超时时间（毫秒）
        require_approval: 是否需要人工审批
        category: 工具分类（utility/file/network/search 等）
        parallelizable: 是否可与其他工具并行执行
    """
    definition: ToolDefinition
    execute: ToolExecutor
    risk_level: RiskLevel = RiskLevel.SAFE
    timeout: int = 5000
    require_approval: bool = False
    category: str = "utility"
    parallelizable: bool = True
