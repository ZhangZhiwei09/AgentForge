// Business Tools: Diagnosis Monitoring (Mock)
//
// Three mock tools for the DiagnosisMode agents to call during
// identity verification troubleshooting:
//   - query_trace_log: single trace/order diagnosis
//   - query_merchant_metrics: merchant-level success rate & error distribution
//   - query_error_code_distribution: global error code trends
//
// These return deterministic mock data so the multi-agent diagnosis flow
// can be tested end-to-end without connecting to real monitoring platforms.

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "../types.js";
import type { RunContext } from "../../runtime/context.js";
import {
  successResult,
  failedResult,
  ExecutionErrorCode,
} from "../../runtime/results.js";
import {
  mockTraceLogs,
  defaultTraceLog,
  mockMerchantMetrics,
  defaultMerchantMetrics,
} from "../../services/diagnosis/tools/mock-monitoring-data.js";

// ═══════════════════════════════════════════════════════════
// 1. query_trace_log — query single trace/order diagnostic info
// ═══════════════════════════════════════════════════════════

const queryTraceLogDef: ToolDefinition = {
  type: "function",
  function: {
    name: "query_trace_log",
    description:
      "查询单笔核身请求的完整链路日志。传入 traceId 或 orderId，返回该笔请求经过的业务阶段、错误码、耗时、SDK版本和诊断结论。用于定位单用户刷脸失败的具体原因。",
    parameters: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "链路追踪 ID，格式如 abc123。与 orderId 二选一。",
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
): Promise<import("../../runtime/results.js").ExecutionResult> {
  const lookupKey = String(args.traceId || args.orderId || "");

  if (!lookupKey.trim()) {
    return failedResult(
      ExecutionErrorCode.INVALID_PARAM,
      "请提供 traceId 或 orderId 以查询链路日志。",
    );
  }

  const data =
    mockTraceLogs[lookupKey as keyof typeof mockTraceLogs] ??
    ({ ...defaultTraceLog, traceId: lookupKey } as unknown as Record<
      string,
      unknown
    >);

  return successResult(
    JSON.stringify({
      traceId: lookupKey,
      product: data.product,
      clientType: data.clientType,
      errorCode: data.errorCode,
      stage: data.stage,
      latencyMs: data.latencyMs,
      sdkVersion: data.sdkVersion,
      conclusion: data.conclusion,
      _note:
        lookupKey in mockTraceLogs
          ? undefined
          : `未命中 mock 数据（traceId="${lookupKey}"），返回默认通用结果。`,
    }),
  );
}

// ═══════════════════════════════════════════════════════════
// 2. query_merchant_metrics — query merchant-level metrics
// ═══════════════════════════════════════════════════════════

const queryMerchantMetricsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "query_merchant_metrics",
    description:
      "查询指定商户的核身通过率、基线、请求量、P95 延迟和 Top 错误码分布。传入 merchantId 和可选 product、timeRange。用于排查商户维度通过率下降或异常波动。",
    parameters: {
      type: "object",
      properties: {
        merchantId: {
          type: "string",
          description: "商户 ID，如 '10086'。",
        },
        product: {
          type: "string",
          description: "产品类型：liveness / face_verify / ocr / realname。可选。",
        },
        timeRange: {
          type: "string",
          description: "时间范围描述，如 '今天上午'、'最近1小时'。可选。",
        },
      },
      required: ["merchantId"],
    },
  },
};

async function queryMerchantMetricsExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<import("../../runtime/results.js").ExecutionResult> {
  const merchantId = String(args.merchantId || "");

  if (!merchantId.trim()) {
    return failedResult(
      ExecutionErrorCode.INVALID_PARAM,
      "请提供 merchantId 以查询商户指标。",
    );
  }

  const data =
    mockMerchantMetrics[merchantId as keyof typeof mockMerchantMetrics] ??
    ({ ...defaultMerchantMetrics, merchantId } as unknown as Record<
      string,
      unknown
    >);

  return successResult(
    JSON.stringify({
      merchantId,
      product: data.product,
      successRate: data.successRate,
      baselineSuccessRate: data.baselineSuccessRate,
      requestCount: data.requestCount,
      affectedCount: data.affectedCount,
      p95LatencyMs: data.p95LatencyMs,
      topErrors: data.topErrors,
      conclusion: data.conclusion,
      _note:
        merchantId in mockMerchantMetrics
          ? undefined
          : `未命中 mock 数据（merchantId="${merchantId}"），返回默认基线结果。`,
    }),
  );
}

// ═══════════════════════════════════════════════════════════
// 3. query_error_code_distribution — global error distribution
// ═══════════════════════════════════════════════════════════

const queryErrorCodeDistributionDef: ToolDefinition = {
  type: "function",
  function: {
    name: "query_error_code_distribution",
    description:
      "查询全局或指定维度的错误码分布和趋势。支持按 product、clientType、timeRange 过滤。返回各错误码的出现次数、占比和环比变化。用于判断某个错误码是否为共性问题。",
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "产品类型过滤：liveness / face_verify / ocr / realname。可选。",
        },
        clientType: {
          type: "string",
          description: "客户端类型过滤：H5 / 小程序 / App / Web。可选。",
        },
        timeRange: {
          type: "string",
          description: "时间范围描述，如 '今天上午'、'最近7天'。可选。",
        },
      },
      required: [],
    },
  },
};

async function queryErrorCodeDistributionExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<import("../../runtime/results.js").ExecutionResult> {
  const product = (args.product as string) || "全部";
  const clientType = (args.clientType as string) || "全部";

  // Deterministic mock distribution
  const distribution = [
    {
      code: "FACE_TIMEOUT",
      count: 224,
      rate: 0.42,
      change: "+12%",
      description:
        "活体检测/人脸比对超时，通常由算法处理耗时过长或网络传输延迟引起。",
    },
    {
      code: "LIVENESS_FAIL",
      count: 149,
      rate: 0.28,
      change: "+5%",
      description:
        "活体检测未通过，可能是光线不足、面部遮挡、或翻拍攻击。",
    },
    {
      code: "NETWORK_TIMEOUT",
      count: 85,
      rate: 0.16,
      change: "-3%",
      description:
        "网络连接超时，客户端到服务端的网络链路不稳定。",
    },
    {
      code: "CAMERA_PERMISSION_DENIED",
      count: 42,
      rate: 0.08,
      change: "+2%",
      description:
        "摄像头权限被拒绝，用户未授权或浏览器不支持。",
    },
    {
      code: "SDK_INIT_FAIL",
      count: 18,
      rate: 0.03,
      change: "-1%",
      description:
        "SDK 初始化失败，可能是 appId/secret 配置错误或版本不兼容。",
    },
    {
      code: "OTHER",
      count: 14,
      rate: 0.03,
      change: "-15%",
      description: "其他未分类错误，需进一步分析。",
    },
  ];

  return successResult(
    JSON.stringify({
      filters: { product, clientType },
      totalErrors: 532,
      distribution,
      summary:
        product !== "全部" || clientType !== "全部"
          ? `按 product=${product}, clientType=${clientType} 过滤后的错误码分布。FACE_TIMEOUT 是最主要的错误类型（42%）。`
          : "全局错误码分布。FACE_TIMEOUT 是最主要的错误类型（42%），且呈上升趋势（+12%）。",
    }),
  );
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

export const diagnosisMonitoringTools: RegisteredTool[] = [
  {
    definition: queryTraceLogDef,
    execute: queryTraceLogExecute,
    riskLevel: "read_only",
    timeout: 10_000,
    requireApproval: false,
    category: "business",
    parallelizable: true,
  },
  {
    definition: queryMerchantMetricsDef,
    execute: queryMerchantMetricsExecute,
    riskLevel: "read_only",
    timeout: 10_000,
    requireApproval: false,
    category: "business",
    parallelizable: true,
  },
  {
    definition: queryErrorCodeDistributionDef,
    execute: queryErrorCodeDistributionExecute,
    riskLevel: "read_only",
    timeout: 10_000,
    requireApproval: false,
    category: "business",
    parallelizable: true,
  },
];
