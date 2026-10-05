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
    // V3.0: 使用 searchHybrid 获得 RRF 融合 + Reranker 精排结果
    const rawResults = await service.search(query, null, 10);

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
        score: Math.round(r.score * 100) / 100,
        source: r.docTitle || "知识库",
        docId: r.docId,
        chunkIndex: r.chunkIndex,
      });
    }
    deduped.sort((a, b) => b.score - a.score);
    const reranked = deduped.slice(0, 5);

    const topScore = reranked[0]?.score ?? 0;
    if (topScore < 0.5) {
      return successResult(JSON.stringify({
        query,
        found: false,
        top_score: topScore,
        message: "知识库中未找到高相关度内容。请基于通用知识回答，并告知用户此信息可能需要人工核实。",
      }));
    }

    const qualityLabel = topScore >= 0.8 ? "high" : topScore >= 0.65 ? "medium" : "low";

    return successResult(JSON.stringify({
      query,
      found: true,
      quality: qualityLabel,
      top_score: topScore,
      results: reranked.map((r) => ({
        content: r.content,
        score: r.score,
        source: r.source,
        docId: r.docId,
        chunkIndex: r.chunkIndex,
      })),
      note: qualityLabel === "low"
        ? "相关度较低，建议在回复中标注'仅供参考'并建议用户联系人工核实。"
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
