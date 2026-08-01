import type { HybridSearchResult } from "../knowledge.js";
import type {
  DiagnosisEntities,
  DiagnosisEvidence,
  DiagnosisIntent,
  DiagnosisKnowledgeEvidence,
  DiagnosisToolCall,
} from "./schemas.js";
import type { DiagnosisState } from "./state.js";
import type { DiagnosisMonitoringTools } from "./tools/monitoring-tools.js";

export interface DiagnosisKnowledgeRetriever {
  searchHybrid(params: {
    query: string;
    kbIds?: string[];
    topK?: number;
    useReranker?: boolean;
  }): Promise<HybridSearchResult[]>;
}

export interface DiagnosisNodeDeps {
  knowledgeRetriever: DiagnosisKnowledgeRetriever;
  monitoringTools: DiagnosisMonitoringTools;
}

const ERROR_CODE_PATTERN = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/;
const TRACE_PATTERN = /\b(?:traceId|trace_id|trace|链路|流水)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})\b/i;
const ORDER_PATTERN = /\b(?:orderId|order_id|订单)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})\b/i;
const MERCHANT_PATTERN = /(?:商户|merchant|merchantId|merchant_id)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})/i;
const APP_PATTERN = /\b(?:appId|app_id|应用)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})\b/i;

export function classifyIntentFromQuery(query: string): DiagnosisIntent {
  const normalized = query.trim();

  if (TRACE_PATTERN.test(normalized) || ORDER_PATTERN.test(normalized)) {
    return "single_trace_diagnosis";
  }

  if (
    MERCHANT_PATTERN.test(normalized) &&
    /(通过率|成功率|下降|降低|异常|失败很多|失败率|波动)/.test(normalized)
  ) {
    return "merchant_rate_drop";
  }

  if (ERROR_CODE_PATTERN.test(normalized)) {
    return "error_code_explanation";
  }

  if (/(接入|配置|摄像头|权限|sdk|SDK|H5|小程序|初始化)/.test(normalized)) {
    return "integration_guidance";
  }

  return "unknown";
}

export function extractEntitiesFromQuery(query: string): DiagnosisEntities {
  const entities: DiagnosisEntities = {};
  const errorCode = query.match(ERROR_CODE_PATTERN)?.[0];
  const traceId = query.match(TRACE_PATTERN)?.[1];
  const orderId = query.match(ORDER_PATTERN)?.[1];
  const merchantId = query.match(MERCHANT_PATTERN)?.[1];
  const appId = query.match(APP_PATTERN)?.[1];

  if (errorCode) entities.errorCode = errorCode;
  if (traceId) entities.traceId = traceId;
  if (orderId) entities.orderId = orderId;
  if (merchantId) entities.merchantId = merchantId;
  if (appId) entities.appId = appId;

  if (/活体|liveness/i.test(query)) entities.product = "liveness";
  else if (/人脸|刷脸|face/i.test(query)) entities.product = "face_verify";
  else if (/OCR|ocr|身份证|证件/.test(query)) entities.product = "ocr";
  else if (/实名|realname/i.test(query)) entities.product = "realname";

  if (/H5|h5/.test(query)) entities.clientType = "h5";
  else if (/小程序/.test(query)) entities.clientType = "mini_program";
  else if (/App|APP|app/.test(query)) entities.clientType = "app";
  else if (/Web|WEB|web/.test(query)) entities.clientType = "web";

  if (/测试环境|test/i.test(query)) entities.environment = "test";
  else if (/生产|线上|prod/i.test(query)) entities.environment = "prod";

  const timeRange = extractTimeRange(query);
  if (timeRange) entities.timeRange = timeRange;

  return entities;
}

function extractTimeRange(query: string): DiagnosisEntities["timeRange"] {
  const now = new Date();
  const yyyyMmDd = now.toISOString().slice(0, 10);

  if (/今天上午/.test(query)) {
    return {
      raw: "今天上午",
      start: `${yyyyMmDd}T09:00:00+08:00`,
      end: `${yyyyMmDd}T12:00:00+08:00`,
    };
  }

  if (/今天下午/.test(query)) {
    return {
      raw: "今天下午",
      start: `${yyyyMmDd}T13:00:00+08:00`,
      end: `${yyyyMmDd}T18:00:00+08:00`,
    };
  }

  if (/今天|今日/.test(query)) {
    return {
      raw: "今天",
      start: `${yyyyMmDd}T00:00:00+08:00`,
      end: `${yyyyMmDd}T23:59:59+08:00`,
    };
  }

  const hourRange = query.match(/(\d{1,2})[:：点时](?:\d{1,2}分?)?\s*(?:到|-|~|至)\s*(\d{1,2})[:：点时]/);
  if (hourRange) {
    const startHour = hourRange[1].padStart(2, "0");
    const endHour = hourRange[2].padStart(2, "0");
    return {
      raw: hourRange[0],
      start: `${yyyyMmDd}T${startHour}:00:00+08:00`,
      end: `${yyyyMmDd}T${endHour}:00:00+08:00`,
    };
  }

  return undefined;
}

export function getMissingFields(intent: DiagnosisIntent, entities: DiagnosisEntities): string[] {
  switch (intent) {
    case "error_code_explanation":
      return entities.errorCode ? [] : ["errorCode"];
    case "single_trace_diagnosis":
      return entities.traceId || entities.orderId ? [] : ["traceId 或 orderId"];
    case "merchant_rate_drop":
      return [
        entities.merchantId ? null : "merchantId",
        entities.timeRange ? null : "timeRange",
      ].filter((item): item is string => Boolean(item));
    case "integration_guidance":
      return entities.product || entities.clientType ? [] : ["product 或 clientType"];
    default:
      return ["merchantId / traceId / orderId / errorCode", "timeRange"];
  }
}

export function buildToolPlan(intent: DiagnosisIntent, entities: DiagnosisEntities): DiagnosisToolCall[] {
  if (intent === "single_trace_diagnosis") {
    return [
      {
        name: "query_trace_log",
        reason: "单笔失败诊断需要查询链路日志确认失败阶段和错误码。",
        args: {
          traceId: entities.traceId,
          orderId: entities.orderId,
        },
      },
    ];
  }

  if (intent === "merchant_rate_drop") {
    return [
      {
        name: "query_merchant_metrics",
        reason: "商户通过率下降需要查询成功率、基线、错误分布和耗时指标。",
        args: {
          merchantId: entities.merchantId,
          product: entities.product,
          timeRange: entities.timeRange,
        },
      },
    ];
  }

  return [];
}

export function classifyIntentNode(state: DiagnosisState): Partial<DiagnosisState> {
  return { intent: classifyIntentFromQuery(state.query) };
}

export function extractEntitiesNode(state: DiagnosisState): Partial<DiagnosisState> {
  return { entities: extractEntitiesFromQuery(state.query) };
}

export function checkRequiredFieldsNode(state: DiagnosisState): Partial<DiagnosisState> {
  const intent = state.intent ?? "unknown";
  const missingFields = getMissingFields(intent, state.entities);

  if (missingFields.length > 0) {
    return {
      missingFields,
      status: "needs_clarification",
    };
  }

  return {
    missingFields: [],
  };
}

export function askClarificationNode(state: DiagnosisState): Partial<DiagnosisState> {
  return {
    answer: [
      "当前信息不足，暂时无法完成核身排障。",
      "",
      `已识别问题类型：${state.intent ?? "unknown"}`,
      `还需要补充：${state.missingFields.join("、")}`,
      "",
      "请补充商户号、失败时间范围，以及 traceId / orderId / 错误码中的任意一项，我再继续定位。",
    ].join("\n"),
  };
}

export function createRetrieveKnowledgeNode(deps: DiagnosisNodeDeps) {
  return async function retrieveKnowledgeNode(state: DiagnosisState): Promise<Partial<DiagnosisState>> {
    const docs = await deps.knowledgeRetriever.searchHybrid({
      query: buildKnowledgeQuery(state),
      kbIds: state.kbIds,
      topK: 5,
      useReranker: true,
    });

    return {
      retrievedDocs: docs.map(mapKnowledgeEvidence),
    };
  };
}

export function decideToolsNode(state: DiagnosisState): Partial<DiagnosisState> {
  return {
    toolPlan: buildToolPlan(state.intent ?? "unknown", state.entities),
  };
}

export function createQueryMonitoringNode(deps: DiagnosisNodeDeps) {
  return async function queryMonitoringNode(state: DiagnosisState): Promise<Partial<DiagnosisState>> {
    const toolResults = [];
    for (const call of state.toolPlan) {
      toolResults.push(await deps.monitoringTools.execute(call));
    }
    return { toolResults };
  };
}

export function mergeEvidenceNode(state: DiagnosisState): Partial<DiagnosisState> {
  const evidence: DiagnosisEvidence[] = [];

  evidence.push({
    id: "query",
    source: "query",
    title: "用户问题",
    detail: state.query,
  });

  for (const doc of state.retrievedDocs) {
    evidence.push({
      id: doc.id,
      source: "knowledge",
      title: doc.title,
      detail: doc.content,
    });
  }

  for (const result of state.toolResults) {
    evidence.push({
      id: result.toolName,
      source: "monitoring",
      title: result.toolName,
      detail: result.summary,
    });
  }

  return { evidence };
}

export function generateDiagnosisNode(state: DiagnosisState): Partial<DiagnosisState> {
  return {
    status: "diagnosed",
    answer: renderDiagnosisAnswer(state),
  };
}

export function selfCheckNode(state: DiagnosisState): Partial<DiagnosisState> {
  const warnings = [...state.warnings];

  if ((state.status === "diagnosed") && state.evidence.length <= 1) {
    warnings.push("诊断证据不足，仅包含用户原始问题。");
  }

  if (state.toolPlan.length > 0 && state.toolResults.length === 0) {
    warnings.push("已规划监控工具但未获得工具结果。");
  }

  if (state.retrievedDocs.length === 0) {
    warnings.push("未命中知识库引用，回答仅基于结构化信息和监控结果。");
  }

  return { warnings };
}



function buildKnowledgeQuery(state: DiagnosisState): string {
  const parts = [
    state.query,
    state.entities.errorCode,
    state.entities.product,
    state.entities.clientType,
  ].filter(Boolean);

  return parts.join(" ");
}

function mapKnowledgeEvidence(result: HybridSearchResult): DiagnosisKnowledgeEvidence {
  return {
    id: result.chunkId,
    source: "knowledge",
    title: result.docTitle,
    content: result.content,
    score: result.score,
    docId: result.docId,
    chunkId: result.chunkId,
  };
}

function renderDiagnosisAnswer(state: DiagnosisState): string {
  const entities = renderEntities(state.entities);
  const knowledge = state.retrievedDocs
    .map((doc, index) => `${index + 1}. ${doc.title}：${doc.content.slice(0, 120)}`)
    .join("\n");
  const tools = state.toolResults.map((result, index) => `${index + 1}. ${result.summary}`).join("\n");
  const conclusion = buildConclusion(state);

  return [
    `问题类型：${state.intent ?? "unknown"}`,
    "",
    "已识别信息：",
    entities || "暂未识别到可执行字段",
    "",
    "初步结论：",
    conclusion,
    "",
    "关键证据：",
    [knowledge, tools].filter(Boolean).join("\n") || "暂无外部证据，仅基于用户描述判断。",
    "",
    "建议排查步骤：",
    renderNextSteps(state),
    "",
    "建议回复话术：",
    renderReplyTemplate(state),
    "",
    "引用文档：",
    state.retrievedDocs.length > 0
      ? state.retrievedDocs.map((doc, index) => `${index + 1}. ${doc.title}`).join("\n")
      : "未命中知识库文档",
  ].join("\n");
}

function renderEntities(entities: DiagnosisEntities): string {
  return Object.entries(entities)
    .map(([key, value]) => {
      if (!value) return null;
      if (typeof value === "object") return `- ${key}: ${JSON.stringify(value)}`;
      return `- ${key}: ${value}`;
    })
    .filter((item): item is string => Boolean(item))
    .join("\n");
}

function buildConclusion(state: DiagnosisState): string {
  const firstTool = state.toolResults[0];
  const data = firstTool?.data ?? {};

  if (state.intent === "merchant_rate_drop" && firstTool) {
    return String(data.conclusion ?? firstTool.summary);
  }

  if (state.intent === "single_trace_diagnosis" && firstTool) {
    return String(data.conclusion ?? firstTool.summary);
  }

  if (state.intent === "error_code_explanation") {
    return `错误码 ${state.entities.errorCode} 需要结合知识库中的错误码说明和接入场景处理。`;
  }

  if (state.intent === "integration_guidance") {
    return "该问题更偏接入指导，优先按知识库步骤检查客户端环境、权限和 SDK 配置。";
  }

  return "当前问题类型不明确，需要补充更多上下文。";
}

function renderNextSteps(state: DiagnosisState): string {
  if (state.intent === "merchant_rate_drop") {
    return [
      "1. 对比指定时间段成功率和近 7 日基线。",
      "2. 查看 top 错误码是否集中在超时、活体失败或网络异常。",
      "3. 按端类型和 SDK 版本拆分，确认是否为客户端版本或环境问题。",
      "4. 若服务端耗时升高，同步接口链路和告警状态。",
    ].join("\n");
  }

  if (state.intent === "single_trace_diagnosis") {
    return [
      "1. 根据 traceId / orderId 定位失败阶段。",
      "2. 对照错误码知识库确认原因和用户侧处理方式。",
      "3. 检查端类型、SDK 版本、摄像头权限和网络状态。",
      "4. 如单笔链路正常但用户重试仍失败，再扩大到商户维度监控。",
    ].join("\n");
  }

  if (state.intent === "error_code_explanation") {
    return [
      "1. 确认错误码对应产品和端类型。",
      "2. 按知识库说明检查接入配置、权限和用户环境。",
      "3. 若错误量集中上升，再补充商户号和时间范围查询监控。",
    ].join("\n");
  }

  return "1. 补充产品、端类型、时间范围和可定位 ID 后继续排查。";
}

function renderReplyTemplate(state: DiagnosisState): string {
  if (state.intent === "merchant_rate_drop") {
    return "已按商户维度查看指定时间段指标，当前建议优先关注错误分布最高的失败原因，并结合端类型 / SDK 版本继续拆分影响范围。";
  }

  if (state.intent === "single_trace_diagnosis") {
    return "已根据单笔链路定位失败阶段，请按上述原因检查用户环境和接入参数；如仍复现，请补充同商户更多失败样本。";
  }

  if (state.intent === "error_code_explanation") {
    return "该错误码可先按文档建议处理；如果现场仍有批量失败，请补充商户号和失败时间范围，我可以继续查询监控。";
  }

  return "当前信息还不足以定位，请补充可查询字段后继续。";
}

