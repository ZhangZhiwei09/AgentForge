// DiagnosisService 图 × McpDiagnosisMonitoringTools 集成测试。
//
// 知识库检索 mock，MCP 客户端用 spyOn 打桩（envelope 结构与真实 MCP server
// 返回一致）；验证 DiagnosisService 默认注入的 McpDiagnosisMonitoringTools
// 把 MCP 返回的真实 trace 数据流进诊断结论，以及 MCP 不可用时的降级。

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HybridSearchResult } from "../../knowledge.js";
import { DiagnosisService } from "../graph.js";
import { monitoringMcpClient } from "../../../mcp/monitoring-client.js";
import {
  ExecutionErrorCode,
  failedResult,
  successResult,
} from "../../../runtime/results.js";

const fakeDocs: HybridSearchResult[] = [
  {
    chunkId: "chunk-face-timeout",
    docId: "doc-error-code",
    kbId: "kb-identity",
    content:
      "FACE_TIMEOUT 通常表示活体采集或人脸核验链路超时，需要检查网络、摄像头权限、SDK 版本和接口耗时。",
    score: 0.93,
    fusionScore: 0.03,
    recallSources: ["elasticsearch"],
    chunkIndex: 0,
    docTitle: "活体错误码排查手册",
  },
];

const validEnvelope = {
  schemaVersion: "1.0",
  data: {
    traceId: "abc123",
    orderId: "order_20260804_0001",
    product: "liveness",
    clientType: "h5",
    sdkVersion: "3.1.8",
    overallDurationMs: 6550,
    overallStatus: "failed",
    errorCode: "FACE_TIMEOUT",
    errorStage: "face_capture",
    spans: [
      {
        spanId: "span-002",
        serviceName: "face-algorithm",
        operationName: "liveness_detect",
        startTime: "2026-08-04T10:00:00.050Z",
        endTime: "2026-08-04T10:00:05.250Z",
        durationMs: 5200,
        status: "timeout",
        errorCode: "FACE_TIMEOUT",
        errorMessage: "推理超时",
        tags: { cpuUsage: "87%" },
      },
    ],
    conclusion: "该笔请求在活体算法处理阶段耗时 5200ms，根因：算法节点负载过高。",
  },
};

function createService() {
  const knowledgeRetriever = {
    searchHybrid: vi.fn(async () => fakeDocs),
  };
  // 默认注入 McpDiagnosisMonitoringTools（graph.ts 默认值），此处不覆盖 monitoringTools
  const service = new DiagnosisService({ knowledgeRetriever });
  return { service, knowledgeRetriever };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("DiagnosisService × McpDiagnosisMonitoringTools", () => {
  it("flows real MCP trace data into the diagnosis answer", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockResolvedValue(
      successResult(JSON.stringify(validEnvelope)),
    );

    const { service } = createService();
    const result = await service.run({ query: "traceId abc123 用户刷脸失败，帮忙看下" });

    expect(result.intent).toBe("single_trace_diagnosis");
    expect(result.status).toBe("diagnosed");
    expect(monitoringMcpClient.queryTraceLog).toHaveBeenCalledWith("abc123");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].ok).toBe(true);
    expect(result.toolResults[0].data.errorCode).toBe("FACE_TIMEOUT");
    expect(result.toolResults[0].data.spans).toHaveLength(1);
    expect(result.answer).toContain("算法节点负载过高");
    expect(result.answer).toContain("FACE_TIMEOUT");
  });

  it("degrades gracefully when MCP monitoring is unavailable", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockResolvedValue(
      failedResult(ExecutionErrorCode.NETWORK_ERROR, "MCP 监控服务不可用，无法查询链路日志。", true),
    );

    const { service } = createService();
    const result = await service.run({ query: "traceId abc123 用户刷脸失败，帮忙看下" });

    expect(result.status).toBe("diagnosed");
    expect(result.toolResults[0].ok).toBe(false);
    expect(result.toolResults[0].summary).toContain("MCP 监控服务不可用");
    expect(result.answer).toContain("MCP 监控服务不可用");
  });

  it("handles malformed MCP output as a failed tool result", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockResolvedValue(
      successResult("not-json-at-all"),
    );

    const { service } = createService();
    const result = await service.run({ query: "traceId abc123 用户刷脸失败，帮忙看下" });

    expect(result.toolResults[0].ok).toBe(false);
    expect(result.toolResults[0].summary).toContain("格式异常");
  });
});
