// 限流存储抽象层 —— 支持内存存储和 Redis 存储
// 自动根据 REDIS_URL 环境变量选择存储后端
// Redis 连接失败时自动降级为内存存储

import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp in ms
}

export interface RateLimitStore {
  /** 对指定 key 递增计数，返回是否允许通过 */
  increment(
    key: string,
    windowMs: number,
    maxRequests: number,
  ): Promise<RateLimitResult>;
}

// ============================================================
// InMemoryStore —— 简单固定窗口算法
// ============================================================

interface InMemoryEntry {
  count: number;
  resetAt: number;
}

export class InMemoryStore implements RateLimitStore {
  private store = new Map<string, InMemoryEntry>();

  /** 清理过期条目（每次 increment 时顺便清理） */
  private cleanup(now: number): void {
    // 每 100 次 increment 才做一次全量清理，避免遍历开销
    if (this.store.size > 1000) {
      for (const [k, v] of this.store) {
        if (now > v.resetAt) this.store.delete(k);
      }
    }
  }

  async increment(
    key: string,
    windowMs: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    this.cleanup(now);

    const entry = this.store.get(key);

    // 窗口已过期或首次请求 → 重置
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + windowMs;
      this.store.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: maxRequests - 1, resetAt };
    }

    // 窗口内已达上限
    if (entry.count >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      };
    }

    // 窗口内递增
    entry.count++;
    return {
      allowed: true,
      remaining: maxRequests - entry.count,
      resetAt: entry.resetAt,
    };
  }
}

// ============================================================
// RedisStore —— 滑动窗口算法（Sorted Set）
// ============================================================

export class RedisStore implements RateLimitStore {
  private readonly prefix = "ratelimit:";

  constructor(private redis: Redis) {}

  async increment(
    key: string,
    windowMs: number,
    maxRequests: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const redisKey = this.prefix + key;

    // 使用 Lua 脚本保证原子性
    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local maxRequests = tonumber(ARGV[3])
      local windowMs = tonumber(ARGV[4])

      -- 清理窗口外的旧记录
      redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

      -- 统计当前窗口内的请求数
      local count = redis.call('ZCARD', key)

      if count >= maxRequests then
        -- 已达上限，获取最早的过期时间作为 resetAt
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local resetAt = 0
        if #oldest > 0 then
          resetAt = tonumber(oldest[2]) + windowMs
        end
        return {0, 0, resetAt}
      end

      -- 添加当前请求（用纳秒级时间戳 + 随机数保证唯一性）
      local member = now .. ':' .. redis.call('INCR', 'ratelimit:seq')
      redis.call('ZADD', key, now, member)

      -- 设置 key 过期时间（窗口的 2 倍，防止僵尸 key）
      redis.call('PEXPIRE', key, windowMs * 2)

      count = redis.call('ZCARD', key)
      local resetAt = now + windowMs
      return {1, maxRequests - count, resetAt}
    `;

    const result = (await this.redis.eval(
      script,
      1,
      redisKey,
      now,
      windowStart,
      maxRequests,
      windowMs,
    )) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetAt: result[2],
    };
  }
}

// ============================================================
// 工厂函数 —— 自动选择存储后端
// ============================================================

let _store: RateLimitStore | null = null;

export async function getRateLimitStore(): Promise<RateLimitStore> {
  if (_store) return _store;

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      // 动态导入 ioredis，避免未安装时崩溃
      const { Redis } = await import("ioredis");
      const redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        retryStrategy(times) {
          if (times > 2) return null; // 停止重试
          return Math.min(times * 200, 1000);
        },
      });

      await redis.connect();
      _store = new RedisStore(redis);
      // eslint-disable-next-line no-console
      console.log("[RateLimit] Using Redis store");
      return _store;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[RateLimit] Redis connection failed, falling back to in-memory store:",
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }

  _store = new InMemoryStore();
  // eslint-disable-next-line no-console
  console.log("[RateLimit] Using in-memory store");
  return _store;
}

/** 仅用于测试 —— 重置 store 单例 */
export function _resetStore(): void {
  _store = null;
}
