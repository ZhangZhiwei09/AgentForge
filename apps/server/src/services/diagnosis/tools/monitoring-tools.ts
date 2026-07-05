import type { DiagnosisToolCall, DiagnosisToolResult } from "../schemas.js";
import {
  defaultMerchantMetrics,
  defaultTraceLog,
  mockMerchantMetrics,
  mockTraceLogs,
} from "./mock-monitoring-data.js";

export interface DiagnosisMonitoringTools {
  execute(call: DiagnosisToolCall): Promise<DiagnosisToolResult>;
}

export class MockDiagnosisMonitoringTools implements DiagnosisMonitoringTools {
  async execute(call: DiagnosisToolCall): Promise<DiagnosisToolResult> {
    if (call.name === "query_trace_log") {
      const traceId = String(call.args.traceId ?? "");
      const data =
        mockTraceLogs[traceId as keyof typeof mockTraceLogs] ??
        { ...defaultTraceLog, traceId };

      return {
        toolName: call.name,
        ok: true,
        summary: `单笔链路 ${traceId || "unknown"} 返回错误码 ${data.errorCode}，阶段 ${data.stage}。`,
        data: data as unknown as Record<string, unknown>,
      };
    }

    const merchantId = String(call.args.merchantId ?? "");
    const data =
      mockMerchantMetrics[merchantId as keyof typeof mockMerchantMetrics] ??
      { ...defaultMerchantMetrics, merchantId };

    return {
      toolName: call.name,
      ok: true,
      summary: `商户 ${merchantId || "unknown"} 成功率 ${(data.successRate * 100).toFixed(1)}%，基线 ${(data.baselineSuccessRate * 100).toFixed(1)}%。`,
      data: data as unknown as Record<string, unknown>,
    };
  }
}

