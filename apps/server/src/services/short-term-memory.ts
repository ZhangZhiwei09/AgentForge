// 短期记忆存储 —— Redis 滑动窗口 + 摘要生成
//
// 存储结构（Redis）：
//   - ZSET: `conv:{conversationId}:messages` — 按时间戳排序的消息窗口
//   - STRING: `conv:{conversationId}:summary` — 窗口溢出后生成的摘要
//
// 行为：
//   - 按 conversationId/sessionId 存滑动窗口消息（默认最近 20 条）
//   - 超过窗口大小后，调用 LLM 生成旧消息摘要，替换旧消息
//   - TTL 默认 7 天
//   - Redis 不可用时降级为内存 Map（有限容量）

import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { settings } from "../config.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { logger } from "@agentforge/logger";

// ── 类型 ──────────────────────────────────────────────────

export interface ShortTermMemoryMsg {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface ShortTermMemoryContext {
  summary: string;                    // 旧消息摘要（如有）
  recentMessages: ShortTermMemoryMsg[]; // 当前窗口内的消息
  messageCount: number;               // 会话总消息数
}

// ── 常量 ──────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 20;       // 保留最近 N 条消息
const DEFAULT_TTL_SEC = 7 * 24 * 3600; // 7 天
const SUMMARY_TRIGGER = 30;           // 消息数超过此阈值 → 触发摘要

const SUMMARY_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩为简洁摘要，保留关键信息：

- 用户提到的事实、偏好、需求
- 对话中达成的结论或决定
- 未解决的问题或后续任务

请用 2-5 句话输出摘要。`;

// ── ShortTermMemoryStore ──────────────────────────────────

export class ShortTermMemoryStore {
  private redis: Redis | null = null;
  private memoryFallback: Map<string, ShortTermMemoryMsg[]> = new Map();
  private summaryFallback: Map<string, string> = new Map();

  private getRedis(): Redis | null {
    if (!this.redis && settings.redisUrl) {
      try {
        this.redis = new Redis(settings.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        });
        logger.info("ShortTermMemory Redis client created");
      } catch (e) {
        logger.warn(e, "ShortTermMemory Redis init failed");
        return null;
      }
    }
    return this.redis;
  }

  // 添加消息到滑动窗口
  async addMessage(
    conversationId: string,
    msg: ShortTermMemoryMsg,
  ): Promise<void> {
    const key = this.messageKey(conversationId);
    const redis = this.getRedis();

    if (redis) {
      try {
        // ZSET: score = timestamp, member = JSON serialized message
        const json = JSON.stringify(msg);
        await redis.zadd(key, msg.timestamp, json);
        await redis.expire(key, DEFAULT_TTL_SEC);

        // 检查窗口大小，溢出时生成摘要
        const count = await redis.zcard(key);
        if (count > SUMMARY_TRIGGER) {
          await this.compressWindow(conversationId);
        }
      } catch (e) {
        logger.warn(e, "ShortTermMemory Redis addMessage failed");
        this.addToFallback(conversationId, msg);
      }
    } else {
      this.addToFallback(conversationId, msg);
    }
  }

  // 获取会话上下文（摘要 + 最近 N 条消息）
  async getContext(conversationId: string): Promise<ShortTermMemoryContext> {
    const redis = this.getRedis();

    if (redis) {
      try {
        const key = this.messageKey(conversationId);
        const summaryKey = this.summaryKey(conversationId);

        // 并行获取摘要和最近消息
        const [summary, rawMessages] = await Promise.all([
          redis.get(summaryKey),
          redis.zrange(key, -DEFAULT_WINDOW_SIZE, -1), // 最新 N 条
        ]);

        const messages: ShortTermMemoryMsg[] = [];
        for (const raw of rawMessages) {
          try {
            messages.push(JSON.parse(raw));
          } catch {
            // 跳过损坏的消息
          }
        }

        const totalCount = await redis.zcard(key);

        return {
          summary: summary || "",
          recentMessages: messages,
          messageCount: totalCount,
        };
      } catch (e) {
        logger.warn(e, "ShortTermMemory Redis getContext failed");
      }
    }

    // Fallback
    const fallbackMsgs = this.memoryFallback.get(conversationId) || [];
    return {
      summary: this.summaryFallback.get(conversationId) || "",
      recentMessages: fallbackMsgs.slice(-DEFAULT_WINDOW_SIZE),
      messageCount: fallbackMsgs.length,
    };
  }

  // 添加助手回复 → 存储
  async addAssistantReply(
    conversationId: string,
    userMsg: string,
    assistantReply: string,
  ): Promise<void> {
    const now = Date.now();
    await this.addMessage(conversationId, {
      id: randomUUID(),
      role: "user",
      content: userMsg,
      timestamp: now - 1,
    });
    await this.addMessage(conversationId, {
      id: randomUUID(),
      role: "assistant",
      content: assistantReply,
      timestamp: now,
    });
  }

  // 清理会话（删除 Redis key + 本地缓存）
  async cleanup(conversationId: string): Promise<void> {
    const redis = this.getRedis();
    if (redis) {
      try {
        await redis.del(
          this.messageKey(conversationId),
          this.summaryKey(conversationId),
        );
      } catch (e) {
        logger.warn(e, "ShortTermMemory cleanup failed");
      }
    }
    this.memoryFallback.delete(conversationId);
    this.summaryFallback.delete(conversationId);
  }

  // ── 私有方法 ────────────────────────────────────────────

  private messageKey(conversationId: string): string {
    return `conv:${conversationId}:messages`;
  }

  private summaryKey(conversationId: string): string {
    return `conv:${conversationId}:summary`;
  }

  // 压缩窗口：取旧消息 → LLM 生成摘要 → 替换旧消息
  private async compressWindow(conversationId: string): Promise<void> {
    const redis = this.getRedis();
    if (!redis) return;

    try {
      const key = this.messageKey(conversationId);

      // 获取超出窗口的旧消息（保留最近 20 条）
      const totalCount = await redis.zcard(key);
      const removeCount = totalCount - DEFAULT_WINDOW_SIZE;
      if (removeCount <= 0) return;

      const oldMessages = await redis.zrange(key, 0, removeCount - 1);
      const parsed: ShortTermMemoryMsg[] = [];
      for (const raw of oldMessages) {
        try {
          parsed.push(JSON.parse(raw));
        } catch {
          // skip
        }
      }

      if (parsed.length === 0) return;

      // 调用 LLM 生成摘要
      const providerName = this.getLLMProvider();
      if (providerName) {
        const provider = getProvider(providerName);
        const convText = parsed
          .map(
            (m) =>
              `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 200)}`,
          )
          .join("\n");

        try {
          const result = await provider.chatSync(
            [
              {
                role: "user",
                content: `对话历史：\n\n${convText}`,
              },
            ],
            settings.defaultModel,
            SUMMARY_PROMPT,
            0.1,
            500,
            false,
          );

          // 保存摘要
          const existingSummary = await redis.get(this.summaryKey(conversationId));
          const newSummary = existingSummary
            ? `${existingSummary}\n\n${result.content}`
            : result.content;
          await redis.set(this.summaryKey(conversationId), newSummary);
          await redis.expire(this.summaryKey(conversationId), DEFAULT_TTL_SEC);
        } catch (e) {
          logger.warn(e, "Summary generation failed");
        }
      }

      // 删除已摘要的旧消息
      await redis.zremrangebyrank(key, 0, removeCount - 1);
    } catch (e) {
      logger.warn(e, "Window compression failed");
    }
  }

  private addToFallback(
    conversationId: string,
    msg: ShortTermMemoryMsg,
  ): void {
    const msgs = this.memoryFallback.get(conversationId) || [];
    msgs.push(msg);
    // 限制内存 fallback 大小
    if (msgs.length > 100) {
      msgs.splice(0, msgs.length - 100);
    }
    this.memoryFallback.set(conversationId, msgs);
  }

  private getLLMProvider(): string | null {
    const providers = listProviders();
    if (providers.length === 0) return null;
    return providers[0].type;
  }
}
