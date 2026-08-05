import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HybridSearchResult } from "../../knowledge.js";
import { DiagnosisService } from "../graph.js";
import {
  buildToolPlan,
  classifyIntentFromQuery,
  extractEntitiesFromQuery,
  getMissingFields,
} from "../nodes.js";
import { monitoringMcpClient } from "../../../mcp/monitoring-client.js";
import { successResult } from "../../../runtime/results.js";

const fakeDocs: HybridSearchResult[] = [
  {
    chunkId: "chunk-face-timeout",
    docId: "doc-error-code",
    kbId: "kb-identity",
    content: "FACE_TIMEOUT 通常表示活体采集或人脸核验链路超时，需要检查网络、摄像头权限、SDK 版本和接口耗时。",
    score: 0.93,
    fusionScore: 0.03,
    recallSources: ["elasticsearch"],
    chunkIndex: 0,
    docTitle: "活体错误码排查手册",
  },
];

// 与真实 MCP server（apps/server-py/src/mcp/monitoring/repository.py）abc123
// 返回结构一致的信封，用于确定性断言图路径结论渲染。
const traceEnvelope = {
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
    conclusion: "H5 活体采集阶段超时，优先排查网络、摄像头权限和 SDK 版本。",
  },
};

// 默认注入 McpDiagnosisMonitoringTools（graph.ts 默认值），MCP 客户端打桩。
function createService() {
  const knowledgeRetriever = {
    searchHybrid: vi.fn(async () => fakeDocs),
  };
  const service = new DiagnosisService({ knowledgeRetriever });
  return { service, knowledgeRetriever };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("diagnosis nodes", () => {
  it("classifies the three MVP intents", () => {
    expect(classifyIntentFromQuery("FACE_TIMEOUT 是什么原因")).toBe("error_code_explanation");
    expect(classifyIntentFromQuery("traceId abc123 用户刷脸失败")).toBe("single_trace_diagnosis");
    expect(classifyIntentFromQuery("商户 10086 今天上午活体通过率下降")).toBe("merchant_rate_drop");
  });

  it("extracts executable identity diagnosis entities", () => {
    const entities = extractEntitiesFromQuery("商户 10086 今天上午 H5 活体通过率下降，错误码 FACE_TIMEOUT");

    expect(entities.merchantId).toBe("10086");
    expect(entities.errorCode).toBe("FACE_TIMEOUT");
    expect(entities.product).toBe("liveness");
    expect(entities.clientType).toBe("h5");
    expect(entities.timeRange?.raw).toBe("今天上午");
  });

  it("blocks diagnosis when required fields are missing", () => {
    expect(getMissingFields("merchant_rate_drop", { merchantId: "10086" })).toEqual(["timeRange"]);
    expect(getMissingFields("single_trace_diagnosis", {})).toEqual(["traceId 或 orderId"]);
    expect(getMissingFields("error_code_explanation", { errorCode: "FACE_TIMEOUT" })).toEqual([]);
  });

  it("routes monitoring tools only for diagnosis intents", () => {
    expect(buildToolPlan("error_code_explanation", { errorCode: "FACE_TIMEOUT" })).toEqual([]);
    expect(buildToolPlan("single_trace_diagnosis", { traceId: "abc123" })[0].name).toBe("query_trace_log");
    // merchant_rate_drop 的商户指标工具已随 MCP 能力收缩退役，不再规划监控工具
    expect(buildToolPlan("merchant_rate_drop", { merchantId: "10086", timeRange: { raw: "今天" } })).toEqual([]);
  });
});

describe("DiagnosisService graph regression", () => {
  it("explains an error code with RAG evidence and without monitoring", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockImplementation(() => {
      throw new Error("error_code_explanation 不应调用监控工具");
    });
    const { service, knowledgeRetriever } = createService();

    const result = await service.run({ query: "FACE_TIMEOUT 是什么原因，怎么处理？" });

    expect(result.intent).toBe("error_code_explanation");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.errorCode).toBe("FACE_TIMEOUT");
    expect(result.toolResults).toHaveLength(0);
    expect(monitoringMcpClient.queryTraceLog).not.toHaveBeenCalled();
    expect(knowledgeRetriever.searchHybrid).toHaveBeenCalledOnce();
    expect(result.answer).toContain("引用文档");
    expect(result.answer).toContain("活体错误码排查手册");
  });

  it("diagnoses a single trace with trace monitoring data", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockResolvedValue(
      successResult(JSON.stringify(traceEnvelope)),
    );

    const { service } = createService();

    const result = await service.run({ query: "traceId abc123 用户刷脸失败，帮忙看下" });

    expect(result.intent).toBe("single_trace_diagnosis");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.traceId).toBe("abc123");
    expect(monitoringMcpClient.queryTraceLog).toHaveBeenCalledWith("abc123");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].data.errorCode).toBe("FACE_TIMEOUT");
    expect(result.answer).toContain("H5 活体采集阶段超时");
  });

  it("handles merchant rate drop without merchant metrics tool", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockImplementation(() => {
      throw new Error("merchant_rate_drop 不应调用监控工具");
    });
    const { service } = createService();

    const result = await service.run({ query: "商户 10086 今天上午活体通过率下降，帮忙排查" });

    expect(result.intent).toBe("merchant_rate_drop");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.merchantId).toBe("10086");
    expect(result.entities.timeRange?.raw).toBe("今天上午");
    // 商户指标工具已退役：不规划监控工具、不调用 MCP，引导用户提供 traceId
    expect(monitoringMcpClient.queryTraceLog).not.toHaveBeenCalled();
    expect(result.toolResults).toHaveLength(0);
    expect(result.answer).toContain("商户维度指标查询能力当前不可用");
  });

  it("asks for clarification and does not retrieve or call tools when input is incomplete", async () => {
    vi.spyOn(monitoringMcpClient, "queryTraceLog").mockImplementation(() => {
      throw new Error("信息不足时不应调用监控工具");
    });
    const { service, knowledgeRetriever } = createService();

    const result = await service.run({ query: "核身失败了，帮忙看下" });

    expect(result.status).toBe("needs_clarification");
    expect(result.missingFields.length).toBeGreaterThan(0);
    expect(result.answer).toContain("当前信息不足");
    expect(knowledgeRetriever.searchHybrid).not.toHaveBeenCalled();
    expect(monitoringMcpClient.queryTraceLog).not.toHaveBeenCalled();
  });
});
