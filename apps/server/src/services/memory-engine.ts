import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getMilvusClient, MILVUS_MEMORY_COLLECTION, EMBEDDING_DIM, ensureMemoryCollection } from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { settings } from "../config.js";
import OpenAI from "openai";

export interface MemoryCreate {
  type: string;
  content: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
}

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

export interface MemorySearchResult extends MemoryOut {
  score: number;
}

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

  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureMemoryCollection();
      this.collectionLoaded = true;
    }
  }

  async embed(text: string): Promise<number[] | null> {
    const provider = getDefaultEmbeddingProvider();
    if (!provider) return null;
    try {
      return await provider.embedSingle(text);
    } catch (e) {
      console.warn(`[memory] Embedding failed:`, e);
      return null;
    }
  }

  async store(memory: MemoryCreate, userId: string): Promise<MemoryOut> {
    const memoryId = randomUUID();

    // Get vector embedding
    let embeddingId: bigint | null = null;
    const vector = await this.embed(memory.content);

    // Insert into Milvus
    if (vector) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        const mr = await client.insert({
          collection_name: MILVUS_MEMORY_COLLECTION,
          fields_data: [
            { name: "memory_id", values: [memoryId] },
            { name: "user_id", values: [userId] },
            { name: "embedding", values: [vector] },
            { name: "content", values: [memory.content.slice(0, 4096)] },
          ],
        });
        embeddingId = BigInt((mr.IDs as any)?.int_id?.data?.[0] ?? 0);
      } catch (e) {
        console.warn(`[memory] Milvus insert failed:`, e);
      }
    }

    // Save to PostgreSQL
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

  async search(
    query: string,
    userId: string,
    topK: number = 5,
  ): Promise<MemorySearchResult[]> {
    // Fallback: get memories from PostgreSQL
    const memories = await prisma.memory.findMany({
      where: { userId },
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      take: topK,
    });

    // Try vector search
    try {
      const vector = await this.embed(query);
      if (vector) {
        await this.ensureCollection();
        const client = getMilvusClient();

        const results = await client.search({
          collection_name: MILVUS_MEMORY_COLLECTION,
          vector: vector,
          limit: topK,
          filter: `user_id == "${userId}"`,
          output_fields: ["memory_id"],
          params: { nprobe: 16 },
        });

        if (results.results && results.results.length > 0) {
          const scored: Record<string, number> = {};
          for (const hit of results.results) {
            const mid = hit.memory_id as string;
            scored[mid] = hit.score ?? 0;
          }

          const scoredMemories: MemorySearchResult[] = [];
          const memoryMap = new Map(memories.map((m) => [m.id, m]));

          for (const [mid, score] of Object.entries(scored)) {
            const m = memoryMap.get(mid);
            if (m) {
              scoredMemories.push({
                id: m.id,
                userId: m.userId,
                type: m.type,
                content: m.content,
                importance: m.importance,
                metadata: m.metadata as Record<string, unknown> | null,
                conversationId: m.conversationId,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt,
                score,
              });
            }
          }

          // Add non-vector-matched memories
          const scoredIds = new Set(Object.keys(scored));
          for (const m of memories) {
            if (!scoredIds.has(m.id)) {
              scoredMemories.push({
                id: m.id,
                userId: m.userId,
                type: m.type,
                content: m.content,
                importance: m.importance,
                metadata: m.metadata as Record<string, unknown> | null,
                conversationId: m.conversationId,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt,
                score: 0.0,
              });
            }
          }

          scoredMemories.sort((a, b) => b.score - a.score);
          return scoredMemories.slice(0, topK);
        }
      }
    } catch (e) {
      console.warn(`[memory] Vector search failed, falling back to PG:`, e);
    }

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
  }

  async extractAndStore(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    conversationId: string,
    providerName: string = "",
  ): Promise<MemoryOut[]> {
    if (!messages || messages.length < 2) return [];

    // Use OpenAI if available, otherwise DeepSeek
    let client: OpenAI;
    let model: string;

    if (providerName === "openai" && settings.openaiApiKey) {
      client = new OpenAI({
        apiKey: settings.openaiApiKey,
        baseURL: settings.openaiBaseUrl,
      });
      model = "gpt-4o-mini";
    } else if (settings.deepseekApiKey) {
      client = new OpenAI({
        apiKey: settings.deepseekApiKey,
        baseURL: settings.deepseekBaseUrl,
      });
      model = "deepseek-chat";
    } else if (settings.openaiApiKey) {
      client = new OpenAI({
        apiKey: settings.openaiApiKey,
        baseURL: settings.openaiBaseUrl,
      });
      model = "gpt-4o-mini";
    } else {
      return [];
    }

    const convText = messages
      .slice(-6)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT_EXTRACT },
          { role: "user", content: `Extract memories from:\n\n${convText}` },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      let content = response.choices[0].message.content?.trim() || "";
      if (content.startsWith("```")) {
        content = content.split("```")[1];
        if (content.startsWith("json")) content = content.slice(4);
        content = content.trim();
      }

      const items = JSON.parse(content);
      if (!Array.isArray(items)) return [];

      const results: MemoryOut[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || !item.content) continue;
        const memory: MemoryCreate = {
          type: item.type || "semantic",
          content: item.content,
          importance: parseFloat(item.importance) || 0.5,
          conversationId,
        };
        const result = await this.store(memory, userId);
        results.push(result);
      }

      if (results.length > 0) {
        console.log(`[memory] Extracted ${results.length} memories from conversation`);
      }
      return results;
    } catch (e) {
      console.warn(`[memory] Memory extraction failed:`, e);
      return [];
    }
  }

  async list(userId: string, type?: string): Promise<MemoryOut[]> {
    const where: any = { userId };
    if (type) where.type = type;

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

  async delete(memoryId: string): Promise<boolean> {
    const dbMemory = await prisma.memory.findUnique({ where: { id: memoryId } });
    if (!dbMemory) return false;

    // Delete from Milvus
    if (dbMemory.embeddingId) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        await client.delete({
          collection_name: MILVUS_MEMORY_COLLECTION,
          filter: `id in [${dbMemory.embeddingId}]`,
        });
      } catch (e) {
        console.warn(`[memory] Milvus delete failed:`, e);
      }
    }

    await prisma.memory.delete({ where: { id: memoryId } });
    return true;
  }
}
