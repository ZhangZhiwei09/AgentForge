// 限流中间件测试 —— 基于可插拔存储的滑动窗口限流
// 通过 mock rate-limit-store 隔离中间件逻辑
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// ============================================================
// Mock: rate-limit-store
// ============================================================

const mockIncrement = vi.fn();

vi.mock("../../lib/rate-limit-store.js", () => ({
  getRateLimitStore: () => Promise.resolve({ increment: mockIncrement }),
  _resetStore: vi.fn(),
}));

import { createRateLimiter, type RateLimitConfig } from "../rate-limit.js";

// ============================================================
// Helpers
// ============================================================

function makeApp(config?: Partial<RateLimitConfig>) {
  const app = new Hono();
  app.use(
    "/test/*",
    createRateLimiter({
      windowMs: 60_000,
      max: 5,
      keyPrefix: "test",
      ...config,
    }),
  );
  app.get("/test/ok", (c) => c.text("ok"));
  return app;
}

function allowResponse(remaining: number, resetAt?: number) {
  mockIncrement.mockResolvedValue({
    allowed: true,
    remaining,
    resetAt: resetAt ?? Date.now() + 60_000,
  });
}

function blockResponse() {
  mockIncrement.mockResolvedValue({
    allowed: false,
    remaining: 0,
    resetAt: Date.now() + 60_000,
  });
}

describe("createRateLimiter - middleware", () => {
  beforeEach(() => {
    mockIncrement.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------
  // 1. First request within window → passes (200)
  // ----------------------------------------------------------
  it("allows first request within the rate limit window (200)", async () => {
    allowResponse(4);
    const app = makeApp();
    const res = await app.request("/test/ok");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // ----------------------------------------------------------
  // 2. Requests up to limit → all pass
  // ----------------------------------------------------------
  it("allows requests up to the configured max limit", async () => {
    // Default config: max = 5, all should pass
    mockIncrement.mockResolvedValue({
      allowed: true,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const app = makeApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/test/ok");
      expect(res.status).toBe(200);
    }
  });

  // ----------------------------------------------------------
  // 3. Request exceeding limit → 429 with Retry-After header
  // ----------------------------------------------------------
  it("returns 429 with Retry-After header when rate limit is exceeded", async () => {
    const fakeNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    blockResponse();
    // Re-apply: blockResponse used Date.now() before fake timers took effect
    mockIncrement.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: fakeNow + 60_000,
    });

    const app = makeApp();
    const res = await app.request("/test/ok");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");

    const body = await res.json();
    expect(body.detail).toContain("Too many requests");
    expect(body.detail).toContain("60");
  });

  // ----------------------------------------------------------
  // 4. X-RateLimit-Remaining header decreases correctly
  // ----------------------------------------------------------
  it("sets X-RateLimit-Remaining header that decreases with each request", async () => {
    const app = makeApp();

    // Request 1
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 4,
      resetAt: Date.now() + 60_000,
    });
    const res1 = await app.request("/test/ok");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-RateLimit-Remaining")).toBe("4");

    // Request 2
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 3,
      resetAt: Date.now() + 60_000,
    });
    const res2 = await app.request("/test/ok");
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-RateLimit-Remaining")).toBe("3");

    // Request 3
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 2,
      resetAt: Date.now() + 60_000,
    });
    const res3 = await app.request("/test/ok");
    expect(res3.status).toBe(200);
    expect(res3.headers.get("X-RateLimit-Remaining")).toBe("2");
  });

  // ----------------------------------------------------------
  // 5. X-RateLimit-Reset header is set
  // ----------------------------------------------------------
  it("sets X-RateLimit-Reset header with a future Unix timestamp", async () => {
    const fakeNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    mockIncrement.mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: fakeNow + 60_000,
    });

    const app = makeApp();
    const res = await app.request("/test/ok");

    expect(res.status).toBe(200);
    // resetAt / 1000 = (fakeNow + 60000) / 1000
    const expectedReset = Math.ceil((fakeNow + 60_000) / 1000);
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String(expectedReset));
  });

  // ----------------------------------------------------------
  // 6. Different IPs have independent rate limits
  // ----------------------------------------------------------
  it("tracks different IPs independently via separate store keys", async () => {
    const app = makeApp();

    // IP 1.2.3.4 → allowed
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 4,
      resetAt: Date.now() + 60_000,
    });
    await app.request("/test/ok", {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });

    // IP 5.6.7.8 → also allowed (independent counter)
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 4,
      resetAt: Date.now() + 60_000,
    });
    const res = await app.request("/test/ok", {
      headers: { "X-Forwarded-For": "5.6.7.8" },
    });

    expect(res.status).toBe(200);

    // Verify different keys were used
    const calls = mockIncrement.mock.calls;
    expect(calls[0][0]).toBe("test:1.2.3.4");
    expect(calls[1][0]).toBe("test:5.6.7.8");
  });

  // ----------------------------------------------------------
  // 7. Respects X-Forwarded-For header
  // ----------------------------------------------------------
  it("extracts the first IP from X-Forwarded-For header", async () => {
    allowResponse(4);
    const app = makeApp();

    await app.request("/test/ok", {
      headers: { "X-Forwarded-For": "10.0.0.1, 10.0.0.2, 10.0.0.3" },
    });

    // Only the first IP should be used in the key
    expect(mockIncrement).toHaveBeenCalledWith(
      "test:10.0.0.1",
      60_000,
      5,
    );
  });

  // ----------------------------------------------------------
  // 8. Falls back to "unknown" when no IP headers present
  // ----------------------------------------------------------
  it('falls back to "unknown" when X-Forwarded-For and X-Real-IP are absent', async () => {
    allowResponse(4);
    const app = makeApp();

    await app.request("/test/ok");

    expect(mockIncrement).toHaveBeenCalledWith(
      "test:unknown",
      60_000,
      5,
    );
  });

  // ----------------------------------------------------------
  // 9. Rate limit counter resets after window expires
  // ----------------------------------------------------------
  it("allows requests again after the rate limit window expires", async () => {
    const app = makeApp();

    // First request: blocked (limit hit)
    mockIncrement.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });
    const blocked = await app.request("/test/ok");
    expect(blocked.status).toBe(429);

    // After window expires: store reports allowed again
    mockIncrement.mockResolvedValueOnce({
      allowed: true,
      remaining: 4,
      resetAt: Date.now() + 60_000,
    });
    const allowed = await app.request("/test/ok");
    expect(allowed.status).toBe(200);
  });

  // ----------------------------------------------------------
  // 10. Custom window/max from config is respected
  // ----------------------------------------------------------
  it("passes custom windowMs and max from config to the store", async () => {
    allowResponse(9);
    const app = makeApp({
      windowMs: 30_000, // 30-second window
      max: 10, // 10 requests per window
      keyPrefix: "custom",
    });

    const res = await app.request("/test/ok");
    expect(res.status).toBe(200);

    expect(mockIncrement).toHaveBeenCalledWith(
      "custom:unknown",
      30_000,
      10,
    );
  });

  // ----------------------------------------------------------
  // Bonus: Retry-After floors to 1 when already expired
  // ----------------------------------------------------------
  it("sets Retry-After to at least 1 second even when resetAt is in the past", async () => {
    const fakeNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    mockIncrement.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: fakeNow - 10_000, // Already expired
    });

    const app = makeApp();
    const res = await app.request("/test/ok");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  // ----------------------------------------------------------
  // Bonus: Respects X-Real-IP as fallback before "unknown"
  // ----------------------------------------------------------
  it("uses X-Real-IP header as fallback before defaulting to unknown", async () => {
    allowResponse(4);
    const app = makeApp();

    await app.request("/test/ok", {
      headers: { "X-Real-IP": "192.168.1.100" },
    });

    expect(mockIncrement).toHaveBeenCalledWith(
      "test:192.168.1.100",
      60_000,
      5,
    );
  });
});
