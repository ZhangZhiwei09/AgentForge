import { describe, expect, it, vi } from "vitest";
import type { HybridSearchResult } from "../../knowledge.js";
import { DiagnosisService } from "../graph.js";
import {
  buildToolPlan,
  classifyIntentFromQuery,
  extractEntitiesFromQuery,
  getMissingFields,
} from "../nodes.js";
import type { DiagnosisToolCall } from "../schemas.js";
import { MockDiagnosisMonitoringTools } from "../tools/monitoring-tools.js";

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

function createService(toolExecute = vi.fn()) {
  const knowledgeRetriever = {
    searchHybrid: vi.fn(async () => fakeDocs),
  };

  const monitoringTools = {
    execute: toolExecute.mockImplementation((call: DiagnosisToolCall) =>
      new MockDiagnosisMonitoringTools().execute(call),
    ),
  };

  return {
    service: new DiagnosisService({ knowledgeRetriever, monitoringTools }),
    knowledgeRetriever,
    monitoringTools,
  };
}

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
    expect(buildToolPlan("merchant_rate_drop", { merchantId: "10086", timeRange: { raw: "今天" } })[0].name).toBe(
      "query_merchant_metrics",
    );
  });
});

describe("DiagnosisService graph regression", () => {
  it("explains an error code with RAG evidence and without monitoring", async () => {
    const toolExecute = vi.fn();
    const { service, knowledgeRetriever, monitoringTools } = createService(toolExecute);

    const result = await service.run({ query: "FACE_TIMEOUT 是什么原因，怎么处理？" });

    expect(result.intent).toBe("error_code_explanation");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.errorCode).toBe("FACE_TIMEOUT");
    expect(result.toolResults).toHaveLength(0);
    expect(monitoringTools.execute).not.toHaveBeenCalled();
    expect(knowledgeRetriever.searchHybrid).toHaveBeenCalledOnce();
    expect(result.answer).toContain("引用文档");
    expect(result.answer).toContain("活体错误码排查手册");
  });

  it("diagnoses a single trace with trace monitoring data", async () => {
    const toolExecute = vi.fn();
    const { service, monitoringTools } = createService(toolExecute);

    const result = await service.run({ query: "traceId abc123 用户刷脸失败，帮忙看下" });

    expect(result.intent).toBe("single_trace_diagnosis");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.traceId).toBe("abc123");
    expect(monitoringTools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "query_trace_log" }),
    );
    expect(result.toolResults[0].data.errorCode).toBe("FACE_TIMEOUT");
    expect(result.answer).toContain("H5 活体采集阶段超时");
  });

  it("diagnoses merchant rate drops with merchant metrics", async () => {
    const toolExecute = vi.fn();
    const { service, monitoringTools } = createService(toolExecute);

    const result = await service.run({ query: "商户 10086 今天上午活体通过率下降，帮忙排查" });

    expect(result.intent).toBe("merchant_rate_drop");
    expect(result.status).toBe("diagnosed");
    expect(result.entities.merchantId).toBe("10086");
    expect(result.entities.timeRange?.raw).toBe("今天上午");
    expect(monitoringTools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "query_merchant_metrics" }),
    );
    expect(result.toolResults[0].data.successRate).toBe(0.714);
    expect(result.answer).toContain("成功率显著低于近 7 日基线");
  });

  it("asks for clarification and does not retrieve or call tools when input is incomplete", async () => {
    const toolExecute = vi.fn();
    const { service, knowledgeRetriever, monitoringTools } = createService(toolExecute);

    const result = await service.run({ query: "核身失败了，帮忙看下" });

    expect(result.status).toBe("needs_clarification");
    expect(result.missingFields.length).toBeGreaterThan(0);
    expect(result.answer).toContain("当前信息不足");
    expect(knowledgeRetriever.searchHybrid).not.toHaveBeenCalled();
    expect(monitoringTools.execute).not.toHaveBeenCalled();
  });
});
