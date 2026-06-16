// 记忆引擎 —— AgentForge 的长期记忆系统
// 核心功能：
//   1. 存储记忆（双写 PG + Milvus）
//   2. 语义搜索（向量相似度 + PG fallback）
//   3. LLM 提取：从对话中自动抽取用户事实/偏好/事件
// 设计原则：Milvus 不可用时优雅降级为 PG only
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import {
  getMilvusClient,
  MILVUS_MEMORY_COLLECTION,
  EMBEDDING_DIM,
  ensureMemoryCollection,
} from "./milvus.js";
import type { Prisma } from "@agentforge/database";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { logger } from "@agentforge/logger";
import {
  milvusSearchDurationMs,
  memoryExtractionsTotal,
} from "../observability/metrics.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";

// 记忆创建参数
export interface MemoryCreate {
  type: string;
  content: string;
  importance?: number; // 0.0~1.0 重要度
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
}

// 记忆返回值（PG 查询结果）
export interface MemoryOut {
  id: string;
  userId: string;
  type: string;
  content: string;
  importance: number;
  metadata: Record<string, unknown> | null;
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// 搜索结果 = 记忆 + 相似度分数
export interface MemorySearchResult extends MemoryOut {
  score: number;
}

// 记忆提取的 System Prompt：让 LLM 从对话中识别有价值的信息
const SYSTEM_PROMPT_EXTRACT = `你是一个记忆提取助手。分析以下对话，提取出关于用户的新事实、偏好或重要信息。

返回一个 JSON 数组格式的记忆列表。每条记忆包含以下字段：
- "type": 记忆类型，可选值："semantic"（事实性知识）、"preference"（喜好/厌恶）、"episodic"（过往事件）
- "content": 对事实的简洁陈述
- "importance": 0.0 到 1.0 之间的浮点数，表示这条记忆的重要程度（1.0 = 极其重要，0.0 = 无关紧要）

如果对话只是普通的寒暄闲聊，没有实质性的新信息，返回空数组 []。

示例：
User: "我在谷歌工作，非常喜欢 Python"
Assistant: "太棒了！"
Output: [{"type": "semantic", "content": "用户在谷歌工作", "importance": 0.8}, {"type": "preference", "content": "用户喜欢 Python", "importance": 0.7}]`;

export class MemoryEngine {
  private collectionLoaded = false;

  // 确保 Milvus Collection 已加载
  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureMemoryCollection();
      this.collectionLoaded = true;
    }
  }

  // 将文本转为向量（便捷封装）
  async embed(text: string): Promise<number[] | null> {
    const provider = getDefaultEmbeddingProvider();
    if (!provider) return null;
    try {
      return await provider.embedSingle(text);
    } catch (e) {
      logger.warn(e, "Embedding failed");
      return null;
    }
  }

  // 存储一条记忆：向量化 → Milvus → PG（双写）
  async store(memory: MemoryCreate, userId: string): Promise<MemoryOut> {
    const memoryId = randomUUID();

    // 1. 生成 embedding 向量
    let embeddingId: bigint | null = null;
    const vector = await this.embed(memory.content);

    // 2. 写入 Milvus（带向量）
    if (vector) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        // Milvus SDK v2.x: fields_data 使用行式格式，每行是 { fieldName: value } 对象
        const mr = await client.insert({
          collection_name: MILVUS_MEMORY_COLLECTION,
          fields_data: [
            {
              memory_id: memoryId,
              user_id: userId,
              embedding: vector,
              content: memory.content.slice(0, 4096),
            },
          ],
        });
        embeddingId = BigInt((mr.IDs as any)?.int_id?.data?.[0] ?? 0);
      } catch (e) {
        logger.warn(e, "Milvus insert failed (graceful degradation)");
        // Milvus 失败不阻塞 PG 写入
      }
    }

    // 3. 写入 PG（主存储，始终成功）
    const dbMemory = await prisma.memory.create({
      data: {
        id: memoryId,
        userId,
        type: memory.type as any,
        content: memory.content,
        importance: memory.importance ?? 0.5,
        embeddingId: embeddingId !== null ? Number(embeddingId) : null,
        metadata: (memory.metadata ?? {}) as any,
        conversationId: memory.conversationId ?? null,
      },
    });

    return {
      id: dbMemory.id,
      userId: dbMemory.userId,
      type: dbMemory.type,
      content: dbMemory.content,
      importance: dbMemory.importance,
      metadata: dbMemory.metadata as Record<string, unknown> | null,
      conversationId: dbMemory.conversationId,
      createdAt: dbMemory.createdAt,
      updatedAt: dbMemory.updatedAt,
    };
  }

  // 搜索记忆：先查 PG 获取候选集 → Milvus 向量搜索 → 合并打分排序
  // sessionId 可选：传入后只返回 metadata.sessionId 匹配的记忆（客服匿名会话场景）
  async search(
    query: string,
    userId: string,
    topK: number = 5,
    sessionId?: string,
  ): Promise<MemorySearchResult[]> {
    const MILVUS_WEIGHT = 0.7;
    const IMPORTANCE_WEIGHT = 0.3;

    // 尝试向量搜索优先：Milvus语义搜索 → PG元数据补充 → 混合打分
    try {
      const vector = await this.embed(query);
      if (vector) {
        await this.ensureCollection();
        const client = getMilvusClient();

        // 搜索更宽候选集（topK×3），避免遗漏低importance但高语义相关的记忆
        const milvusSearchStart = Date.now();
        const results = await client.search({
          collection_name: MILVUS_MEMORY_COLLECTION,
          vector: vector,
          limit: topK * 3,
          filter: `user_id == "${userId}"`,
          output_fields: ["memory_id"],
          params: { nprobe: 16 },
        });
        milvusSearchDurationMs.observe(
          { operation: "memory" },
          Date.now() - milvusSearchStart,
        );

        if (results.results && results.results.length > 0) {
          // 提取Milvus结果中的memory_id和分数
          const milvusScores = new Map<string, number>();
          let maxMilvusScore = 0;
          for (const hit of results.results) {
            const mid = hit.memory_id as string;
            const score = hit.score ?? 0;
            milvusScores.set(mid, score);
            if (score > maxMilvusScore) maxMilvusScore = score;
          }

          // 从PG批量获取完整记忆记录
          const memoryIds = Array.from(milvusScores.keys());
          const pgMemories = await prisma.memory.findMany({
            where: { id: { in: memoryIds } },
          });

          // 混合打分：Milvus语义相似度(0.7) + importance(0.3)
          const scored: MemorySearchResult[] = pgMemories.map((m) => {
            const milvusScore = milvusScores.get(m.id) || 0;
            const normalizedMilvus =
              maxMilvusScore > 0 ? milvusScore / maxMilvusScore : 0;
            const blendedScore =
              MILVUS_WEIGHT * normalizedMilvus +
              IMPORTANCE_WEIGHT * m.importance;

            return {
              id: m.id,
              userId: m.userId,
              type: m.type,
              content: m.content,
              importance: m.importance,
              metadata: m.metadata as Record<string, unknown> | null,
              conversationId: m.conversationId,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
              score: Math.round(blendedScore * 10000) / 10000,
            };
          });

          scored.sort((a, b) => b.score - a.score);
          return this.filterBySession(scored.slice(0, topK), sessionId);
        }
      }
    } catch (e) {
      logger.warn(e, "Vector search failed, falling back to PG");
    }

    // 纯 PG 回退：用重要度作为分数（Milvus不可用时的降级策略）
    const memories = await prisma.memory.findMany({
      where: { userId },
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      take: topK,
    });

    const fallbackResults = memories.map((m) => ({
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
    return this.filterBySession(fallbackResults, sessionId);
  }

  // 按 sessionId 过滤记忆（用于客服匿名会话场景）
  private filterBySession<
    T extends { metadata: Record<string, unknown> | null },
  >(results: T[], sessionId?: string): T[] {
    if (!sessionId) return results;
    return results.filter((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return meta?.sessionId === sessionId;
    });
  }

  // 从对话中提取记忆：取最近 6 条消息 → LLM 分析 → 逐条存储
  // sessionId 可选：传入后存入 metadata.sessionId（客服匿名会话场景）
  async extractAndStore(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    conversationId: string,
    providerName: string = "",
    sessionId?: string,
  ): Promise<MemoryOut[]> {
    if (!messages || messages.length < 2) return []; // 至少一轮对话

    // 选择 LLM：通过provider抽象层，避免直接依赖具体厂商SDK
    let actualProvider = providerName;
    let model: string;

    if (providerName === "openai") {
      model = "gpt-4o-mini"; // 记忆提取是后台任务，用便宜模型
    } else {
      model = "deepseek-chat";
    }

    // 如果指定的provider不可用，尝试任何可用的provider
    if (!actualProvider) {
      const providers = listProviders();
      if (providers.length === 0) return []; // 没有可用的LLM
      actualProvider = providers[0].type;
      model = providers[0].models[0]?.id || model;
    }

    const provider = getProvider(actualProvider);

    // 只取最近 6 条消息（控制 token 消耗）
    const convText = messages
      .slice(-6)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    try {
      const result = await provider.chatSync(
        [{ role: "user", content: `Extract memories from:\n\n${convText}` }],
        model,
        SYSTEM_PROMPT_EXTRACT,
        0.1,
        500,
        true, // jsonMode for structured memory extraction
      );
      const content = result.content;

      // 解析 LLM 返回的 JSON（可能被 markdown 代码块包裹）
      const items = parseJSONFromLLMResponse(content);
      if (!Array.isArray(items)) return [];

      // 逐条存储提取的记忆
      const results: MemoryOut[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || !item.content) continue;
        const memory: MemoryCreate = {
          type: item.type || "semantic",
          content: item.content,
          importance: parseFloat(item.importance) || 0.5,
          conversationId,
          metadata: sessionId ? { sessionId } : undefined,
        };
        const result = await this.store(memory, userId);
        results.push(result);
      }

      if (results.length > 0) {
        logger.info(
          { count: results.length },
          "Memories extracted from conversation",
        );
        memoryExtractionsTotal.inc(results.length);
      }
      return results;
    } catch (e) {
      logger.warn(e, "Memory extraction failed");
      return [];
    }
  }

  // 列出用户所有记忆（支持按 type 过滤）
  async list(userId: string, type?: string): Promise<MemoryOut[]> {
    const where: Prisma.MemoryWhereInput = { userId };
    if (type) where.type = type as Prisma.MemoryWhereInput["type"];

    const memories = await prisma.memory.findMany({
      where,
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
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
    }));
  }

  // 删除单条记忆（PG + Milvus 双删）
  async delete(memoryId: string): Promise<boolean> {
    const dbMemory = await prisma.memory.findUnique({
      where: { id: memoryId },
    });
    if (!dbMemory) return false;

    // 从 Milvus 删除（用内部 ID 定位）
    if (dbMemory.embeddingId) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        await client.delete({
          collection_name: MILVUS_MEMORY_COLLECTION,
          filter: `id in [${dbMemory.embeddingId}]`,
        });
      } catch (e) {
        logger.warn(e, "Milvus delete failed");
      }
    }

    await prisma.memory.delete({ where: { id: memoryId } });
    return true;
  }
}
