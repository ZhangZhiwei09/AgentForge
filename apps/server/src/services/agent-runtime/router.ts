// QueryRouter —— LLM 驱动的 Agent 查询分类器
//
// 此文件为向后兼容的 re-export barrel。
// 实际实现已拆分到 routing/ 目录下的独立模块：
//   routing/l1-keyword.ts    — L1 关键词快速路由
//   routing/l2-semantic.ts   — L2 语义意图分类
//   routing/l3-llm-router.ts — L3/L4 LLM 路由
//   routing/l5-fallback.ts   — L5 正则兜底
//   routing/pipeline.ts      — 管线编排器（QueryRouter）
//
// V12 多层路由架构：
//   L1: 关键词快速路由（SAFETY、HUMAN、DIAGNOSIS 走关键词规则，零延迟）
//   L2: 语义意图分类（Embedding + pgvector k-NN，<50ms）
//   L3: Few-Shot 增强 LLM Router（L2 中置信度时，注入相似样本作参考）
//   L4: 原始 LLM Router（兜底）
//   L5: IntentDetector fallback（regex 最终兜底）

export {
  QueryRouter,
  SAFETY_KEYWORDS,
  HUMAN_KEYWORDS,
  DIAGNOSIS_KEYWORDS,
  quickRouteScan,
  ROUTER_SYSTEM_PROMPT,
  ROUTE_LABELS,
  RouterDecisionSchema,
  buildFewShotPrompt,
  parseRouterDecision,
  fewShotClassify,
  llmClassify,
  INTENT_TO_ROUTE,
  fallbackClassify,
  SemanticClassifier,
  getSemanticClassifier,
  SemanticMatchSchema,
  SemanticResultSchema,
} from "./routing/index.js";

export type {
  QuickRouteResult,
  SemanticMatch,
  SemanticResult,
} from "./routing/index.js";
