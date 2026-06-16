// ExecutionResult — 统一执行结果协议
//
// 设计要点：
// - 五态区分 success / partial / failed / cancelled / timeout
// - 所有执行单元（Tool、Agent、Workflow、MCP）返回同一种类型
// - executionResultToContent() 将结构化结果转为 LLM 可读的字符串
// - 替换原有的 "Error:" / "[工具执行失败]" 字符串前缀约定

// ═══════════════════════════════════════════════════════
// ExecutionState — 运行时状态
// ═══════════════════════════════════════════════════════

export enum ExecutionState {
  CREATED = "created",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  TIMEOUT = "timeout",
}

/** 终端态集合 */
export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.COMPLETED,
  ExecutionState.FAILED,
  ExecutionState.CANCELLED,
  ExecutionState.TIMEOUT,
]);

// ═══════════════════════════════════════════════════════
// ExecutionErrorCode — 标准化错误码
// ═══════════════════════════════════════════════════════

export enum ExecutionErrorCode {
  NOT_FOUND = "NOT_FOUND",
  ACCESS_DENIED = "ACCESS_DENIED",
  INVALID_PARAM = "INVALID_PARAM",
  EXECUTION_ERROR = "EXECUTION_ERROR",
  TIMEOUT = "TIMEOUT",
  CIRCUIT_OPEN = "CIRCUIT_OPEN",
  RATE_LIMIT = "RATE_LIMIT",
  NETWORK_ERROR = "NETWORK_ERROR",
  API_ERROR = "API_ERROR",
  CONFLICT = "CONFLICT",
  CANCELLED = "CANCELLED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

// ═══════════════════════════════════════════════════════
// ExecutionError
// ═══════════════════════════════════════════════════════

export interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  retryable: boolean;
}

// ═══════════════════════════════════════════════════════
// ExecutionResult — 五态结果
// ═══════════════════════════════════════════════════════

export type ExecutionResult =
  | {
      status: "success";
      output: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "partial";
      output: string;
      reason: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "failed";
      error: ExecutionError;
    }
  | {
      status: "cancelled";
      reason: string;
    }
  | {
      status: "timeout";
      afterMs: number;
    };

// ═══════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════

export function successResult(
  output: string,
  metadata?: Record<string, unknown>,
): ExecutionResult {
  return { status: "success", output, ...(metadata ? { metadata } : {}) };
}

export function partialResult(
  output: string,
  reason: string,
  metadata?: Record<string, unknown>,
): ExecutionResult {
  return { status: "partial", output, reason, ...(metadata ? { metadata } : {}) };
}

export function failedResult(
  code: ExecutionErrorCode,
  message: string,
  retryable = false,
): ExecutionResult {
  return { status: "failed", error: { code, message, retryable } };
}

export function cancelledResult(reason: string): ExecutionResult {
  return { status: "cancelled", reason };
}

export function timeoutResult(afterMs: number): ExecutionResult {
  return { status: "timeout", afterMs };
}

// ═══════════════════════════════════════════════════════
// 序列化：ExecutionResult → LLM Context String
// ═══════════════════════════════════════════════════════

/**
 * 将 ExecutionResult 转为注入 LLM 对话上下文的字符串。
 * 替换原有的 "Error:" / "[工具执行失败]" 字符串前缀约定。
 */
export function executionResultToContent(result: ExecutionResult): string {
  switch (result.status) {
    case "success":
      return result.output;
    case "partial":
      return `${result.output}\n\n[注意] ${result.reason}`;
    case "failed":
      return `[工具执行失败] ${result.error.message}`;
    case "cancelled":
      return `[已取消] ${result.reason}`;
    case "timeout":
      return `[超时] 执行超过 ${result.afterMs}ms`;
  }
}

/**
 * 判断 ExecutionResult 是否为降级状态。
 * 用于 degradation-chain 替代原有的字符串前缀检测。
 */
export function isDegradedResult(result: ExecutionResult): boolean {
  return result.status === "failed" || result.status === "timeout" || result.status === "cancelled";
}

/**
 * 判断 ExecutionResult 是否可重试。
 */
export function isRetryableResult(result: ExecutionResult): boolean {
  return (
    result.status === "failed" && result.error.retryable
  );
}
