// 限流中间件 —— 基于可插拔存储（内存 / Redis）的滑动窗口限流
// 通过 getRateLimitStore() 自动选择存储后端：REDIS_URL 存在 → Redis，否则 → 内存
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../app.js";
import {
  getRateLimitStore,
  type RateLimitStore,
} from "../lib/rate-limit-store.js";

// 惰性初始化，首次请求时加载
let storePromise: Promise<RateLimitStore> | null = null;

function getStore(): Promise<RateLimitStore> {
  if (!storePromise) {
    storePromise = getRateLimitStore();
  }
  return storePromise;
}

export interface RateLimitConfig {
  windowMs: number; // 时间窗口（毫秒）
  max: number; // 窗口内最大请求数
  keyPrefix: string; // 存储隔离前缀
}

export function createRateLimiter(
  config: RateLimitConfig,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const ip =
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      c.req.header("X-Real-IP") ||
      "unknown";

    const store = await getStore();
    const key = `${config.keyPrefix}:${ip}`;
    const result = await store.increment(key, config.windowMs, config.max);

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      c.header("Retry-After", String(Math.max(retryAfter, 1)));
      return c.json(
        {
          detail: `Too many requests. Try again in ${Math.max(retryAfter, 1)} seconds.`,
        },
        429,
      );
    }

    // 注入剩余配额到响应头
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    await next();
  };
}

// 预配置的限流器
export const globalRateLimiter = createRateLimiter({
  windowMs: 60_000, // 1 分钟
  max: 60, // 每分钟 60 次
  keyPrefix: "global",
});
