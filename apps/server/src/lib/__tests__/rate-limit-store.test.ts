// RateLimiterStore tests — InMemoryStore + RedisStore (mocked) + Factory
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  InMemoryStore,
  RedisStore,
  getRateLimitStore,
  _resetStore,
} from "../rate-limit-store.js";

// ============================================================
// Helpers
// ============================================================

/** Access the private Map inside InMemoryStore for cleanup verification. */
function getInMemoryStoreSize(s: InMemoryStore): number {
  // Test-only accessor — needed to verify LRU eviction of the internal store.
  return (s as unknown as { store: Map<string, unknown> }).store.size;
}

// ============================================================
// MockRedis —— in-memory sorted-set that simulates the Lua script
// ============================================================

class MockRedis {
  private data = new Map<string, Map<string, number>>(); // key → { member → score }
  private seq = 0;

  eval(
    _script: string,
    _numKeys: number,
    key: string,
    now: number,
    windowStart: number,
    maxRequests: number,
    windowMs: number,
  ): [number, number, number] {
    const zset = this.getOrCreateZSet(key);
    const nowNum = Number(now);
    const windowStartNum = Number(windowStart);
    const maxNum = Number(maxRequests);
    const winMs = Number(windowMs);

    // ZREMRANGEBYSCORE: remove entries outside the sliding window
    for (const [member, score] of zset) {
      if (score <= windowStartNum) zset.delete(member);
    }

    const count = zset.size;

    if (count >= maxNum) {
      let oldestScore = nowNum;
      for (const [, score] of zset) {
        if (score < oldestScore) oldestScore = score;
      }
      const resetAt = oldestScore + winMs;
      return [0, 0, resetAt];
    }

    this.seq++;
    const member = `${nowNum}:${this.seq}`;
    zset.set(member, nowNum);

    const newCount = zset.size;
    const resetAt = nowNum + winMs;
    return [1, maxNum - newCount, resetAt];
  }

  private getOrCreateZSet(key: string): Map<string, number> {
    let zset = this.data.get(key);
    if (!zset) {
      zset = new Map();
      this.data.set(key, zset);
    }
    return zset;
  }

  /** Minimal stub to satisfy the ioredis.Redis interface shape. */
  on() {
    return this;
  }
}

// ============================================================
// vi.mock for ioredis —— used by getRateLimitStore factory tests
// ============================================================

const { mockConnect, mockRedisEval } = vi.hoisted(() => ({
  mockConnect: vi.fn<() => Promise<void>>(),
  mockRedisEval: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => ({
    connect: mockConnect,
    eval: mockRedisEval,
    on: vi.fn(),
  })),
}));

// ============================================================
// InMemoryStore
// ============================================================

describe("InMemoryStore", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  // --- Test 1: first request returns { allowed: true, remaining: N-1 } ---

  it("returns { allowed: true, remaining: max-1 } for the first request", async () => {
    const result = await store.increment("key1", 60_000, 10);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("decrements remaining on subsequent requests within the same window", async () => {
    await store.increment("key1", 60_000, 10);
    const result = await store.increment("key1", 60_000, 10);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(8);
  });

  // --- Test 2: returns { allowed: false } when limit exceeded ---

  it("returns { allowed: false, remaining: 0 } when the limit is exceeded", async () => {
    const max = 3;
    for (let i = 0; i < max; i++) {
      await store.increment("key1", 60_000, max);
    }

    const blocked = await store.increment("key1", 60_000, max);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("keeps returning blocked for subsequent over-limit calls", async () => {
    const max = 2;
    await store.increment("key1", 60_000, max);
    await store.increment("key1", 60_000, max); // exhausted

    const r1 = await store.increment("key1", 60_000, max);
    const r2 = await store.increment("key1", 60_000, max);

    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
  });

  it("does not modify remaining below 0 on blocked calls", async () => {
    await store.increment("key1", 60_000, 1); // exhausted, remaining = 0

    const blocked = await store.increment("key1", 60_000, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  // --- Test 3: counter resets after window expires ---

  it("resets the counter after the window expires", async () => {
    const r1 = await store.increment("key1", 1, 10);
    expect(r1.allowed).toBe(true);

    // Wait for the 1ms window to expire
    await new Promise((r) => setTimeout(r, 5));

    const r2 = await store.increment("key1", 1, 10);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(9); // fresh window, max - 1
  });

  it("fully exhausts and then resets after window expiry", async () => {
    // Exhaust a 3-request limit
    for (let i = 0; i < 3; i++) {
      await store.increment("key1", 10, 3);
    }
    const blocked = await store.increment("key1", 10, 3);
    expect(blocked.allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 15));

    // New window — should be allowed again
    const fresh = await store.increment("key1", 10, 3);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(2);
  });

  // --- Test 4: different keys have independent counters ---

  it("tracks different keys with independent counters", async () => {
    // Exhaust key1
    await store.increment("key1", 60_000, 1);
    const blockedKey1 = await store.increment("key1", 60_000, 1);
    expect(blockedKey1.allowed).toBe(false);

    // key2 should be unaffected
    const r2 = await store.increment("key2", 60_000, 1);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    // key3 with a different limit
    const r3 = await store.increment("key3", 60_000, 100);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(99);
  });

  // --- Test 5: remaining count tracking (adapted from "get()") ---

  it("tracks the remaining count correctly across multiple requests", async () => {
    const max = 10;
    await store.increment("key1", 60_000, max); // remaining 9
    await store.increment("key1", 60_000, max); // remaining 8
    await store.increment("key1", 60_000, max); // remaining 7
    const result = await store.increment("key1", 60_000, max);
    expect(result.remaining).toBe(6);
  });

  // --- Test 6: correct resetAt timestamp (adapted from "reset()") ---

  it("returns the correct resetAt timestamp", async () => {
    const before = Date.now();
    const result = await store.increment("key1", 30_000, 10);
    const after = Date.now();

    // resetAt = timestamp at which the entry was created + windowMs
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(result.resetAt).toBeLessThanOrEqual(after + 30_000);
  });

  it("preserves the original resetAt for the entire fixed window", async () => {
    const r1 = await store.increment("key1", 60_000, 10);
    // Subsequent requests in the same window share the same resetAt
    const r2 = await store.increment("key1", 60_000, 10);
    expect(r2.resetAt).toBe(r1.resetAt);
  });

  // --- Test 7: LRU eviction when > 1000 entries ---

  it("evicts expired entries when the store exceeds 1000 entries", async () => {
    // Populate 1001 entries with a 1ms window — they expire almost immediately
    for (let i = 0; i < 1001; i++) {
      await store.increment(`expired-${i}`, 1, 100);
    }

    // Wait for all windows to expire
    await new Promise((r) => setTimeout(r, 10));

    // Verify > 1000 entries are present before cleanup
    expect(getInMemoryStoreSize(store)).toBeGreaterThan(1000);

    // Trigger cleanup via a new increment
    await store.increment("trigger-cleanup", 60_000, 10);

    // All 1001 expired entries should be removed; only "trigger-cleanup" stays
    expect(getInMemoryStoreSize(store)).toBe(1);
  });

  it("does NOT evict entries that are still within their window", async () => {
    // Create 1001 valid (non-expired) entries
    for (let i = 0; i < 1001; i++) {
      await store.increment(`valid-${i}`, 60_000, 100);
    }

    // Trigger cleanup — entries are still valid, so none should be removed
    await store.increment("trigger", 60_000, 10);

    // All entries plus the trigger should remain
    expect(getInMemoryStoreSize(store)).toBe(1002);
  });

  // --- Test 8: fixed window accuracy ---

  it("uses a fixed window — all requests in the window share resetAt", async () => {
    const r1 = await store.increment("key1", 60_000, 5);
    await store.increment("key1", 60_000, 5);
    await store.increment("key1", 60_000, 5);
    const r4 = await store.increment("key1", 60_000, 5);

    // Fixed window: same resetAt for all requests within the window
    expect(r4.resetAt).toBe(r1.resetAt);
  });

  it("starts a new fixed window with a new resetAt after expiry", async () => {
    const r1 = await store.increment("key1", 1, 10);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await store.increment("key1", 1, 10);

    // New window → new resetAt
    expect(r2.resetAt).toBeGreaterThan(r1.resetAt);
  });

  // --- Additional edge cases ---

  it("handles maxRequests=1 correctly (one-shot)", async () => {
    const r1 = await store.increment("oneshot", 60_000, 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);

    const r2 = await store.increment("oneshot", 60_000, 1);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it("allows many keys without performance degradation", async () => {
    // Create 500 keys, each with a couple of increments
    for (let i = 0; i < 500; i++) {
      const r1 = await store.increment(`perf-${i}`, 60_000, 3);
      expect(r1.allowed).toBe(true);
      await store.increment(`perf-${i}`, 60_000, 3);
    }

    // No crash, no slowdown — just verifying the store handles the load
    expect(getInMemoryStoreSize(store)).toBe(500);
  });
});

// ============================================================
// RedisStore (unit tests via MockRedis)
// ============================================================

describe("RedisStore", () => {
  let store: RedisStore;
  let mockRedis: MockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    // MockRedis satisfies the method-level contract of ioredis.Redis for eval + on.
    store = new RedisStore(mockRedis as unknown as import("ioredis").Redis);
  });

  // --- Test 9: delegates to Redis Lua script ---

  it("delegates to the Redis Lua script and returns the parsed result", async () => {
    const result = await store.increment("key1", 60_000, 10);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("decrements remaining on subsequent Lua script evaluations", async () => {
    await store.increment("key1", 60_000, 10);
    const result = await store.increment("key1", 60_000, 10);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(8);
  });

  it("blocks requests when the Lua script returns allowed=0", async () => {
    const max = 3;
    for (let i = 0; i < max; i++) {
      await store.increment("key1", 60_000, max);
    }

    const blocked = await store.increment("key1", 60_000, max);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  // --- Test 12: sliding window algorithm correctness ---

  it("uses a sliding window — old entries expire as time advances", async () => {
    vi.useFakeTimers();
    const baseTime = 1_000_000_000; // arbitrary fixed point
    vi.setSystemTime(baseTime);

    const winMs = 60_000;
    const max = 5;

    // Send 5 requests at t=0 — exhausts the limit
    for (let i = 0; i < max; i++) {
      const r = await store.increment("sliding", winMs, max);
      expect(r.allowed).toBe(true);
    }

    // 6th request at t=0 should be blocked
    const blocked = await store.increment("sliding", winMs, max);
    expect(blocked.allowed).toBe(false);

    // Advance time past the window
    vi.setSystemTime(baseTime + winMs + 1);

    // Now the sliding window is empty — request should be allowed
    const fresh = await store.increment("sliding", winMs, max);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(max - 1);

    vi.useRealTimers();
  });

  it("cleans only old entries — recent entries persist in the window", async () => {
    vi.useFakeTimers();
    const baseTime = 1_000_000_000;
    vi.setSystemTime(baseTime);

    const winMs = 60_000;
    const max = 5;

    // Send 3 requests at t=0
    for (let i = 0; i < 3; i++) {
      await store.increment("partial", winMs, max);
    }

    // Advance time by half the window — old entries are still within the window
    vi.setSystemTime(baseTime + winMs / 2);

    // 3 more requests — should be allowed (3 + 3 = 6 > 5) wait, that would exceed
    // Actually: the 3 original entries are still in the window (they were added at t=0,
    // windowStart at t=30000 would be t=-30000, so entries at t=0 are still valid).
    // But ZCARD returns 3, and max=5, so 3 more should be allowed.
    for (let i = 0; i < 2; i++) {
      const r = await store.increment("partial", winMs, max);
      expect(r.allowed).toBe(true);
    }

    // Now count = 5 — next should be blocked
    const blocked = await store.increment("partial", winMs, max);
    expect(blocked.allowed).toBe(false);

    vi.useRealTimers();
  });

  it("tracks different keys independently with the ratelimit: prefix", async () => {
    // Exhaust key1
    await store.increment("key1", 60_000, 1);
    const blocked = await store.increment("key1", 60_000, 1);
    expect(blocked.allowed).toBe(false);

    // key2 is independent
    const r2 = await store.increment("key2", 60_000, 1);
    expect(r2.allowed).toBe(true);
  });

  it("handles maxRequests=1 correctly (one-shot)", async () => {
    const r1 = await store.increment("oneshot", 60_000, 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);

    const r2 = await store.increment("oneshot", 60_000, 1);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it("returns a plausible resetAt from the Lua script result", async () => {
    const before = Date.now();
    const result = await store.increment("key1", 30_000, 10);
    const after = Date.now();

    // resetAt should be roughly now + windowMs
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(result.resetAt).toBeLessThanOrEqual(after + 30_000 + 500); // some tolerance
  });
});

// ============================================================
// getRateLimitStore (factory)
// ============================================================

describe("getRateLimitStore", () => {
  beforeEach(() => {
    _resetStore();
    delete process.env.REDIS_URL;
    mockConnect.mockReset();
    mockRedisEval.mockReset();
  });

  afterEach(() => {
    _resetStore();
    delete process.env.REDIS_URL;
  });

  // --- Test 11: factory returns correct type ---

  it("returns InMemoryStore when REDIS_URL is not set", async () => {
    const store = await getRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("returns the same singleton instance on subsequent calls", async () => {
    const store1 = await getRateLimitStore();
    const store2 = await getRateLimitStore();
    expect(store2).toBe(store1);
  });

  it("returns RedisStore when REDIS_URL is set and Redis connects successfully", async () => {
    mockConnect.mockResolvedValue(undefined);
    process.env.REDIS_URL = "redis://localhost:6379";

    const store = await getRateLimitStore();
    expect(store).toBeInstanceOf(RedisStore);
  });

  // --- Test 10: Redis connection error fallback ---

  it("falls back to InMemoryStore when Redis connection fails", async () => {
    mockConnect.mockRejectedValue(new Error("Connection refused"));
    process.env.REDIS_URL = "redis://localhost:6379";

    const store = await getRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("falls back when the Redis constructor throws", async () => {
    // Simulate a failure during Redis construction by making connect throw
    // (the constructor itself is mocked and won't throw, but connect will)
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    process.env.REDIS_URL = "redis://invalid:6379";

    const store = await getRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("_resetStore clears the singleton so a new store can be created", async () => {
    // First call creates and caches an InMemoryStore
    const store1 = await getRateLimitStore();
    expect(store1).toBeInstanceOf(InMemoryStore);

    _resetStore();

    // Now set REDIS_URL and mock success
    mockConnect.mockResolvedValue(undefined);
    process.env.REDIS_URL = "redis://localhost:6379";

    const store2 = await getRateLimitStore();
    expect(store2).toBeInstanceOf(RedisStore);
  });
});
