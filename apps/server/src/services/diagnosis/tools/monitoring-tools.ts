// Diagnosis 监控工具 —— DiagnosisService 图路径的监控数据访问层。
//
// 两条路径统一到 MCP 管线后，唯一实现为 McpDiagnosisMonitoringTools（调用
// 模拟监控 MCP server，数据源见 apps/server-py/src/mcp/monitoring/repository.py）。

import type { DiagnosisToolCall, DiagnosisToolResult } from "../schemas.js";
import {
  monitoringMcpClient,
  parseTraceEnvelope,
} from "../../../mcp/monitoring-client.js";

export interface DiagnosisMonitoringTools {
  execute(call: DiagnosisToolCall): Promise<DiagnosisToolResult>;
}

/**
 * 基于 MCP 模拟监控系统的监控工具实现。
 * 仅支持 query_trace_log（merchant/distribution 能力已随 MCP 收缩退役）。
 */
export class McpDiagnosisMonitoringTools implements DiagnosisMonitoringTools {
  async execute(call: DiagnosisToolCall): Promise<DiagnosisToolResult> {
    if (call.name !== "query_trace_log") {
      return {
        toolName: call.name,
        ok: false,
        summary: `未知监控工具：${call.name}`,
        data: {},
      };
    }

    const traceId = String(call.args.traceId ?? call.args.orderId ?? "");
    if (!traceId.trim()) {
      return {
        toolName: call.name,
        ok: false,
        summary: "请提供 traceId 以查询链路日志。",
        data: {},
      };
    }

    const result = await monitoringMcpClient.queryTraceLog(traceId.trim());
    if (result.status !== "success") {
      const message =
        result.status === "failed"
          ? result.error.message
          : `MCP 调用未完成（${result.status}）`;
      return { toolName: call.name, ok: false, summary: message, data: {} };
    }

    const envelope = parseTraceEnvelope(result.output);
    if (!envelope) {
      return {
        toolName: call.name,
        ok: false,
        summary: "MCP 返回数据格式异常。",
        data: {},
      };
    }

    return {
      toolName: call.name,
      ok: true,
      summary: envelope.data.conclusion,
      data: envelope.data,
    };
  }
}
