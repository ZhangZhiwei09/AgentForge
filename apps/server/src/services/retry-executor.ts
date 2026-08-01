// 通用重试执行器 —— 为 Agent 的 LLM 调用和工具执行提供自动重试能力
// 退避算法复用自 workflows/dag-executor.ts 的 calculateRetryDelay 逻辑
import { logger } from "@agentforge/logger";
import { classifyError } from "./error-classifier.js";
import type { ClassifiedError, ErrorCategory } from "./error-classifier.js";

// ---- Types ----

export interface RetryConfig {
  /** 最大尝试次数（含首次） */
  maxAttempts: number;
  /** 退避策略 */
  backoff: "fixed" | "linear" | "exponential";
  /** 初始延迟（毫秒） */
  initialDelay: number;
  /** 最大延迟上限（毫秒） */
  maxDelay: number;
  /** 仅对指定错误类型重试；空数组 = 全部重试 */
  retryOn: ErrorCategory[];
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  retried: boolean;
  lastError?: ClassifiedError;
}

// ---- 预设配置 ----

/** LLM 调用默认重试：最多3次，指数退避 1s→2s→4s，仅 retryable 错误 */
export const DEFAULT_LLM_RETRY: RetryConfig = {
  maxAttempts: 3,
  backoff: "exponential",
  initialDelay: 1000,
  maxDelay: 10000,
  retryOn: ["retryable"],
};

/** 工具执行默认重试：最多2次，指数退避 500ms→1s，retryable + degradable */
export const DEFAULT_TOOL_RETRY: RetryConfig = {
  maxAttempts: 2,
  backoff: "exponential",
  initialDelay: 500,
  maxDelay: 5000,
  retryOn: ["retryable", "degradable"],
};

// ---- 核心函数 ----

/**
 * 带重试执行异步函数。
 *
 * @param fn 要执行的异步函数
 * @param config 重试配置
 * @param source 错误来源标签，用于 classifyError
 * @param toolName 工具名称（可选，用于工具错误的降级信息）
 * @returns 包含结果、尝试次数、是否重试过的结果对象
 * @throws 当所有重试耗尽且最后一次错误为 fatal 时抛出
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  source: "llm" | "tool" | "internal" = "internal",
  toolName?: string,
): Promise<RetryResult<T>> {
  const maxAttempts = config.maxAttempts || 1;
  let lastError: ClassifiedError | undefined;
  let retried = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt + 1, retried, lastError };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(error, source, toolName);
      lastError = classified;

      // 最后一次尝试 → 不再重试
      if (attempt >= maxAttempts - 1) break;

      // 检查是否应该重试
      if (!shouldRetry(classified, config)) break;

      // 计算延迟并等待
      const delay = calculateRetryDelay(config, attempt + 1);
      logger.warn(
        {
          source,
          tool: toolName,
          attempt: attempt + 1,
          maxAttempts,
          delayMs: delay,
          category: classified.category,
          error: classified.message.slice(0, 200),
        },
        "重试失败的操作",
      );

      await sleep(delay);
      retried = true;
    }
  }

  // 重试用尽 —— 如果致命则抛出，否则返回 lastError 让调用方降级处理
  if (lastError?.category === "fatal") {
    throw lastError.originalError;
  }

  // 非致命 → 把错误信息封装在 result 中返回
  const errMsg = lastError
    ? `重试${maxAttempts}次后仍失败: ${lastError.message}`
    : "未知错误";
  throw new Error(errMsg);
}

// ---- 辅助函数 ----

/**
 * 判断是否应基于错误分类继续重试。
 */
function shouldRetry(
  classified: ClassifiedError,
  config: RetryConfig,
): boolean {
  // 空数组 = 不重试任何错误
  if (config.retryOn.length === 0) return false;
  return config.retryOn.includes(classified.category);
}

/**
 * 计算重试延迟。退避算法与 dag-executor.ts 一致。
 */
export function calculateRetryDelay(
  retry: Pick<RetryConfig, "backoff" | "initialDelay" | "maxDelay">,
  attempt: number,
): number {
  switch (retry.backoff) {
    case "fixed":
      return retry.initialDelay;
    case "linear":
      return Math.min(retry.initialDelay * attempt, retry.maxDelay);
    case "exponential":
      return Math.min(
        retry.initialDelay * Math.pow(2, attempt - 1),
        retry.maxDelay,
      );
    default:
      return retry.initialDelay;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
