// 长期记忆存储 —— Mem0 API 封装 + MemoryEngine 降级
//
// 两层 namespace：
//   - user: 用户级记忆（跨会话持久化偏好、事实）
//   - session: 会话级记忆（特定会话的上下文）
//
// 降级策略：Mem0 不可用时回退到现有 MemoryEngine（PG + Milvus）
import { MemoryEngine, type MemoryCreate, type MemoryOut, type MemorySearchResult } from "./memory-engine.js";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

// ── 类型 ──────────────────────────────────────────────────

export interface LongTermMemoryContext {
  userMemories: MemorySearchResult[];
  sessionMemories: MemorySearchResult[];
}

// ── Mem0 HTTP Client（内部）───────────────────────────────

class Mem0Client {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = settings.mem0BaseUrl || "https://api.mem0.ai/v1";
    this.apiKey = settings.mem0ApiKey || "";
  }

  isConfigured(): boolean {
    return !!(this.baseUrl && this.apiKey);
  }

  async add(params: {
    userId: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/memories`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
          messages: [{ role: "user", content: params.content }],
          metadata: params.metadata,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch (e) {
      logger.warn(e, "Mem0 add failed");
      return false;
    }
  }

  async search(params: {
    userId: string;
    query: string;
    topK?: number;
  }): Promise<
    Array<{
      content: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>
  > {
    if (!this.isConfigured()) return [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/memories/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          user_id: params.userId,
          query: params.query,
          top_k: params.topK || 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) return [];

      const data = (await response.json()) as {
        results?: Array<{
          memory?: string;
          content?: string;
          score?: number;
          metadata?: Record<string, unknown>;
        }>;
      };
      return (data.results || []).map((r) => ({
        content: r.memory || r.content || "",
        score: r.score || 0,
        metadata: r.metadata,
      }));
    } catch (e) {
      logger.warn(e, "Mem0 search failed");
      return [];
    }
  }
}

// ── LongTermMemoryStore ───────────────────────────────────

export class LongTermMemoryStore {
  private engine: MemoryEngine;
  private mem0: Mem0Client;

  constructor() {
    this.engine = new MemoryEngine();
    this.mem0 = new Mem0Client();
  }

  // 判断 Mem0 是否可用
  isMem0Available(): boolean {
    return this.mem0.isConfigured();
  }

  // 存储长期记忆（用户级）
  async storeUserMemory(
    userId: string,
    memory: MemoryCreate,
  ): Promise<MemoryOut> {
    // 双写：Mem0 + PG（可降级）
    if (this.mem0.isConfigured()) {
      await this.mem0
        .add({
          userId,
          content: memory.content,
          metadata: {
            type: memory.type,
            importance: memory.importance,
            ...(memory.metadata || {}),
          },
        })
        .catch((e) =>
          logger.warn(e, "Mem0 storeUserMemory failed, using PG fallback"),
        );
    }

    // PG + Milvus 始终写入（主存储 + Mem0 降级路径）
    return this.engine.store(memory, userId);
  }

  // 搜索长期记忆
  async search(
    query: string,
    userId: string,
    topK: number = 5,
  ): Promise<MemorySearchResult[]> {
    // 优先使用 Mem0
    if (this.mem0.isConfigured()) {
      try {
        const mem0Results = await this.mem0.search({
          userId,
          query,
          topK,
        });

        if (mem0Results.length > 0) {
          return mem0Results.map((r) => ({
            id: `mem0-${Date.now()}`,
            userId,
            type: "semantic" as const,
            content: r.content,
            importance: 0.5,
            metadata: (r.metadata as Record<string, unknown>) || null,
            conversationId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            score: r.score,
          }));
        }
      } catch (e) {
        logger.warn(e, "Mem0 search failed, falling back to MemoryEngine");
      }
    }

    // Mem0 不可用 → 降级到 MemoryEngine
    return this.engine.search(query, userId, topK);
  }

  // 从对话中提取并存储长期记忆
  async extractAndStore(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    conversationId: string,
    sessionId?: string,
  ): Promise<MemoryOut[]> {
    return this.engine.extractAndStore(
      messages,
      userId,
      conversationId,
      "", // auto-detect provider
      sessionId,
    );
  }

  // 获取用户完整上下文（用户级 + 会话级记忆）
  async getUserContext(
    userId: string,
    conversationId: string,
    query: string,
  ): Promise<LongTermMemoryContext> {
    // 并行搜索两层记忆
    const [userMemories, sessionMemories] = await Promise.all([
      this.search(query, userId, 5),
      this.searchUserSessionMemories(userId, conversationId, 5),
    ]);

    return { userMemories, sessionMemories };
  }

  // 按会话搜索记忆（从 metadata.conversationId 匹配）
  private async searchUserSessionMemories(
    userId: string,
    conversationId: string,
    topK: number,
  ): Promise<MemorySearchResult[]> {
    // 从 PG 按 conversationId 过滤
    const { prisma } = await import("../db.js");
    try {
      const memories = await prisma.memory.findMany({
        where: { userId, conversationId },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        take: topK,
      });

      return memories.map((m) => ({
        id: m.id,
        userId: m.userId,
        type: m.type,
        content: m.content,
        importance: m.importance,
        metadata: m.metadata as Record<string, unknown> | null,
        conversationId: m.conversationId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        score: m.importance,
      }));
    } catch (e) {
      logger.warn(e, "Session memory search failed");
      return [];
    }
  }

  // 列出用户所有记忆
  async list(userId: string, type?: string): Promise<MemoryOut[]> {
    return this.engine.list(userId, type);
  }

  // 删除单条记忆
  async delete(memoryId: string): Promise<boolean> {
    return this.engine.delete(memoryId);
  }
}
