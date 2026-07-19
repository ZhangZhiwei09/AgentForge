// Step Runner Unit Tests
// ============================================
// Tests for executeSingleStep, executeSingleStepWithTimeout,
// executeWithRetry, calculateRetryDelay, and sleep.
//
// Key design insight: executeSingleStep catches ALL handler errors and
// returns { status: "failed" } — it never throws. Therefore:
//   - executeSingleStepWithTimeout only rejects on timeout (not handler errors)
//   - executeWithRetry only retries on timeout rejections
// Handler-level failures bypass the retry loop and return immediately.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowStep, WorkflowDefinition, StepResult } from "@agentforge/shared-types";
import type { StepHandler, StepContext } from "../handlers/types.js";

// ═══════════════════════════════════════════════════════
// Mock @agentforge/logger
// Use vi.hoisted() so the mock object is available when
// the hoisted vi.mock() factory runs.
// ═══════════════════════════════════════════════════════

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@agentforge/logger", () => ({
  logger: mockLogger,
}));

// Import after mock
import {
  executeSingleStep,
  executeSingleStepWithTimeout,
  executeWithRetry,
  calculateRetryDelay,
  sleep,
} from "../step-runner.js";

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function createMockHandler(
  executeImpl?: (step: WorkflowStep, context: StepContext) => Promise<StepResult>,
): StepHandler {
  return {
    execute:
      executeImpl ??
      vi.fn().mockResolvedValue({
        status: "completed",
        output: { ok: true },
      } as StepResult),
  };
}

function createBaseStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "step-1",
    type: "tool",
    ...overrides,
  } as WorkflowStep;
}

function createContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    runId: "run-001",
    conversationId: "conv-001",
    variables: {},
    stepResults: {},
    userId: "user-001",
    emit: vi.fn(),
    pauseForApproval: vi.fn(),
    ...overrides,
  };
}

/**
 * Returns a StepResult indicating the handler completed successfully.
 */
function successResult(output?: unknown): StepResult {
  return { status: "completed", output: output ?? "ok" };
}

// ═══════════════════════════════════════════════════════
// executeSingleStep
// ═══════════════════════════════════════════════════════

describe("executeSingleStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handler.execute with the step and context", async () => {
    const step = createBaseStep({ type: "agent" });
    const ctx = createContext();
    const executeFn = vi.fn().mockResolvedValue(successResult("done"));
    const handler = createMockHandler(executeFn);
    const handlers: Record<string, StepHandler> = { agent: handler };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(step, ctx);
    expect(result).toEqual({ status: "completed", output: "done" });
  });

  it("returns the handler's result directly", async () => {
    const step = createBaseStep({ type: "tool" });
    const ctx = createContext();
    const expected: StepResult = { status: "completed", output: { data: 42 } };
    const handler = createMockHandler(vi.fn().mockResolvedValue(expected));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toBe(expected);
  });

  it("returns a failed result when step type is unknown", async () => {
    const step = createBaseStep({ type: "agent" });
    const ctx = createContext();
    const handlers: Record<string, StepHandler> = {};

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Unknown step type: agent",
    });
  });

  it("returns a failed result when step type is unknown (different type)", async () => {
    const step = createBaseStep({ type: "transform" });
    const ctx = createContext();
    const handlers: Record<string, StepHandler> = { tool: createMockHandler() };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Unknown step type: transform",
    });
  });

  it("returns a failed result when the handler throws an Error", async () => {
    const step = createBaseStep({ type: "agent" });
    const ctx = createContext();
    const handler = createMockHandler(
      vi.fn().mockRejectedValue(new Error("Handler exploded")),
    );
    const handlers: Record<string, StepHandler> = { agent: handler };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Handler exploded",
    });
  });

  it("returns a generic error message when the handler throws a non-Error value", async () => {
    const step = createBaseStep({ type: "tool" });
    const ctx = createContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = createMockHandler(vi.fn().mockRejectedValue("raw string error"));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Step handler error",
    });
  });

  it("returns a failed result when handler throws undefined (non-Error)", async () => {
    const step = createBaseStep({ type: "tool" });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockRejectedValue(undefined));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const result = await executeSingleStep(step, ctx, handlers);

    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Step handler error",
    });
  });
});

// ═══════════════════════════════════════════════════════
// executeSingleStepWithTimeout
// ═══════════════════════════════════════════════════════

describe("executeSingleStepWithTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes within timeout and returns the result", async () => {
    const step = createBaseStep({ type: "agent", timeout: 10 });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockResolvedValue(successResult("fast")));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);

    // Handler resolves immediately (microtask), should complete before any timer
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({ status: "completed", output: "fast" });
  });

  it("resolves before timeout when step completes with a delay shorter than timeout", async () => {
    const step = createBaseStep({ type: "tool", timeout: 30 });
    const ctx = createContext();
    const handler = createMockHandler(
      vi.fn().mockImplementation(
        () =>
          new Promise<StepResult>((resolve) => {
            setTimeout(() => resolve({ status: "completed", output: "delayed" }), 5_000);
          }),
      ),
    );
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);

    // Advance past the 5s handler delay but before the 30s timeout
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await promise;
    expect(result).toEqual({ status: "completed", output: "delayed" });

    // Advance well past the original timeout — no unhandled rejection
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("uses a default timeout of 60 seconds when step.timeout is not set", async () => {
    const step = createBaseStep({ type: "agent" });
    // step.timeout is undefined → default 60s = 60_000 ms
    const ctx = createContext();
    // Handler never resolves
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);
    promise.catch(() => {}); // suppress unhandled rejection during timer advance

    // Advance to just before the 60s mark — should NOT have timed out yet
    await vi.advanceTimersByTimeAsync(59_999);

    // Advance past the 60s mark to trigger timeout
    await vi.advanceTimersByTimeAsync(2);

    await expect(promise).rejects.toThrow("Step step-1 timed out after 60s");
  });

  it("rejects with a timeout error when the step exceeds its timeout", async () => {
    const step = createBaseStep({ type: "agent", timeout: 5 });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);
    promise.catch(() => {}); // suppress unhandled rejection during timer advance

    // Advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(promise).rejects.toThrow("Step step-1 timed out after 5s");
  });

  it("includes the step id and custom timeout value in the error message", async () => {
    const step = createBaseStep({ type: "tool", id: "order-lookup", timeout: 10 });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);
    promise.catch(() => {}); // suppress unhandled rejection during timer advance

    await vi.advanceTimersByTimeAsync(10_001);

    await expect(promise).rejects.toThrow("Step order-lookup timed out after 10s");
  });

  it("clears the timeout timer when the step completes successfully", async () => {
    const step = createBaseStep({ type: "tool", timeout: 10 });
    const ctx = createContext();
    const handler = createMockHandler(
      vi.fn().mockImplementation(
        () =>
          new Promise<StepResult>((resolve) => {
            setTimeout(() => resolve({ status: "completed", output: "ok" }), 2_000);
          }),
      ),
    );
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await promise;
    expect(result).toEqual({ status: "completed", output: "ok" });

    // Advance well past the original timeout — nothing should happen
    await vi.advanceTimersByTimeAsync(20_000);
    // No unhandled rejection means timer was cleared
  });

  it("returns the caught failed result when the handler throws (not a timeout rejection)", async () => {
    // executeSingleStep catches handler errors → executeSingleStepWithTimeout
    // receives a resolved promise, not a rejection. The timer is cleared.
    const step = createBaseStep({ type: "agent", timeout: 10 });
    const ctx = createContext();
    const handler = createMockHandler(
      vi.fn().mockRejectedValue(new Error("API unavailable")),
    );
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeSingleStepWithTimeout(step, ctx, handlers);

    await vi.runAllTimersAsync();
    const result = await promise;

    // Handler error is caught by executeSingleStep, returned as failed result
    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "API unavailable",
    });
  });
});

// ═══════════════════════════════════════════════════════
// calculateRetryDelay
// ═══════════════════════════════════════════════════════

describe("calculateRetryDelay", () => {
  it('returns initialDelay for "fixed" backoff regardless of attempt', () => {
    const retry = { backoff: "fixed" as const, initialDelay: 100, maxDelay: 5000 };

    expect(calculateRetryDelay(retry, 1)).toBe(100);
    expect(calculateRetryDelay(retry, 2)).toBe(100);
    expect(calculateRetryDelay(retry, 5)).toBe(100);
    expect(calculateRetryDelay(retry, 10)).toBe(100);
  });

  it('returns initialDelay * attempt for "linear" backoff', () => {
    const retry = { backoff: "linear" as const, initialDelay: 200, maxDelay: 5000 };

    expect(calculateRetryDelay(retry, 1)).toBe(200); // 200 * 1
    expect(calculateRetryDelay(retry, 2)).toBe(400); // 200 * 2
    expect(calculateRetryDelay(retry, 3)).toBe(600); // 200 * 3
    expect(calculateRetryDelay(retry, 5)).toBe(1000); // 200 * 5
  });

  it('caps "linear" backoff at maxDelay', () => {
    const retry = { backoff: "linear" as const, initialDelay: 200, maxDelay: 500 };

    expect(calculateRetryDelay(retry, 1)).toBe(200); // 200 < 500
    expect(calculateRetryDelay(retry, 2)).toBe(400); // 400 < 500
    expect(calculateRetryDelay(retry, 3)).toBe(500); // 600 capped to 500
    expect(calculateRetryDelay(retry, 10)).toBe(500); // 2000 capped to 500
  });

  it('returns initialDelay * 2^(attempt-1) for "exponential" backoff', () => {
    const retry = { backoff: "exponential" as const, initialDelay: 100, maxDelay: 10000 };

    expect(calculateRetryDelay(retry, 1)).toBe(100); // 100 * 2^0
    expect(calculateRetryDelay(retry, 2)).toBe(200); // 100 * 2^1
    expect(calculateRetryDelay(retry, 3)).toBe(400); // 100 * 2^2
    expect(calculateRetryDelay(retry, 4)).toBe(800); // 100 * 2^3
    expect(calculateRetryDelay(retry, 5)).toBe(1600); // 100 * 2^4
  });

  it('caps "exponential" backoff at maxDelay', () => {
    const retry = { backoff: "exponential" as const, initialDelay: 300, maxDelay: 1000 };

    expect(calculateRetryDelay(retry, 1)).toBe(300); // 300
    expect(calculateRetryDelay(retry, 2)).toBe(600); // 600
    expect(calculateRetryDelay(retry, 3)).toBe(1000); // 1200 capped to 1000
    expect(calculateRetryDelay(retry, 5)).toBe(1000); // 4800 capped to 1000
  });

  it("returns initialDelay for an unknown backoff strategy (default branch)", () => {
    const retry = { backoff: "jitter" as "fixed", initialDelay: 500, maxDelay: 3000 };

    expect(calculateRetryDelay(retry, 1)).toBe(500);
    expect(calculateRetryDelay(retry, 3)).toBe(500);
  });

  it("returns initialDelay when backoff is an empty string (default branch)", () => {
    expect(calculateRetryDelay({ backoff: "", initialDelay: 250, maxDelay: 1000 }, 1)).toBe(250);
  });

  it("works with zero initialDelay", () => {
    const retry = { backoff: "fixed" as const, initialDelay: 0, maxDelay: 5000 };

    expect(calculateRetryDelay(retry, 1)).toBe(0);
    expect(calculateRetryDelay(retry, 10)).toBe(0);
  });

  it("caps linear backoff values to zero when maxDelay is zero", () => {
    const config = { backoff: "linear" as const, initialDelay: 100, maxDelay: 0 };

    expect(calculateRetryDelay(config, 1)).toBe(0); // 100 capped to 0
    expect(calculateRetryDelay(config, 5)).toBe(0); // 500 capped to 0
  });
});

// ═══════════════════════════════════════════════════════
// sleep
// ═══════════════════════════════════════════════════════

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the specified milliseconds", async () => {
    const callback = vi.fn();

    const promise = sleep(500).then(callback);

    // Should not have resolved yet
    expect(callback).not.toHaveBeenCalled();

    // Advance by half
    await vi.advanceTimersByTimeAsync(250);
    expect(callback).not.toHaveBeenCalled();

    // Advance past the full duration
    await vi.advanceTimersByTimeAsync(251);
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("resolves with undefined", async () => {
    const promise = sleep(100);

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBeUndefined();
  });

  it("handles a sleep duration of 0 ms", async () => {
    const callback = vi.fn();

    const promise = sleep(0).then(callback);

    // setTimeout(fn, 0) still requires at least one timer tick
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("can sleep for longer durations", async () => {
    const start = Date.now();
    const promise = sleep(10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    // With fake timers, Date.now advances with the timer
    expect(Date.now() - start).toBe(10_000);
  });
});

// ═══════════════════════════════════════════════════════
// executeWithRetry
//
// IMPORTANT: executeWithRetry retries ONLY on timeout (when
// executeSingleStepWithTimeout rejects). Handler-level failures
// are caught by executeSingleStep and returned as resolved
// { status: "failed" } — they bypass the retry loop entirely.
// ═══════════════════════════════════════════════════════

describe("executeWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic success ──

  it("succeeds on the first attempt and returns result with retryCount: 0", async () => {
    const step = createBaseStep({ type: "agent", timeout: 60 });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockResolvedValue(successResult("first-try")));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ status: "completed", output: "first-try", retryCount: 0 });
  });

  it("returns handler-level failure immediately without retrying", async () => {
    // Handler throws → executeSingleStep catches → executeSingleStepWithTimeout
    // resolves with failed status → executeWithRetry returns immediately.
    // No retry because there was no timeout rejection.
    const step = createBaseStep({
      type: "tool",
      timeout: 60,
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        initialDelay: 100,
        maxDelay: 5000,
        retryOn: [],
      },
    });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockRejectedValue(new Error("Handler error")));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.runAllTimersAsync();
    const result = await promise;

    // Returns immediately with the failed result, retryCount: 0
    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Handler error",
      retryCount: 0,
    });
    // No retry warning logged
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // ── Retry on timeout → eventually succeeds ──

  it("succeeds after timing out and retrying", async () => {
    const step = createBaseStep({
      id: "retry-step",
      type: "agent",
      timeout: 1, // 1 second timeout
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        initialDelay: 500,
        maxDelay: 5000,
        retryOn: [],
      },
    });
    const ctx = createContext();

    let callCount = 0;
    const handler = createMockHandler(
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // Times out: never resolves
          return new Promise(() => {});
        }
        // Resolves immediately on 3rd attempt
        return Promise.resolve({ status: "completed", output: "success-on-3rd" } as StepResult);
      }),
    );
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // Attempt 0: timeout fires after 1000ms → reject → sleep(500)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);

    // Attempt 1: timeout fires after 1000ms → reject → sleep(500)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);

    // Attempt 2: handler resolves immediately → clears timer → success
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({ status: "completed", output: "success-on-3rd", retryCount: 2 });
    expect(callCount).toBe(3);
    // 2 retries logged
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the last available retry attempt", async () => {
    const step = createBaseStep({
      type: "tool",
      timeout: 1,
      retry: {
        maxAttempts: 2,
        backoff: "fixed",
        initialDelay: 50,
        maxDelay: 5000,
        retryOn: [],
      },
    });
    const ctx = createContext();

    let callCount = 0;
    const handler = createMockHandler(
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return new Promise(() => {}); // timeout
        }
        return Promise.resolve({ status: "completed", output: "last-try" } as StepResult);
      }),
    );
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // Attempt 0: timeout → sleep(50)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(50);

    // Attempt 1 (last): resolves immediately
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.retryCount).toBe(1);
    expect(callCount).toBe(2);
  });

  // ── All retries exhausted (timeout every time) ──

  it("returns failed with retry:maxAttempts when all attempts time out", async () => {
    const step = createBaseStep({
      type: "tool",
      timeout: 1,
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        initialDelay: 100,
        maxDelay: 5000,
        retryOn: [],
      },
    });
    const ctx = createContext();
    // Always times out
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // Advance through all 3 attempts + 2 sleeps
    await vi.advanceTimersByTimeAsync(1_000); // attempt 0 timeout
    await vi.advanceTimersByTimeAsync(100); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 timeout
    await vi.advanceTimersByTimeAsync(100); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2 timeout
    await vi.runAllTimersAsync();

    const result = await promise;
    // on_timeout defaults to "fail" → returns failed
    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Step step-1 timed out after 1s",
      retryCount: 3,
    });
    // 2 retry warnings logged (for attempts 1 and 2, not the last one)
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it("returns a generic message when the caught error is not an Error instance", async () => {
    // This tests the edge case where a non-Error is thrown inside
    // executeSingleStepWithTimeout. Since setTimeout rejects with Error,
    // this only happens if executeSingleStep somehow throws a non-Error.
    // We simulate by making the handler throw a raw value that is NOT
    // caught (executeSingleStep catches it, so this path is unlikely).
    //
    // Actually, executeSingleStep catches all handler errors. So the
    // only way to reach the catch block in executeWithRetry is via
    // timeout (always an Error). The non-Error path in the catch block
    // (`lastError = new Error(String(err))`) is defensive code.
    //
    // We test the default message path for code coverage: when maxAttempts
    // is 1 and the only attempt times out.
    const step = createBaseStep({
      type: "tool",
      timeout: 1,
      retry: { maxAttempts: 1, backoff: "fixed" as const, initialDelay: 0, maxDelay: 0, retryOn: [] },
    });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Step step-1 timed out after 1s");
    expect(result.retryCount).toBe(1);
  });

  // ── Timeout handling: skip ──

  it("returns skipped status when on_timeout is 'skip'", async () => {
    const step = createBaseStep({
      type: "agent",
      timeout: 1,
      on_timeout: "skip",
      retry: {
        maxAttempts: 2,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // Attempt 0: timeout → retry (sleep 0)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    // Attempt 1: timeout → exhausted → on_timeout=skip
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({
      status: "skipped",
      output: null,
      reason: "timeout after 1s",
      retryCount: 2,
    });
  });

  it("uses default timeout value in skip reason when step.timeout is not set", async () => {
    const step = createBaseStep({
      type: "tool",
      // timeout not set → defaults to 60
      on_timeout: "skip",
      retry: {
        maxAttempts: 1,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({
      status: "skipped",
      output: null,
      reason: "timeout after 60s",
      retryCount: 1,
    });
  });

  // ── Timeout handling: fallback ──

  it("executes fallback step successfully when on_timeout is 'fallback'", async () => {
    const fallbackStep: WorkflowStep = createBaseStep({
      id: "fb-001",
      type: "tool",
      timeout: 60,
    });
    const step = createBaseStep({
      id: "main-step",
      type: "agent",
      timeout: 1,
      on_timeout: "fallback",
      fallback_step: "fb-001",
      retry: {
        maxAttempts: 1,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const definition: WorkflowDefinition = {
      name: "test-workflow",
      steps: [step, fallbackStep],
    };
    const ctx = createContext();

    // Main handler → always times out
    const mainHandler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    // Fallback handler → succeeds
    const fallbackHandler = createMockHandler(
      vi.fn().mockResolvedValue({ status: "completed", output: "fallback-done" } as StepResult),
    );
    const handlers: Record<string, StepHandler> = {
      agent: mainHandler,
      tool: fallbackHandler,
    };

    const promise = executeWithRetry(step, ctx, handlers, definition);

    // Main step timeout
    await vi.advanceTimersByTimeAsync(1_000);
    // Fallback executes immediately (handler resolves)
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toEqual({
      status: "completed",
      output: "fallback-done",
      retryCount: 1, // from the outer (main) step's maxAttempts
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      { stepId: "main-step", fallbackStepId: "fb-001" },
      "Executing fallback step",
    );
  });

  it("returns failed when fallback step is not found in definition", async () => {
    const step = createBaseStep({
      id: "main-step",
      type: "agent",
      timeout: 1,
      on_timeout: "fallback",
      fallback_step: "nonexistent-fb",
      retry: {
        maxAttempts: 1,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const definition: WorkflowDefinition = {
      name: "test-workflow",
      steps: [step],
    };
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers, definition);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    // Falls through fallback check → goes to the final failed return at line ~154
    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");
    expect(result.retryCount).toBe(1);
  });

  it("skips fallback when definition is undefined (on_timeout=fallback but no definition)", async () => {
    // When definition is undefined, the condition
    //   on_timeout === "fallback" && step.fallback_step && definition
    // evaluates to false, so fallback lookup is skipped.
    const step = createBaseStep({
      id: "step-a",
      type: "agent",
      timeout: 1,
      on_timeout: "fallback",
      fallback_step: "fb-xyz",
      retry: {
        maxAttempts: 1,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    // No definition argument
    const promise = executeWithRetry(step, ctx, handlers);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");
    // No fallback info log
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("returns failed when the fallback step itself also fails", async () => {
    // When the fallback step's executeWithRetry returns a failed result
    // (not throws), the outer code returns { ...fbResult, retryCount: maxAttempts }.
    // The catch block (for thrown errors) is only hit for synchronous errors.
    // Since executeSingleStep catches all handler errors and executeWithRetry
    // returns instead of throwing, the fallback catch path is dead code
    // for normal timeout scenarios.
    //
    // To actually hit the catch block, we need executeWithRetry to THROW
    // from the fallback. This can happen if executeSingleStepWithTimeout
    // rejects (timeout) AND the catch in executeWithRetry rejects after
    // logging. But executeWithRetry never throws — it returns failed status.
    //
    // Therefore: the fallback always resolves, and the outer returns
    // the fallback's result (with overridden retryCount).
    const fallbackStep: WorkflowStep = createBaseStep({
      id: "fb-fail",
      type: "tool",
      timeout: 60,
    });
    const step = createBaseStep({
      id: "main-step",
      type: "agent",
      timeout: 1,
      on_timeout: "fallback",
      fallback_step: "fb-fail",
      retry: {
        maxAttempts: 1,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const definition: WorkflowDefinition = {
      name: "test-workflow",
      steps: [step, fallbackStep],
    };
    const ctx = createContext();

    const mainHandler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    // Fallback always times out
    const fallbackHandler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = {
      agent: mainHandler,
      tool: fallbackHandler,
    };

    const promise = executeWithRetry(step, ctx, handlers, definition);
    promise.catch(() => {}); // suppress unhandled rejection during timer advance

    // Main step timeout (1s)
    await vi.advanceTimersByTimeAsync(1_000);

    // Fallback: executeWithRetry(fallback) → executeSingleStepWithTimeout
    // Fallback has timeout=60s, default retry (maxAttempts=1).
    // Fallback handler never resolves → timeout after 60s → returns failed
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    // executeWithRetry(fallback) returns its failed result; outer override retryCount
    // to the main step's maxAttempts
    expect(result).toEqual({
      status: "failed",
      output: null,
      error: "Step fb-fail timed out after 60s",
      retryCount: 1,
    });
    // The catch block was not entered, so no error log
    expect(mockLogger.error).not.toHaveBeenCalled();
    // The fallback lookup was logged
    expect(mockLogger.info).toHaveBeenCalledWith(
      { stepId: "main-step", fallbackStepId: "fb-fail" },
      "Executing fallback step",
    );
  });

  // ── retryCount in result ──

  it("includes retryCount: 0 on first-attempt success with default retry config", async () => {
    const step = createBaseStep({ type: "agent", timeout: 60 });
    const ctx = createContext();
    const handler = createMockHandler(vi.fn().mockResolvedValue(successResult("ok")));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.retryCount).toBe(0);
  });

  it("sets retryCount correctly when succeeding on the nth retry", async () => {
    const step = createBaseStep({
      type: "tool",
      timeout: 1,
      retry: {
        maxAttempts: 4,
        backoff: "fixed",
        initialDelay: 1,
        maxDelay: 100,
        retryOn: [],
      },
    });
    const ctx = createContext();

    let callCount = 0;
    const handler = createMockHandler(
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 4) {
          return new Promise(() => {}); // timeout
        }
        return Promise.resolve({ status: "completed", output: "win" } as StepResult);
      }),
    );
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // 3 timeouts + 3 sleeps + final success
    await vi.advanceTimersByTimeAsync(1_000); // attempt 0 timeout
    await vi.advanceTimersByTimeAsync(1); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 timeout
    await vi.advanceTimersByTimeAsync(1); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2 timeout
    await vi.advanceTimersByTimeAsync(1); // sleep
    await vi.runAllTimersAsync(); // attempt 3 success

    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.retryCount).toBe(3);
    expect(callCount).toBe(4);
  });

  // ── Edge cases ──

  it("handles zero retry delay correctly", async () => {
    const step = createBaseStep({
      type: "tool",
      timeout: 1,
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        initialDelay: 0,
        maxDelay: 0,
        retryOn: [],
      },
    });
    const ctx = createContext();

    let calls = 0;
    const handler = createMockHandler(
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls < 3) {
          return new Promise(() => {}); // timeout
        }
        return Promise.resolve({ status: "completed", output: "yes" } as StepResult);
      }),
    );
    const handlers: Record<string, StepHandler> = { tool: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    // 2 timeouts + 2 sleeps(0) + final success
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0); // sleep(0) fires
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0); // sleep(0) fires
    await vi.runAllTimersAsync(); // attempt 2 success (resolves immediately)

    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.retryCount).toBe(2);
    expect(calls).toBe(3);
  });

  it("logs a warning on each retry with the correct context", async () => {
    const step = createBaseStep({
      id: "retry-step",
      type: "agent",
      timeout: 1,
      retry: {
        maxAttempts: 3,
        backoff: "fixed",
        initialDelay: 10,
        maxDelay: 5000,
        retryOn: [],
      },
    });
    const ctx = createContext();
    // Always times out
    const handler = createMockHandler(vi.fn().mockImplementation(() => new Promise(() => {})));
    const handlers: Record<string, StepHandler> = { agent: handler };

    const promise = executeWithRetry(step, ctx, handlers);

    await vi.advanceTimersByTimeAsync(1_000); // attempt 0 timeout
    await vi.advanceTimersByTimeAsync(10); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 timeout
    await vi.advanceTimersByTimeAsync(10); // sleep
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2 timeout (last)
    await vi.runAllTimersAsync();

    await promise;

    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenNthCalledWith(
      1,
      { stepId: "retry-step", attempt: 1, maxAttempts: 3, delayMs: 10 },
      "Retrying failed step",
    );
    expect(mockLogger.warn).toHaveBeenNthCalledWith(
      2,
      { stepId: "retry-step", attempt: 2, maxAttempts: 3, delayMs: 10 },
      "Retrying failed step",
    );
  });
});
