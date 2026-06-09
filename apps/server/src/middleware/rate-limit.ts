// Simple in-memory rate limiter middleware
// Uses a sliding window with per-IP tracking
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../app.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(key: string, windowMs: number): Map<string, RateLimitEntry> {
  const now = Date.now();
  let store = stores.get(key);
  if (!store) {
    store = new Map();
    stores.set(key, store);
  }
  // Cleanup expired entries periodically
  for (const [k, v] of store) {
    if (now > v.resetAt) store.delete(k);
  }
  return store;
}

export interface RateLimitConfig {
  windowMs: number;   // Time window in milliseconds
  max: number;         // Max requests per window
  keyPrefix: string;   // Prefix for store isolation
}

export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      || c.req.header("X-Real-IP")
      || "unknown";
    const store = getStore(config.keyPrefix, config.windowMs);

    const now = Date.now();
    const entry = store.get(ip);

    if (entry && now < entry.resetAt && entry.count >= config.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({
        detail: `Too many requests. Try again in ${retryAfter} seconds.`,
      }, 429);
    }

    if (!entry || now >= entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + config.windowMs });
    } else {
      entry.count++;
    }

    await next();
  };
}

// Pre-configured rate limiters
export const globalRateLimiter = createRateLimiter({
  windowMs: 60_000,  // 1 minute
  max: 60,           // 60 requests per minute
  keyPrefix: "global",
});

export const chatRateLimiter = createRateLimiter({
  windowMs: 60_000,  // 1 minute
  max: 20,           // 20 chat requests per minute
  keyPrefix: "chat",
});
