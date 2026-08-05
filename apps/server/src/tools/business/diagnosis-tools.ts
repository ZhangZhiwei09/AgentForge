// Business Tools: Diagnosis Monitoring (MCP)
//
// 单工具 query_trace_log：通过 MonitoringMcpClient 调用模拟监控系统 MCP server
// （数据源见 apps/server-py/src/mcp/monitoring/repository.py）。
// 原 query_merchant_metrics / query_error_code_distribution 已随 MCP 能力收缩退役，
// 两条诊断路径（多 agent teams / DiagnosisService 图）统一只暴露 query_trace_log。

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "../types.js";
import type { RunContext } from "../../runtime/context.js";
import type { ExecutionResult } from "../../runtime/results.js";
import {
  failedResult,
  ExecutionErrorCode,
} from "../../runtime/results.js";
import { monitoringMcpClient } from "../../mcp/monitoring-client.js";

// ═══════════════════════════════════════════════════════════
// query_trace_log — query single trace/order diagnostic info via MCP
// ═══════════════════════════════════════════════════════════

const queryTraceLogDef: ToolDefinition = {
  type: "function",
  function: {
    name: "query_trace_log",
    description:
      "查询单笔核身请求的完整分布式链路日志。传入 traceId，返回 gateway、face-algorithm、liveness-check、camera-service、sdk-bridge 等多个服务节点的独立 span（各阶段耗时、状态码、错误信息）与诊断建议。用于定位单用户刷脸失败的具体原因。",
    parameters: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "链路追踪 ID，如 abc123。与 orderId 二选一。",
        },
        orderId: {
          type: "string",
          description: "业务订单 ID。与 traceId 二选一。",
        },
      },
      required: [],
    },
  },
};

async function queryTraceLogExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<ExecutionResult> {
  const lookupKey = String(args.traceId || args.orderId || "");

  if (!lookupKey.trim()) {
    return failedResult(
      ExecutionErrorCode.INVALID_PARAM,
      "请提供 traceId 或 orderId 以查询链路日志。",
    );
  }

  // 走 MCP 管线：连接失败 / 超时 / 格式异常统一返回 failedResult，由
  // toolRegistry 的 circuit breaker 兜底容错。
  return monitoringMcpClient.queryTraceLog(lookupKey.trim());
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

export const diagnosisMonitoringTools: RegisteredTool[] = [
  {
    definition: queryTraceLogDef,
    execute: queryTraceLogExecute,
    riskLevel: "read_only",
    timeout: 15_000, // MCP HTTP 调用（连接 + 重试）比内存查表慢，留足余量
    requireApproval: false,
    category: "business",
    parallelizable: true,
  },
];
