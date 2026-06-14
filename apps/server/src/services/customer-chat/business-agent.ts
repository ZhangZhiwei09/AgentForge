// 客服业务工具函数
//
// 从 customer-chat.ts 中提取的纯函数，不依赖实例状态：
//   - fetchKnowledge(): KB 检索 → Milvus 混合搜索
//   - injectMemories(): 记忆搜索 → 注入 system prompt
//
// 历史说明：原 BusinessAgent 类（RAG 管线 + 5 层校验 + LLM 重试/降级）
// 已被 ToolAgent（基于 AgentService ReAct 循环 + 客服工具集）取代。
// 迁移日期：2026-06-13，清理日期：2026-06-14。

import { logger } from "@agentforge/logger";
import { MemoryEngine } from "../memory-engine.js";
import type { KnowledgeChunkResult } from "./types.js";

// ── 配置常量 ──

export const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

export const KB_SCORE_THRESHOLD = parseFloat(
  process.env.CS_KB_SCORE_THRESHOLD || "0.6",
);

export const MEMORY_PROMPT_PREFIX =
  "\n\n# 客户信息（来自历史对话记忆）\n以下是你了解的该客户的信息：\n";

// ═══════════════════════════════════════════════════════
// KB 搜索
// ═══════════════════════════════════════════════════════

export async function fetchKnowledge(userMessage: string): Promise<{
  context: string;
  results: KnowledgeChunkResult[];
}> {
  try {
    const { KnowledgeService } = await import("../knowledge.js");
    const service = new KnowledgeService();
    const results = await service.search(userMessage, undefined, 3);

    if (!results.length) return { context: "", results: [] };

    const lines = ["【知识库参考资料 —— 以下每条数据均来自知识库，不可修改】"];
    const scoredResults: KnowledgeChunkResult[] = [];
    const seenContent = new Set<string>();

    results.forEach((r, i) => {
      const trimmed = r.content.slice(0, 300);
      // 去重：跳过内容完全相同的 chunk
      if (seenContent.has(trimmed)) return;
      seenContent.add(trimmed);

      const sourceTag = `[来源: ${r.docTitle || r.docId} | 不可修改 | 编号: KB-${i + 1}]`;
      lines.push(`${sourceTag}\n${r.content}`);
      scoredResults.push({
        content: trimmed,
        score: r.score,
        docTitle: r.docTitle || r.docId,
      });
    });
    return {
      context: "\n\n" + lines.join("\n\n---\n\n"),
      results: scoredResults,
    };
  } catch (e) {
    logger.warn(e, "fetchKnowledge: knowledge search failed");
    return { context: "", results: [] };
  }
}

// ═══════════════════════════════════════════════════════
// 记忆注入
// ═══════════════════════════════════════════════════════

export async function injectMemories(
  userMessage: string,
  sessionId: string | null,
): Promise<[string, string[]]> {
  if (!sessionId) return ["", []];
  try {
    const engine = new MemoryEngine();
    const memories = await engine.search(
      userMessage,
      CUSTOMER_USER_ID,
      5,
      sessionId,
    );
    const relevant = memories.filter((m) => m.score > 0.3);
    if (relevant.length > 0) {
      const memoryText = relevant.map((m) => `- ${m.content}`).join("\n");
      return [
        MEMORY_PROMPT_PREFIX + memoryText,
        relevant.map((m) => m.content),
      ];
    }
  } catch (e) {
    logger.warn(e, "injectMemories: memory injection failed");
  }
  return ["", []];
}
