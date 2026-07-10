// KnowledgeContextBuilder —— 结构化知识库上下文构建器
//
// 将 search_knowledge_base 工具返回的原始 JSON 结果
// 封装为结构化的 KnowledgeContext，供 AgentExecutor 推理 + CitationVerifier 校验
//
// 职责：
//   1. 解析工具输出 → 提取文档和引用
//   2. 去重 + 质量分级 + 排序
//   3. 计算检索置信度
//   4. 识别覆盖缺口
//   5. 生成结构化上下文摘要

import { logger } from "@agentforge/logger";
import type { KnowledgeContext, Citation, KBDocumentItem } from "./types.js";

// ── 原始 KB 搜索结果格式 ──

interface RawKBResult {
  content: string;
  score: number;
  source: string;
}

interface RawKBToolOutput {
  query: string;
  found: boolean;
  quality?: "high" | "medium" | "low";
  top_score?: number;
  results?: RawKBResult[];
  message?: string;
}

// ── 配置 ──

const MIN_CONFIDENCE_SCORE = 0.5;
const HIGH_CONFIDENCE_SCORE = 0.8;
const MAX_DOCS = 10;

// ═══════════════════════════════════════════════════════
// KnowledgeContextBuilder
// ═══════════════════════════════════════════════════════

export class KnowledgeContextBuilder {
  /**
   * 从 search_knowledge_base 工具的输出构建结构化 KnowledgeContext。
   */
  build(toolOutput: string, userQuery: string): KnowledgeContext | null {
    try {
      const parsed = JSON.parse(toolOutput.trim());
      if (!parsed.found || !Array.isArray(parsed.results)) {
        return null;
      }

      const rawResults: RawKBResult[] = parsed.results;
      const topScore: number = parsed.top_score ?? 0;

      // ── 去重 + 排序 ──
      const seen = new Set<string>();
      const deduped: RawKBResult[] = [];
      for (const r of rawResults) {
        const key = r.content.slice(0, 100).trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(r);
      }
      deduped.sort((a, b) => b.score - a.score);
      const topDocs = deduped.slice(0, MAX_DOCS);

      // ── 构建 Citations ──
      const citations: Citation[] = topDocs.map((doc, i) => ({
        docId: `kb-${i}`,
        docTitle: doc.source || "知识库",
        chunkIndex: i,
        content: doc.content,
        score: doc.score,
      }));

      // ── 计算置信度 ──
      const avgScore =
        topDocs.length > 0
          ? topDocs.reduce((sum, d) => sum + d.score, 0) / topDocs.length
          : 0;
      let confidence: number;
      if (topScore >= HIGH_CONFIDENCE_SCORE) {
        confidence = 0.9;
      } else if (topScore >= 0.65) {
        confidence = 0.7;
      } else if (topScore >= MIN_CONFIDENCE_SCORE) {
        confidence = 0.5;
      } else {
        confidence = 0.3;
      }

      // ── 识别覆盖缺口 ──
      const gaps = this.identifyGaps(userQuery, topDocs);

      // ── 生成摘要 ──
      const summary = this.buildSummary(topDocs, topScore, confidence, gaps);

      const docs: KBDocumentItem[] = topDocs.map((d) => ({
        id: d.source,
        title: d.source,
        content: d.content,
      }));

      return {
        docs,
        citations,
        confidence: Math.round(confidence * 100) / 100,
        gaps,
        summary,
      };
    } catch (e) {
      logger.warn(e, "KnowledgeContextBuilder: failed to parse tool output");
      return null;
    }
  }

  /**
   * 识别用户问题中未被检索结果覆盖的方面。
   */
  private identifyGaps(
    query: string,
    docs: RawKBResult[],
  ): string[] {
    const gaps: string[] = [];

    // 检查查询中的关键实体是否在结果中出现
    const queryTerms = query.match(/[一-鿿\w]{2,}/g) || [];
    const combinedContent = docs.map((d) => d.content).join(" ");

    for (const term of queryTerms) {
      if (!combinedContent.includes(term)) {
        gaps.push(`未覆盖关键词: ${term}`);
      }
    }

    // 低分警告
    const lowScoreDocs = docs.filter((d) => d.score < MIN_CONFIDENCE_SCORE);
    if (lowScoreDocs.length > 0 && docs.length <= 2) {
      gaps.push("检索结果整体相关度偏低");
    }

    return gaps.slice(0, 5);
  }

  /**
   * 生成给 Agent 的结构化上下文摘要。
   */
  private buildSummary(
    docs: RawKBResult[],
    topScore: number,
    confidence: number,
    gaps: string[],
  ): string {
    const lines: string[] = [];

    lines.push(
      `检索置信度: ${(confidence * 100).toFixed(0)}% | 最佳匹配分数: ${topScore.toFixed(2)} | 结果数: ${docs.length}`,
    );

    if (docs.length > 0) {
      lines.push("\n相关内容摘要:");
      for (const doc of docs.slice(0, 5)) {
        const preview =
          doc.content.length > 150
            ? doc.content.slice(0, 150) + "..."
            : doc.content;
        lines.push(
          `- [${doc.source}] (相关度: ${(doc.score * 100).toFixed(0)}%) ${preview}`,
        );
      }
    }

    if (gaps.length > 0) {
      lines.push(`\n覆盖缺口: ${gaps.join("; ")}`);
    }

    if (confidence < 0.5) {
      lines.push(
        "\n⚠ 检索置信度较低，建议在回复中标注信息可能不完整，并建议用户核实。",
      );
    }

    return lines.join("\n");
  }
}

// ── Memory 注入（V3.0: 使用 MemoryService Facade） ──

import { getMemoryService } from "../memory-service.js";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

/**
 * 注入用户短期记忆上下文。
 * 从 MemoryService 获取短期摘要 + 最近窗口，格式化注入 Agent Prompt。
 * 长期记忆已移除，longTermContent 始终为空。
 */
export async function injectMemories(
  userMessage: string,
  sessionId: string | null,
  conversationId?: string,
): Promise<[string, string[]]> {
  if (!sessionId) return ["", []];
  try {
    const memoryService = getMemoryService();
    const contextText = await memoryService.buildContextText({
      userId: CUSTOMER_USER_ID,
      conversationId: conversationId || sessionId,
      query: userMessage,
    });

    return [contextText, []];
  } catch (e) {
    logger.warn(e, "Memory injection skipped");
  }
  return ["", []];
}
