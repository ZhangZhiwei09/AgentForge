// RetryExecutor tests — backoff calculation, retry behavior
import { describe, it, expect, vi } from "vitest";
import {
  executeWithRetry,
  calculateRetryDelay,
  DEFAULT_LLM_RETRY,
  DEFAULT_TOOL_RETRY,
} from "../retry-executor.js";

describe("calculateRetryDelay", () => {
  it("returns initialDelay for fixed backoff", () => {
    const config = {
      backoff: "fixed" as const,
      initialDelay: 1000,
      maxDelay: 10000,
    };
    expect(calculateRetryDelay(config, 1)).toBe(1000);
    expect(calculateRetryDelay(config, 3)).toBe(1000);
  });

  it("increases linearly for linear backoff", () => {
    const config = {
      backoff: "linear" as const,
      initialDelay: 500,
      maxDelay: 10000,
    };
    expect(calculateRetryDelay(config, 1)).toBe(500);
    expect(calculateRetryDelay(config, 3)).toBe(1500);
  });

  it("grows exponentially for exponential backoff", () => {
    const config = {
      backoff: "exponential" as const,
      initialDelay: 1000,
      maxDelay: 60000,
    };
    expect(calculateRetryDelay(config, 1)).toBe(1000); // 1000 * 2^0
    expect(calculateRetryDelay(config, 2)).toBe(2000); // 1000 * 2^1
    expect(calculateRetryDelay(config, 3)).toBe(4000); // 1000 * 2^2
  });

  it("caps at maxDelay", () => {
    const config = {
      backoff: "exponential" as const,
      initialDelay: 1000,
      maxDelay: 3000,
    };
    expect(calculateRetryDelay(config, 3)).toBe(3000);
    expect(calculateRetryDelay(config, 4)).toBe(3000);
  });
});

describe("executeWithRetry", () => {
  it("returns result on first success without retry", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await executeWithRetry(fn, DEFAULT_LLM_RETRY, "llm");
    expect(result.result).toBe("success");
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("success after retry");

    const result = await executeWithRetry(fn, DEFAULT_LLM_RETRY, "llm");
    expect(result.result).toBe("success after retry");
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
  });

  it("does not retry on fatal error by default", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    await expect(
      executeWithRetry(fn, DEFAULT_LLM_RETRY, "llm"),
    ).rejects.toThrow();
    // LLM retry config only retries retryable, not fatal
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(
      executeWithRetry(
        fn,
        {
          maxAttempts: 2,
          backoff: "fixed",
          initialDelay: 10,
          maxDelay: 100,
          retryOn: ["retryable"],
        },
        "llm",
      ),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects retryOn filter", async () => {
    // Config says only retry "degradable", but the error is "retryable"
    const fn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(
      executeWithRetry(
        fn,
        {
          maxAttempts: 3,
          backoff: "fixed",
          initialDelay: 10,
          maxDelay: 100,
          retryOn: ["degradable"],
        },
        "llm",
      ),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1); // Only one attempt — retryable not in retryOn
  });

  it("empty retryOn means no retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("any error"));
    await expect(
      executeWithRetry(
        fn,
        {
          maxAttempts: 3,
          backoff: "fixed",
          initialDelay: 10,
          maxDelay: 100,
          retryOn: [],
        },
        "llm",
      ),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("default LLM config retries on retryable only", async () => {
    expect(DEFAULT_LLM_RETRY.retryOn).toEqual(["retryable"]);
    expect(DEFAULT_LLM_RETRY.maxAttempts).toBe(3);
    expect(DEFAULT_LLM_RETRY.backoff).toBe("exponential");
  });

  it("default tool config retries on retryable and degradable", async () => {
    expect(DEFAULT_TOOL_RETRY.retryOn).toEqual(["retryable", "degradable"]);
    expect(DEFAULT_TOOL_RETRY.maxAttempts).toBe(2);
  });
});
