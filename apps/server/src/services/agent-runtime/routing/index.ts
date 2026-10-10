// routing/ —— 路由管线模块
//
// 对外 export：
//   - QueryRouter（管线编排器）
//   - 各层实现（供直接使用或测试）
//   - 关键词常量（供外部引用）

export { QueryRouter } from "./pipeline.js";

// L1 关键词路由
export {
  SAFETY_KEYWORDS,
  HUMAN_KEYWORDS,
  DIAGNOSIS_KEYWORDS,
  quickRouteScan,
  safetyRouteScan,
} from "./l1-keyword.js";
export type { QuickRouteResult } from "./l1-keyword.js";

// L2 语义分类
export {
  SemanticClassifier,
  getSemanticClassifier,
  SemanticMatchSchema,
  SemanticResultSchema,
} from "./l2-semantic.js";
export type { SemanticMatch, SemanticResult } from "./l2-semantic.js";

// L3/L4 LLM 路由
export {
  ROUTER_SYSTEM_PROMPT,
  ROUTE_LABELS,
  RouterDecisionSchema,
  buildFewShotPrompt,
  parseRouterDecision,
  fewShotClassify,
  llmClassify,
} from "./l3-llm-router.js";

// L5 Fallback
export {
  INTENT_TO_ROUTE,
  fallbackClassify,
} from "./l5-fallback.js";
