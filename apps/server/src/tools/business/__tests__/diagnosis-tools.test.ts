import { describe, it, expect, vi } from "vitest";
import { createRunContext } from "../../../runtime/context.js";
import { executionResultToContent } from "../../../runtime/results.js";
import type { ExecutionResult } from "../../../runtime/results.js";

function assertSuccess(r: ExecutionResult): asserts r is { status: "success"; output: string; metadata?: Record<string, unknown> } {
  if (r.status !== "success") throw new Error("Expected success, got " + r.status);
}

// ── Mock 模块数据 ──────────────────────────────────────────
vi.mock(
  "../../../services/diagnosis/tools/mock-monitoring-data.js",
  () => ({
    mockTraceLogs: {
      abc123: {
        traceId: "abc123",
        product: "liveness",
        clientType: "h5",
        errorCode: "FACE_TIMEOUT",
        stage: "face_capture",
        latencyMs: 4200,
        sdkVersion: "3.1.8",
        conclusion:
          "H5 活体采集阶段超时，优先排查网络、摄像头权限和 SDK 版本。",
      },
      trace_camera_denied: {
        traceId: "trace_camera_denied",
        product: "face_verify",
        clientType: "h5",
        errorCode: "CAMERA_PERMISSION_DENIED",
        stage: "camera_permission",
        latencyMs: 300,
        sdkVersion: "3.3.0",
        conclusion: "浏览器未授予摄像头权限，需引导用户开启权限后重试。",
      },
    },
    defaultTraceLog: {
      product: "face_verify",
      clientType: "unknown",
      errorCode: "UNKNOWN_VERIFY_FAIL",
      stage: "unknown",
      latencyMs: 0,
      sdkVersion: "unknown",
      conclusion: "未命中 mock 单笔日志，仅能给出通用核身失败排查建议。",
    },
    mockMerchantMetrics: {
      "10086": {
        merchantId: "10086",
        product: "liveness",
        successRate: 0.714,
        baselineSuccessRate: 0.912,
        requestCount: 1860,
        affectedCount: 532,
        p95LatencyMs: 3800,
        topErrors: [
          { code: "FACE_TIMEOUT", rate: 0.42, count: 224 },
          { code: "LIVENESS_FAIL", rate: 0.28, count: 149 },
          { code: "NETWORK_TIMEOUT", rate: 0.16, count: 85 },
        ],
        conclusion: "成功率显著低于近 7 日基线，失败集中在超时和活体检测失败。",
      },
    },
    defaultMerchantMetrics: {
      product: "unknown",
      successRate: 0.96,
      baselineSuccessRate: 0.965,
      requestCount: 120,
      affectedCount: 5,
      p95LatencyMs: 850,
      topErrors: [{ code: "VERIFY_FAIL", rate: 0.04, count: 5 }],
      conclusion: "未命中 mock 异常商户，当前指标接近基线。",
    },
  }),
);

// 动态导入，在 mock 就绪后加载
const { diagnosisMonitoringTools } = await import("../diagnosis-tools.js");

const testCtx = createRunContext(new AbortController().signal);

// ──────────────────────────────────────────────────────────
// 解构三种工具
// ──────────────────────────────────────────────────────────
const traceLogTool = diagnosisMonitoringTools.find(
  (t) => t.definition.function.name === "query_trace_log",
)!;
const merchantMetricsTool = diagnosisMonitoringTools.find(
  (t) => t.definition.function.name === "query_merchant_metrics",
)!;
const errorCodeDistTool = diagnosisMonitoringTools.find(
  (t) => t.definition.function.name === "query_error_code_distribution",
)!;

// ═══════════════════════════════════════════════════════════
// 通用 Metadata 验证
// ═══════════════════════════════════════════════════════════
describe("diagnosisMonitoringTools metadata", () => {
  it("should contain exactly 3 tools", () => {
    expect(diagnosisMonitoringTools).toHaveLength(3);
  });

  it("should have unique tool names", () => {
    const names = diagnosisMonitoringTools.map(
      (t) => t.definition.function.name,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  for (const tool of diagnosisMonitoringTools) {
    const toolName = tool.definition.function.name;
    describe(`${toolName} metadata`, () => {
      it("should have riskLevel = read_only", () => {
        expect(tool.riskLevel).toBe("read_only");
      });

      it("should have timeout = 10000", () => {
        expect(tool.timeout).toBe(10_000);
      });

      it("should have category = business", () => {
        expect(tool.category).toBe("business");
      });

      it("should be parallelizable", () => {
        expect(tool.parallelizable).toBe(true);
      });

      it("should have requireApproval = false", () => {
        expect(tool.requireApproval).toBe(false);
      });

      it("should have a function definition with name, description, parameters", () => {
        expect(tool.definition.type).toBe("function");
        expect(tool.definition.function.name).toBe(toolName);
        expect(typeof tool.definition.function.description).toBe("string");
        expect(tool.definition.function.description.length).toBeGreaterThan(10);
        expect(tool.definition.function.parameters).toBeDefined();
        expect(tool.definition.function.parameters.type).toBe("object");
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════
// query_trace_log
// ═══════════════════════════════════════════════════════════
describe("query_trace_log", () => {
  it("should return trace details for known traceId abc123", async () => {
    const result = await traceLogTool.execute(
      { traceId: "abc123" },
      testCtx,
    );

    expect(result.status).toBe("success");
    assertSuccess(result);
    expect(result.output).toBeDefined();

    const parsed = JSON.parse(result.output);
    expect(parsed.traceId).toBe("abc123");
    expect(parsed.product).toBe("liveness");
    expect(parsed.clientType).toBe("h5");
    expect(parsed.errorCode).toBe("FACE_TIMEOUT");
    expect(parsed.stage).toBe("face_capture");
    expect(parsed.latencyMs).toBe(4200);
    expect(parsed.sdkVersion).toBe("3.1.8");
    expect(parsed.conclusion).toContain("网络");
    expect(parsed._note).toBeUndefined();
  });

  it("should return trace details for known trace_camera_denied", async () => {
    const result = await traceLogTool.execute(
      { traceId: "trace_camera_denied" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.traceId).toBe("trace_camera_denied");
    expect(parsed.product).toBe("face_verify");
    expect(parsed.errorCode).toBe("CAMERA_PERMISSION_DENIED");
    expect(parsed.stage).toBe("camera_permission");
    expect(parsed.conclusion).toContain("摄像头权限");
    expect(parsed._note).toBeUndefined();
  });

  it("should return default log for unknown traceId with _note", async () => {
    const result = await traceLogTool.execute(
      { traceId: "non_existent_id" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.traceId).toBe("non_existent_id");
    expect(parsed.product).toBe("face_verify"); // 来自 defaultTraceLog
    expect(parsed.clientType).toBe("unknown");
    expect(parsed.errorCode).toBe("UNKNOWN_VERIFY_FAIL");
    expect(parsed.conclusion).toContain("通用核身失败");
    expect(parsed._note).toBeDefined();
    expect(parsed._note).toContain('traceId="non_existent_id"');
    expect(parsed._note).toContain("未命中 mock 数据");
  });

  it("should resolve trace by orderId (fallback key)", async () => {
    const result = await traceLogTool.execute(
      { orderId: "abc123" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.traceId).toBe("abc123");
    expect(parsed.errorCode).toBe("FACE_TIMEOUT");
    expect(parsed._note).toBeUndefined();
  });

  it("should throw default log for unknown orderId with _note", async () => {
    const result = await traceLogTool.execute(
      { orderId: "order_999" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.traceId).toBe("order_999");
    expect(parsed._note).toContain('traceId="order_999"');
  });

  it("should return error when no traceId or orderId provided", async () => {
    const result = await traceLogTool.execute({}, testCtx);

    expect(result.status).toBe("failed");
    const content = executionResultToContent(result);
    expect(content).toContain("traceId");
    expect(content).toContain("orderId");
  });

  it("should return error when traceId is empty string", async () => {
    const result = await traceLogTool.execute(
      { traceId: "" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    const content = executionResultToContent(result);
    expect(content).toContain("traceId");
  });

  it("should return error when both traceId and orderId are empty strings", async () => {
    const result = await traceLogTool.execute(
      { traceId: "", orderId: "" },
      testCtx,
    );

    expect(result.status).toBe("failed");
  });

  it("should return successResult with JSON stringified output", async () => {
    const result = await traceLogTool.execute(
      { traceId: "abc123" },
      testCtx,
    );

    expect(result.status).toBe("success");
    assertSuccess(result);
    // 验证 output 是可解析的 JSON 字符串
    const output = result.output;
    expect(() => JSON.parse(output)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// query_merchant_metrics
// ═══════════════════════════════════════════════════════════
describe("query_merchant_metrics", () => {
  it("should return metrics for known merchantId 10086", async () => {
    const result = await merchantMetricsTool.execute(
      { merchantId: "10086" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.merchantId).toBe("10086");
    expect(parsed.product).toBe("liveness");
    expect(parsed.successRate).toBe(0.714);
    expect(parsed.baselineSuccessRate).toBe(0.912);
    expect(parsed.requestCount).toBe(1860);
    expect(parsed.affectedCount).toBe(532);
    expect(parsed.p95LatencyMs).toBe(3800);
    expect(parsed.topErrors).toHaveLength(3);
    expect(parsed.topErrors[0]).toEqual({
      code: "FACE_TIMEOUT",
      rate: 0.42,
      count: 224,
    });
    expect(parsed.conclusion).toContain("成功率显著低于");
    expect(parsed._note).toBeUndefined();
  });

  it("should return default metrics for unknown merchantId with _note", async () => {
    const result = await merchantMetricsTool.execute(
      { merchantId: "unknown_merchant" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.merchantId).toBe("unknown_merchant");
    expect(parsed.product).toBe("unknown"); // 来自 defaultMerchantMetrics
    expect(parsed.successRate).toBe(0.96);
    expect(parsed.baselineSuccessRate).toBe(0.965);
    expect(parsed.requestCount).toBe(120);
    expect(parsed.affectedCount).toBe(5);
    expect(parsed.p95LatencyMs).toBe(850);
    expect(parsed.topErrors).toHaveLength(1);
    expect(parsed.conclusion).toContain("接近基线");
    expect(parsed._note).toBeDefined();
    expect(parsed._note).toContain('merchantId="unknown_merchant"');
    expect(parsed._note).toContain("未命中 mock 数据");
  });

  it("should return error when no merchantId provided", async () => {
    const result = await merchantMetricsTool.execute({}, testCtx);

    expect(result.status).toBe("failed");
    const content = executionResultToContent(result);
    expect(content).toContain("merchantId");
  });

  it("should return error when merchantId is empty string", async () => {
    const result = await merchantMetricsTool.execute(
      { merchantId: "" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    const content = executionResultToContent(result);
    expect(content).toContain("merchantId");
  });

  it("should accept optional product and timeRange arguments", async () => {
    const result = await merchantMetricsTool.execute(
      { merchantId: "10086", product: "liveness", timeRange: "今天上午" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.merchantId).toBe("10086");
    expect(parsed.successRate).toBe(0.714);
  });

  it("should return successResult with JSON stringified output", async () => {
    const result = await merchantMetricsTool.execute(
      { merchantId: "10086" },
      testCtx,
    );

    expect(result.status).toBe("success");
    assertSuccess(result);
    const output = result.output;
    expect(() => JSON.parse(output)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// query_error_code_distribution
// ═══════════════════════════════════════════════════════════
describe("query_error_code_distribution", () => {
  it("should return 6 error codes with total 532", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.totalErrors).toBe(532);
    expect(parsed.distribution).toHaveLength(6);

    // 验证所有错误码存在
    const codes = parsed.distribution.map((d: { code: string }) => d.code);
    expect(codes).toContain("FACE_TIMEOUT");
    expect(codes).toContain("LIVENESS_FAIL");
    expect(codes).toContain("NETWORK_TIMEOUT");
    expect(codes).toContain("CAMERA_PERMISSION_DENIED");
    expect(codes).toContain("SDK_INIT_FAIL");
    expect(codes).toContain("OTHER");

    // 总和应等于 totalErrors
    const totalCount = parsed.distribution.reduce(
      (sum: number, d: { count: number }) => sum + d.count,
      0,
    );
    expect(totalCount).toBe(532);
  });

  it("should show FACE_TIMEOUT at 42% rate", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    const parsed = JSON.parse(executionResultToContent(result));
    const faceTimeoutEntry = parsed.distribution.find(
      (d: { code: string }) => d.code === "FACE_TIMEOUT",
    );

    expect(faceTimeoutEntry).toBeDefined();
    expect(faceTimeoutEntry.rate).toBe(0.42);
    expect(faceTimeoutEntry.count).toBe(224);
    expect(faceTimeoutEntry.change).toBe("+12%");
    expect(faceTimeoutEntry.description).toContain("超时");
  });

  it("should return global summary when no filters provided", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.filters).toEqual({ product: "全部", clientType: "全部" });
    expect(parsed.summary).toContain("全局错误码分布");
    expect(parsed.summary).toContain("FACE_TIMEOUT");
    expect(parsed.summary).toContain("42%");
    expect(parsed.summary).toContain("+12%");
  });

  it("should return filtered summary when product is specified", async () => {
    const result = await errorCodeDistTool.execute(
      { product: "liveness" },
      testCtx,
    );

    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.filters).toEqual({
      product: "liveness",
      clientType: "全部",
    });
    expect(parsed.summary).toContain("product=liveness");
    expect(parsed.summary).toContain("过滤后的错误码分布");
  });

  it("should return filtered summary when clientType is specified", async () => {
    const result = await errorCodeDistTool.execute(
      { clientType: "H5" },
      testCtx,
    );

    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.filters).toEqual({
      product: "全部",
      clientType: "H5",
    });
    expect(parsed.summary).toContain("clientType=H5");
    expect(parsed.summary).toContain("过滤后的错误码分布");
  });

  it("should return filtered summary when both product and clientType specified", async () => {
    const result = await errorCodeDistTool.execute(
      { product: "face_verify", clientType: "App" },
      testCtx,
    );

    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.filters).toEqual({
      product: "face_verify",
      clientType: "App",
    });
    expect(parsed.summary).toContain("product=face_verify");
    expect(parsed.summary).toContain("clientType=App");
  });

  it("should accept optional timeRange argument", async () => {
    const result = await errorCodeDistTool.execute(
      { timeRange: "最近7天" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.totalErrors).toBe(532);
  });

  it("should return successResult with JSON stringified output", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    assertSuccess(result);
    const output = result.output;
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("should have each error entry with code, count, rate, change, description", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    const parsed = JSON.parse(executionResultToContent(result));
    for (const entry of parsed.distribution) {
      expect(entry).toHaveProperty("code");
      expect(typeof entry.code).toBe("string");
      expect(entry).toHaveProperty("count");
      expect(typeof entry.count).toBe("number");
      expect(entry.count).toBeGreaterThan(0);
      expect(entry).toHaveProperty("rate");
      expect(typeof entry.rate).toBe("number");
      expect(entry.rate).toBeGreaterThan(0);
      expect(entry.rate).toBeLessThan(1);
      expect(entry).toHaveProperty("change");
      expect(typeof entry.change).toBe("string");
      expect(entry).toHaveProperty("description");
      expect(typeof entry.description).toBe("string");
    }
  });

  it("should have distribution rates sum to approximately 1.0", async () => {
    const result = await errorCodeDistTool.execute({}, testCtx);

    const parsed = JSON.parse(executionResultToContent(result));
    const totalRate = parsed.distribution.reduce(
      (sum: number, d: { rate: number }) => sum + d.rate,
      0,
    );
    // 0.42 + 0.28 + 0.16 + 0.08 + 0.03 + 0.03 = 1.00
    expect(totalRate).toBeCloseTo(1.0, 2);
  });
});
