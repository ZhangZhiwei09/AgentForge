// CircuitBreaker 单元测试 — 验证状态机转换和熔断行为
import { describe, it, expect, vi, afterEach } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("state machine", () => {
    it("starts CLOSED", () => {
      const cb = new CircuitBreaker("test", 3, 10_000);
      expect(cb.getState()).toBe("CLOSED");
    });

    it("successful calls keep it CLOSED", async () => {
      const cb = new CircuitBreaker("test", 3, 10_000);
      for (let i = 0; i < 10; i++) {
        await cb.call(() => Promise.resolve("ok"));
      }
      expect(cb.getState()).toBe("CLOSED");
    });

    it("opens after threshold consecutive failures", async () => {
      const cb = new CircuitBreaker("test", 3, 10_000);
      for (let i = 0; i < 3; i++) {
        try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      }
      expect(cb.getState()).toBe("OPEN");
    });

    it("stays CLOSED if failures are below threshold", async () => {
      const cb = new CircuitBreaker("test", 5, 10_000);
      for (let i = 0; i < 3; i++) {
        try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      }
      expect(cb.getState()).toBe("CLOSED");
    });

    it("throws CircuitBreakerOpenError when OPEN", async () => {
      const cb = new CircuitBreaker("test", 2, 10_000);
      // Trip the breaker
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("OPEN");

      // Now calls should fast-fail
      await expect(cb.call(() => Promise.resolve("ok"))).rejects.toThrow(
        CircuitBreakerOpenError,
      );
    });

    it("success resets failure count", async () => {
      const cb = new CircuitBreaker("test", 3, 10_000);
      // Fail twice
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}

      // Succeed once
      await cb.call(() => Promise.resolve("ok"));
      expect(cb.getState()).toBe("CLOSED");

      // Fail again — should need 3 more to trip (counter was reset)
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("CLOSED");
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("OPEN");
    });
  });

  describe("HALF_OPEN recovery", () => {
    it("transitions to HALF_OPEN after resetTimeout in OPEN", async () => {
      const cb = new CircuitBreaker("test", 2, 100); // 100ms timeout
      // Trip
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("OPEN");

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 150));

      // Next call should go through (HALF_OPEN probe)
      let called = false;
      await cb.call(async () => {
        called = true;
        return "probe-ok";
      });
      expect(called).toBe(true);
      expect(cb.getState()).toBe("CLOSED"); // Success → CLOSED
    });

    it("goes back to OPEN if HALF_OPEN probe fails", async () => {
      const cb = new CircuitBreaker("test", 2, 100);
      // Trip
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("OPEN");

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 150));

      // Probe fails
      try { await cb.call(() => Promise.reject(new Error("still-down"))); } catch {}
      expect(cb.getState()).toBe("OPEN");
    });
  });

  describe("recordFailure", () => {
    it("records failure without wrapping a call", () => {
      const cb = new CircuitBreaker("test", 2, 10_000);
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe("OPEN");
    });
  });

  describe("reset", () => {
    it("resets to CLOSED from OPEN", async () => {
      const cb = new CircuitBreaker("test", 1, 10_000);
      try { await cb.call(() => Promise.reject(new Error("fail"))); } catch {}
      expect(cb.getState()).toBe("OPEN");

      cb.reset();
      expect(cb.getState()).toBe("CLOSED");

      // Can call normally again
      const result = await cb.call(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
    });
  });

  describe("CircuitBreakerOpenError", () => {
    it("includes the breaker name in the message", () => {
      const err = new CircuitBreakerOpenError("my-breaker");
      expect(err.message).toContain("my-breaker");
      expect(err.name).toBe("CircuitBreakerOpenError");
    });
  });
});
