// QueryRouter —— 路由管线编排器
//
// 编排 5 层路由管线，按优先级依次尝试：
//   L1: 关键词快速路由（SAFETY/HUMAN/DIAGNOSIS）→ 零延迟
//   L2: 语义意图分类（Embedding + pgvector k-NN）→ <50ms
//   L3: Few-Shot 增强 LLM Router（L2 中置信度时）→ ~500ms
//   L4: 原始 LLM Router（兜底）→ ~500ms
//   L5: IntentDetector fallback（regex 最终兜底）
//
// 从 router.ts 提取管线编排逻辑，各层实现独立为 routing/l1~l5 模块。

import type { ChatMessage } from "../../../providers/types.js";
import { logger } from "@agentforge/logger";
import type { RouteName, RouterDecision } from "../types.js";
import type { ObservabilityTrace } from "../../../observability/provider.js";

import { quickRouteScan } from "./l1-keyword.js";
import {
  SemanticClassifier,
  getSemanticClassifier,
  type SemanticMatch,
} from "./l2-semantic.js";
import { fewShotClassify, llmClassify } from "./l3-llm-router.js";
import { fallbackClassify } from "./l5-fallback.js";

// ═══════════════════════════════════════════════════════
// QueryRouter
// ═══════════════════════════════════════════════════════

export class QueryRouter {
  private modelId: string | null;
  private semanticRouter: SemanticClassifier;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
    this.semanticRouter = getSemanticClassifier();
  }

  /**
   * 对用户消息进行分类，返回路由决策。
   *
   * V12 多层流程：
   *   1. L1 关键词快速路由（SAFETY/HUMAN/DIAGNOSIS）→ 零延迟
   *   2. L2 语义意图分类（Embedding + pgvector k-NN）→ <50ms
   *   3. L3 Few-Shot 增强 LLM Router（L2 中置信度时）→ ~500ms
   *   4. L4 原始 LLM Router（兜底）→ ~500ms
   *   5. Fallback: regex IntentDetector → TASK
   */
  async classify(
    message: string,
    history: ChatMessage[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision> {
    // ── L1: 关键词快速路由 ──
    const quickResult = quickRouteScan(message);
    if (quickResult) {
      return quickResult;
    }

    return this.classifyFromL2(message, history, trace);
  }

  async classifyFromL2(
    message: string,
    history: ChatMessage[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision> {
    // ── L2: 语义意图分类（Embedding + pgvector k-NN）──
    const l2Start = Date.now();
    const semanticResult = await this.semanticRouter.classify(message);
    const l2Ms = Date.now() - l2Start;

    if (semanticResult) {
      // L2 高置信度（≥ 0.8）→ 直接返回
      if (semanticResult.confidence >= 0.8) {
        logger.info(
          { route: semanticResult.route, confidence: semanticResult.confidence, l2Ms },
          "Router: L2 semantic classification (high confidence), returning directly",
        );
        return {
          route: semanticResult.route,
          confidence: semanticResult.confidence,
          reasoning: semanticResult.reasoning,
        };
      }

      // L2 中置信度（0.5 ~ 0.8）→ L3 Few-Shot 增强
      if (semanticResult.confidence >= 0.5 && semanticResult.matches.length > 0) {
        logger.info(
          {
            route: semanticResult.route,
            confidence: semanticResult.confidence,
            matchCount: semanticResult.matches.length,
            l2Ms,
          },
          "Router: L2 medium confidence, escalating to L3 Few-Shot LLM",
        );

        const l3Result = await fewShotClassify(
          message,
          history,
          semanticResult.matches,
          this.modelId,
          trace,
        );
        if (l3Result) return l3Result;
      }
    } else {
      logger.info({ l2Ms }, "Router: L2 skipped (no embedding provider or no matches)");
    }

    // ── L4: 原始 LLM Router ──
    const l4Result = await llmClassify(message, history, this.modelId, trace);
    if (l4Result) return l4Result;

    // ── L5: regex IntentDetector fallback ──
    return fallbackClassify(message);
  }
}
