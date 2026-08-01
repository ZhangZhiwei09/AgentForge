// L5 正则 Fallback —— IntentDetector 最终兜底
//
// 当 L1-L4 全部无法确定路由时，使用 regex IntentDetector 兜底分类。
// 从 router.ts 提取，保持原有逻辑不变。

import { intentDetector } from "../../intent-detector.js";
import type { RouteName, RouterDecision } from "../types.js";

// ── IntentDetector → RouteName 映射（fallback 用） ──

export const INTENT_TO_ROUTE: Record<string, RouteName> = {
  退货退款: "TASK",
  物流查询: "TASK",
  售后联系: "HUMAN",
  账户会员: "TASK",
  支付订单: "TASK",
  其他咨询: "TASK", // 默认走 TASK
};

/**
 * 正则 IntentDetector fallback。
 * 所有业务意图默认映射到 TASK，仅"售后联系"映射到 HUMAN。
 */
export function fallbackClassify(message: string): RouterDecision {
  const { intent, confidence } = intentDetector.detect(message);
  const route: RouteName = INTENT_TO_ROUTE[intent] ?? "TASK";

  return {
    route,
    confidence,
    reasoning: `IntentDetector fallback: ${intent} (confidence: ${confidence.toFixed(2)})`,
  };
}
