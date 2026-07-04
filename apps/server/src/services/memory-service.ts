// 记忆服务 Facade —— 短期记忆接口
//
// 职责：
//   1. 构建短期上下文：系统指令 → 短期摘要 + 窗口消息
//   2. Agent 只依赖此统一接口
//   3. 长期记忆已移除，相关方法均为 no-op
//
// 对旧接口 backward compatibility：
//   - extractAndStore / search / store / list / delete 均为 no-op

import { ShortTermMemoryStore, type ShortTermMemoryMsg } from "./short-term-memory.js";
import { logger } from "@agentforge/logger";

// ── 内联类型（替代已删除的 memory-engine 类型） ──────────────

interface MemoryResultItem {
  id: string;
  content: string;
  score: number;
}

// ── 类型 ──────────────────────────────────────────────────

export interface MemoryContext {
  summary: string;                          // 短期窗口摘要
  recentMessages: ShortTermMemoryMsg[];     // 最近窗口消息
  sessionMemories: MemoryResultItem[];      // 长期记忆已移除，始终为空
  userMemories: MemoryResultItem[];         // 长期记忆已移除，始终为空
  longTermMemories: MemoryResultItem[];     // 长期记忆已移除，始终为空
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

  constructor() {
    this.shortTerm = new ShortTermMemoryStore();
  }

  // ══ 核心接口：构建完整上下文 ═════════════════════════════

  /**
   * 构建 Agent Prompt 上下文所需的短期记忆信息。
   * 长期记忆已移除，sessionMemories / userMemories / longTermMemories 始终为空。
   */
  async buildContext(params: BuildContextParams): Promise<MemoryContext> {
    const { conversationId } = params;

    // 仅获取短期上下文
    const shortContext = await this.shortTerm.getContext(conversationId).catch((e) => {
      logger.warn(e, "Short-term context failed");
      return { summary: "", recentMessages: [], messageCount: 0 };
    });

    return {
      summary: shortContext.summary,
      recentMessages: shortContext.recentMessages,
      sessionMemories: [],
      userMemories: [],
      longTermMemories: [],
      memoryCount: shortContext.messageCount,
    };
  }

  /**
   * 构建格式化后的 Prompt 上下文字符串（仅包含短期记忆）。
   * 注入顺序：短期摘要 → 最近窗口消息。
   */
  async buildContextText(params: BuildContextParams): Promise<string> {
    const context = await this.buildContext(params);
    const lines: string[] = [];

    // 1. 短期摘要
    if (context.summary) {
      lines.push("## 对话历史摘要\n" + context.summary);
    }

    // 2. 最近窗口消息
    if (context.recentMessages.length > 0) {
      lines.push("\n## 最近对话\n");
      for (const msg of context.recentMessages.slice(-5)) {
        const roleLabel = msg.role === "user" ? "用户" : "助手";
        lines.push(`**${roleLabel}**: ${msg.content.slice(0, 200)}`);
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

  /** 清理会话数据 */
  async cleanupSession(conversationId: string): Promise<void> {
    await this.shortTerm.cleanup(conversationId);
  }

  // ══ 长期记忆接口（no-op，保留 API 兼容性） ═══════════════════

  /** 长期记忆提取已移除，始终返回空数组 */
  async extractAndStore(
    _messages: Array<{ role: string; content: string }>,
    _userId: string,
    _conversationId: string,
    _sessionId?: string,
  ): Promise<MemoryResultItem[]> {
    return [];
  }

  /** 长期记忆搜索已移除，始终返回空数组 */
  async search(
    _query: string,
    _userId: string,
    _topK: number = 5,
    _sessionId?: string,
  ): Promise<MemoryResultItem[]> {
    return [];
  }

  /** 长期记忆存储已移除，返回空结果 */
  async store(
    _memory: { type: string; content: string; importance?: number; metadata?: Record<string, unknown>; conversationId?: string | null },
    _userId: string,
  ): Promise<MemoryResultItem> {
    throw new Error("长期记忆存储已禁用");
  }

  /** 长期记忆列表已移除，始终返回空数组 */
  async list(_userId: string, _type?: string): Promise<MemoryResultItem[]> {
    return [];
  }

  /** 长期记忆删除已移除，始终返回 false */
  async delete(_memoryId: string): Promise<boolean> {
    return false;
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
