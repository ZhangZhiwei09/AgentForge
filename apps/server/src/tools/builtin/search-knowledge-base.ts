// Builtin Tool: search_knowledge_base
// Runtime 核心工具 —— 任何知识 Agent 的基础能力
// 用于检索知识库中的文档内容

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "../types.js";
import type { RunContext } from "../../runtime/context.js";
import { successResult, failedResult, ExecutionErrorCode } from "../../runtime/results.js";
import { KnowledgeService } from "../../services/knowledge.js";
import { logger } from "@agentforge/logger";

const def: ToolDefinition = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "搜索知识库，获取业务相关信息。" +
      "当用户询问需要参考文档才能回答的问题时使用此工具。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询语句，使用用户问题的核心关键词",
        },
      },
      required: ["query"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<import("../../runtime/results.js").ExecutionResult> {
  const query = (args.query as string) || "";
  if (!query.trim()) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "请提供搜索查询");
  }

  try {
    const service = new KnowledgeService();
    // 使用 RRF 融合，并在配置可用时启用 Reranker 精排。
    const rawResults = await service.searchWithRerank(query, null, 10);

    if (!rawResults || rawResults.length === 0) {
      return successResult(JSON.stringify({
        query,
        found: false,
        message: "未找到相关知识库内容。请基于通用知识回答用户，并建议联系人工客服获取准确信息。",
      }));
    }

    const seen = new Set<string>();
    // docId / chunkIndex 必须保留：下游引用卡片要靠真实 docId 定位原文
    const deduped: Array<{
      content: string;
      score: number;
      scoreType?: "reranker" | "rrf";
      sourceScore?: number;
      fusionScore?: number;
      rerankScore?: number;
      source: string;
      docId: string;
      chunkIndex: number;
    }> = [];
    for (const r of rawResults) {
      const key = r.content.slice(0, 100).trim();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        content: r.content,
        score: Math.round(r.score * 10000) / 10000,
        scoreType: r.scoreType,
        sourceScore: r.sourceScore,
        fusionScore: r.fusionScore,
        rerankScore: r.rerankScore,
        source: r.docTitle || "知识库",
        docId: r.docId,
        chunkIndex: r.chunkIndex,
      });
    }
    deduped.sort((a, b) => b.score - a.score);
    const reranked = deduped.slice(0, 5);

    const topScore = reranked[0]?.score ?? 0;
    const topRelevanceScore = reranked[0]?.rerankScore ?? null;
    const qualityLabel = topRelevanceScore == null
      ? "ranked"
      : topRelevanceScore >= 0.8
        ? "high"
        : topRelevanceScore >= 0.65
          ? "medium"
          : "low";

    return successResult(JSON.stringify({
      query,
      found: true,
      quality: qualityLabel,
      top_score: topScore,
      score_type: reranked[0]?.scoreType,
      top_relevance_score: topRelevanceScore,
      results: reranked.map((r) => ({
        content: r.content,
        score: r.score,
        scoreType: r.scoreType,
        sourceScore: r.sourceScore,
        fusionScore: r.fusionScore,
        rerankScore: r.rerankScore,
        source: r.source,
        docId: r.docId,
        chunkIndex: r.chunkIndex,
      })),
      note: qualityLabel === "low"
        ? "Rerank 相关度较低，建议在回复中标注'仅供参考'并建议用户联系人工核实。"
        : qualityLabel === "ranked"
          ? "当前结果仅有综合排序分，无法直接代表语义相似度，建议人工核实。"
          : undefined,
    }));
  } catch (e) {
    logger.error(e, "search_knowledge_base failed");
    return failedResult(ExecutionErrorCode.EXECUTION_ERROR, "知识库搜索暂时不可用，请基于通用知识回答用户。");
  }
}

export const searchKnowledgeBaseTool: RegisteredTool = {
  definition: def,
  execute,
  riskLevel: "read_only",
  timeout: 10_000,
  requireApproval: false,
  category: "builtin",
  parallelizable: false,
};
