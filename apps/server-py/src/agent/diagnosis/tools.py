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
from src.services.monitoring import lookup_monitoring_trace


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

    evidence = lookup_monitoring_trace(trace_id)
    if evidence["status"] != "found":
        return {
            "status": "failed", "evidence_status": evidence["status"],
            "source": evidence["source"], "error": "未获得监控证据，不能据此确认故障根因。",
        }
    return {
        "status": "success", "source": "mock", "evidence_status": "found",
        "output": {**evidence["trace"], "_source": "mock", "_note": "模拟数据，仅用于演示，不能用于真实故障判定。"},
    }


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
