// 熔断器（Circuit Breaker）—— 保护外部依赖调用
// 状态机：CLOSED → OPEN → HALF_OPEN → CLOSED
// 连续失败达阈值时断开，后续调用快速失败（不等待超时），冷却后探测恢复
import { circuitBreakerState } from "../observability/metrics.js";
import { logger } from "@agentforge/logger";

export class CircuitBreakerOpenError extends Error {
  constructor(breakerName: string) {
    super(`Circuit breaker '${breakerName}' is OPEN — fast-failing without external call`);
    this.name = "CircuitBreakerOpenError";
  }
}

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private name: string,
    private failureThreshold: number = 5,
    private resetTimeoutMs: number = 30_000,
  ) {}

  /** 执行受保护的外部调用。circuit OPEN 时直接抛 CircuitBreakerOpenError。 */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.transitionTo("HALF_OPEN");
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private onSuccess(): void {
    if (this.state !== "CLOSED") {
      logger.info(
        { breaker: this.name, previousState: this.state },
        "Circuit breaker recovered → CLOSED",
      );
    }
    this.state = "CLOSED";
    this.failureCount = 0;
    circuitBreakerState.set({ tool_name: this.name }, 0);
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (
      this.state === "HALF_OPEN" ||
      this.failureCount >= this.failureThreshold
    ) {
      this.transitionTo("OPEN");
    }
  }

  private transitionTo(newState: BreakerState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === "OPEN") {
      circuitBreakerState.set({ tool_name: this.name }, 1);
      logger.warn(
        {
          breaker: this.name,
          failures: this.failureCount,
          resetTimeoutMs: this.resetTimeoutMs,
        },
        `Circuit breaker transitioned ${oldState} → OPEN`,
      );
    } else if (newState === "HALF_OPEN") {
      logger.info(
        { breaker: this.name },
        `Circuit breaker transitioned ${oldState} → HALF_OPEN (probing)`,
      );
    }
  }

  /** 记录一次外部调用失败（用于无法通过 call() 包装的流式调用） */
  recordFailure(): void {
    this.onFailure();
  }

  /** 手动重置（用于测试和管理 API） */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.lastFailureTime = 0;
    circuitBreakerState.set({ tool_name: this.name }, 0);
  }

  /** 只读状态查询 */
  getState(): BreakerState {
    return this.state;
  }
}
