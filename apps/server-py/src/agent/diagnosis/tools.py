"""Diagnosis Monitoring Tools —— 诊断监控工具。

对应 TS: apps/server/src/tools/business/diagnosis-tools.ts

提供 1 个监控工具 query_trace_log，数据源复用模拟监控系统 MCP server 的共享
repository（src.mcp.monitoring.repository），不再维护本地 mock 拷贝。
原 query_merchant_metrics / query_error_code_distribution 已随 MCP 能力收缩退役。
"""

from src.agent.tools.base import (
    RegisteredTool,
    RiskLevel,
    ToolDefinition,
    ToolFunction,
)
from src.mcp.monitoring.repository import is_known_trace, lookup_trace


async def _query_trace_log(args: dict, run_id: str) -> dict:
    """查询单笔核身请求的完整链路日志。

    Args:
        args: {"traceId": "abc123"}
        run_id: 当前运行 ID（未使用）
    """
    trace_id = str(args.get("traceId") or "")

    if not trace_id.strip():
        return {
            "status": "failed",
            "error": "请提供 traceId 以查询链路日志。",
        }

    trace = lookup_trace(trace_id.strip())
    output = trace.model_dump()

    if not is_known_trace(trace_id.strip()):
        output["_note"] = (
            f'未命中模拟数据（traceId="{trace_id.strip()}"），返回默认通用结果。'
        )

    return {"status": "success", "output": output}


query_trace_log_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="query_trace_log",
            description=(
                "查询单笔核身请求的完整分布式链路日志。传入 traceId，"
                "返回 gateway、face-algorithm、liveness-check、camera-service、"
                "sdk-bridge 等多个服务节点的独立 span（各阶段耗时、状态码、"
                "错误信息）与诊断建议。用于定位单个用户刷脸失败的具体原因。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "traceId": {
                        "type": "string",
                        "description": "链路追踪 ID，如 abc123。",
                    },
                },
                "required": ["traceId"],
            },
        ),
    ),
    execute=_query_trace_log,
    risk_level=RiskLevel.READ_ONLY,
    timeout=10_000,
    require_approval=False,
    category="diagnosis",
    parallelizable=True,
)

DIAGNOSIS_TOOLS: list[RegisteredTool] = [query_trace_log_tool]
