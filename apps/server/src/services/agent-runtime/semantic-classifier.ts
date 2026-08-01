// SemanticClassifier —— L2 语义意图分类器
//
// 此文件为向后兼容的 re-export barrel。
// 实际实现已移至 routing/l2-semantic.ts。

export {
  SemanticClassifier,
  getSemanticClassifier,
  SemanticMatchSchema,
  SemanticResultSchema,
} from "./routing/l2-semantic.js";

export type {
  SemanticMatch,
  SemanticResult,
} from "./routing/l2-semantic.js";
