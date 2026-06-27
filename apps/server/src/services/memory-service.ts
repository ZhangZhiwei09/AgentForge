// 记忆服务 Facade —— 统一短期记忆 + 长期记忆接口
//
// 职责：
//   1. 构建完整上下文：系统指令 → 短期摘要 + 窗口消息 → 长期记忆 → 图谱链路 → RAG 证据
//   2. Agent 只依赖此统一接口，不直接使用 ShortTermMemoryStore 或 LongTermMemoryStore
//   3. 各子系统不可用时优雅降级
//
// 对旧接口 backward compatibility：
//   - extractAndStore 和 search 仍可用
//   - list / delete 仍委托给 MemoryEngine

import { ShortTermMemoryStore, type ShortTermMemoryMsg } from "./short-term-memory.js";
import { LongTermMemoryStore, type LongTermMemoryContext } from "./long-term-memory.js";
import type { MemoryCreate, MemoryOut, MemorySearchResult } from "./memory-engine.js";
import { logger } from "@agentforge/logger";

// ── 类型 ──────────────────────────────────────────────────

export interface MemoryContext {
  summary: string;                          // 短期窗口摘要
  recentMessages: ShortTermMemoryMsg[];     // 最近窗口消息
  longTermMemories: MemorySearchResult[];   // 长期记忆（用户级 + 会话级）
  memoryCount: number;                      // 总记忆条目数
}

export interface BuildContextParams {
  userId: string;
  conversationId: string;
  query: string;
}

// ── MemoryService ─────────────────────────────────────────

export class MemoryService {
  private shortTerm: ShortTermMemoryStore;
  private longTerm: LongTermMemoryStore;

  constructor() {
    this.shortTerm = new ShortTermMemoryStore();
    this.longTerm = new LongTermMemoryStore();
  }

  // ══ 核心接口：构建完整上下文 ═════════════════════════════

  /**
   * 构建 Agent Prompt 上下文所需的全部记忆信息。
   * 按顺序返回：短期摘要 + 最近窗口消息 + 长期记忆。
   */
  async buildContext(params: BuildContextParams): Promise<MemoryContext> {
    const { userId, conversationId, query } = params;

    // 并行获取短期上下文和长期记忆
    const [shortContext, longContext] = await Promise.all([
      this.shortTerm.getContext(conversationId).catch((e) => {
        logger.warn(e, "Short-term context failed");
        return { summary: "", recentMessages: [], messageCount: 0 };
      }),
      this.longTerm.getUserContext(userId, conversationId, query).catch((e) => {
        logger.warn(e, "Long-term context failed");
        return { userMemories: [], sessionMemories: [] } as LongTermMemoryContext;
      }),
    ]);

    // 合并用户级和会话级长期记忆，去重按分数排序
    const allLongTerm: MemorySearchResult[] = [
      ...longContext.userMemories,
      ...longContext.sessionMemories,
    ]
      .sort((a, b) => b.score - a.score)
      .filter((m, i, arr) => {
        // 简单内容去重
        const key = m.content.slice(0, 80);
        return arr.findIndex((x) => x.content.slice(0, 80) === key) === i;
      })
      .slice(0, 10);

    return {
      summary: shortContext.summary,
      recentMessages: shortContext.recentMessages,
      longTermMemories: allLongTerm,
      memoryCount: shortContext.messageCount + allLongTerm.length,
    };
  }

  /**
   * 构建格式化后的 Prompt 上下文字符串（可直接注入 Agent system prompt）。
   * 注入顺序：短期摘要 → 最近窗口 → 长期相关记忆
   */
  async buildContextText(params: BuildContextParams): Promise<string> {
    const context = await this.buildContext(params);
    const lines: string[] = [];

    if (context.summary) {
      lines.push("## 对话历史摘要\n" + context.summary);
    }

    if (context.recentMessages.length > 0) {
      lines.push("\n## 最近对话\n");
      for (const msg of context.recentMessages.slice(-5)) {
        const roleLabel = msg.role === "user" ? "用户" : "助手";
        lines.push(`**${roleLabel}**: ${msg.content.slice(0, 200)}`);
      }
    }

    if (context.longTermMemories.length > 0) {
      lines.push("\n## 用户相关信息\n");
      for (const mem of context.longTermMemories) {
        lines.push(`- ${mem.content} (相关度: ${(mem.score * 100).toFixed(0)}%)`);
      }
    }

    return lines.join("\n");
  }

  // ══ 写入接口 ════════════════════════════════════════════

  /** 记录一轮对话到短期记忆 */
  async recordExchange(
    conversationId: string,
    userMsg: string,
    assistantReply: string,
  ): Promise<void> {
    await this.shortTerm.addAssistantReply(
      conversationId,
      userMsg,
      assistantReply,
    );
  }

  /** 从对话中提取并存储长期记忆 */
  async extractAndStore(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    conversationId: string,
    sessionId?: string,
  ): Promise<MemoryOut[]> {
    return this.longTerm.extractAndStore(
      messages,
      userId,
      conversationId,
      sessionId,
    );
  }

  // ══ 向后兼容接口 ═════════════════════════════════════════

  /** 搜索记忆（向后兼容旧 MemoryEngine API） */
  async search(
    query: string,
    userId: string,
    topK: number = 5,
    sessionId?: string,
  ): Promise<MemorySearchResult[]> {
    return this.longTerm.search(query, userId, topK);
  }

  /** 存储记忆（向后兼容） */
  async store(memory: MemoryCreate, userId: string): Promise<MemoryOut> {
    return this.longTerm.storeUserMemory(userId, memory);
  }

  /** 列出用户记忆（向后兼容） */
  async list(userId: string, type?: string): Promise<MemoryOut[]> {
    return this.longTerm.list(userId, type);
  }

  /** 删除记忆（向后兼容） */
  async delete(memoryId: string): Promise<boolean> {
    return this.longTerm.delete(memoryId);
  }

  /** 清理会话数据 */
  async cleanupSession(conversationId: string): Promise<void> {
    await this.shortTerm.cleanup(conversationId);
  }
}

// 单例
let memoryServiceInstance: MemoryService | undefined;

export function getMemoryService(): MemoryService {
  if (!memoryServiceInstance) {
    memoryServiceInstance = new MemoryService();
  }
  return memoryServiceInstance;
}
