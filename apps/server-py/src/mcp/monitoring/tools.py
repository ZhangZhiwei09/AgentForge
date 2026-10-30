"""MCP tool 处理函数（薄层）。

校验入参，经监控能力服务检查模式，并组装带来源和查询状态的信封。
MCP tool 定义（名称、描述、inputSchema）由 server.py 在注册时声明。
"""

from __future__ import annotations

import json

from src.services.monitoring import lookup_monitoring_trace

from .schemas import SCHEMA_VERSION

TOOL_NAME = "query_trace_log"

TOOL_DESCRIPTION = (
    "查询单笔核身请求的完整分布式链路日志。传入 traceId，"
    "返回 gateway、face-algorithm、liveness-check、camera-service、sdk-bridge "
    "等多个服务节点的独立 span（各阶段耗时、状态码、错误信息）与诊断建议。"
    "用于定位单个用户刷脸失败的具体原因。"
)


def handle_query_trace_log(traceId: str) -> str:
    """查询单笔 trace 链路日志。

    Args:
        traceId: 链路追踪 ID，如 abc123。

    Returns:
        JSON 信封含 schemaVersion、source、status、data。
        disabled 返回 unavailable；未知模拟 trace 返回 not_found；两者 data 均为 null。
    """
    if not traceId or not traceId.strip():
        raise ValueError("请提供 traceId 以查询链路日志。")

    evidence = lookup_monitoring_trace(traceId)
    return json.dumps(
        {
            "schemaVersion": SCHEMA_VERSION, "data": evidence["trace"],
            "source": evidence["source"], "status": evidence["status"],
        },
        ensure_ascii=False,
    )
