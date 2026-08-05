import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunContext } from "../../../runtime/context.js";
import {
  executionResultToContent,
  successResult,
  failedResult,
  ExecutionErrorCode,
} from "../../../runtime/results.js";
import type { ExecutionResult } from "../../../runtime/results.js";
import { monitoringMcpClient } from "../../../mcp/monitoring-client.js";

// ── Mock MCP 客户端 ─────────────────────────────────────────
vi.mock("../../../mcp/monitoring-client.js", () => ({
  monitoringMcpClient: {
    queryTraceLog: vi.fn(),
  },
}));

const { diagnosisMonitoringTools } = await import("../diagnosis-tools.js");

function assertSuccess(
  r: ExecutionResult,
): asserts r is { status: "success"; output: string; metadata?: Record<string, unknown> } {
  if (r.status !== "success") throw new Error("Expected success, got " + r.status);
}

const testCtx = createRunContext(new AbortController().signal);

// 与 Python MCP server 返回一致的信封结构
const mockTraceEnvelope = {
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
    conclusion: "该笔请求在活体算法处理阶段超时，根因：算法节点负载过高。",
  },
};

const traceLogTool = diagnosisMonitoringTools.find(
  (t) => t.definition.function.name === "query_trace_log",
)!;

// ═══════════════════════════════════════════════════════════
// 元数据
// ═══════════════════════════════════════════════════════════
describe("diagnosisMonitoringTools metadata", () => {
  it("should contain exactly 1 tool (query_trace_log only)", () => {
    expect(diagnosisMonitoringTools).toHaveLength(1);
    expect(traceLogTool).toBeDefined();
  });

  it("should have read_only risk, 15s timeout, business category, parallelizable, no approval", () => {
    expect(traceLogTool.riskLevel).toBe("read_only");
    expect(traceLogTool.timeout).toBe(15_000);
    expect(traceLogTool.category).toBe("business");
    expect(traceLogTool.parallelizable).toBe(true);
    expect(traceLogTool.requireApproval).toBe(false);
  });

  it("should have a function definition with Chinese description and traceId param", () => {
    expect(traceLogTool.definition.type).toBe("function");
    expect(traceLogTool.definition.function.name).toBe("query_trace_log");
    expect(traceLogTool.definition.function.description.length).toBeGreaterThan(10);
    expect(traceLogTool.definition.function.parameters.type).toBe("object");
    expect(
      traceLogTool.definition.function.parameters.properties.traceId,
    ).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// query_trace_log（走 MCP 管线）
// ═══════════════════════════════════════════════════════════
describe("query_trace_log", () => {
  beforeEach(() => {
    vi.mocked(monitoringMcpClient.queryTraceLog).mockReset();
  });

  it("calls MCP client and returns success with envelope JSON output", async () => {
    vi.mocked(monitoringMcpClient.queryTraceLog).mockResolvedValue(
      successResult(JSON.stringify(mockTraceEnvelope)),
    );

    const result = await traceLogTool.execute({ traceId: "abc123" }, testCtx);

    expect(result.status).toBe("success");
    assertSuccess(result);
    expect(monitoringMcpClient.queryTraceLog).toHaveBeenCalledWith("abc123");

    const parsed = JSON.parse(result.output);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.data.errorCode).toBe("FACE_TIMEOUT");
    expect(parsed.data.spans).toHaveLength(1);
  });

  it("resolves orderId as fallback lookup key", async () => {
    vi.mocked(monitoringMcpClient.queryTraceLog).mockResolvedValue(
      successResult(JSON.stringify(mockTraceEnvelope)),
    );

    await traceLogTool.execute({ orderId: "abc123" }, testCtx);

    expect(monitoringMcpClient.queryTraceLog).toHaveBeenCalledWith("abc123");
  });

  it("returns failed when no traceId or orderId provided", async () => {
    const result = await traceLogTool.execute({}, testCtx);

    expect(result.status).toBe("failed");
    expect(executionResultToContent(result)).toContain("traceId");
    expect(monitoringMcpClient.queryTraceLog).not.toHaveBeenCalled();
  });

  it("returns failed when traceId is empty", async () => {
    const result = await traceLogTool.execute({ traceId: "" }, testCtx);

    expect(result.status).toBe("failed");
  });

  it("propagates failedResult from MCP client (degradation)", async () => {
    vi.mocked(monitoringMcpClient.queryTraceLog).mockResolvedValue(
      failedResult(ExecutionErrorCode.NETWORK_ERROR, "MCP 监控服务不可用", true),
    );

    const result = await traceLogTool.execute({ traceId: "abc123" }, testCtx);

    expect(result.status).toBe("failed");
    const content = executionResultToContent(result);
    expect(content).toContain("MCP 监控服务不可用");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NETWORK_ERROR);
    }
  });
});
