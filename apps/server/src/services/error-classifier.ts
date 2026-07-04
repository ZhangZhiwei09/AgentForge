// 错误分类器 —— 将 Agent 运行中的错误分为三类：
//   retryable  — 可重试（网络/超时/限流等瞬态错误）
//   fatal      — 不可恢复（鉴权/校验/配置错误）
//   degradable — 可降级（工具失败但可换方案继续）
//
// 被 AgentService 和 retry-executor 使用，决定重试策略和降级路径。

export type ErrorCategory = "retryable" | "fatal" | "degradable";

export interface ClassifiedError {
  category: ErrorCategory;
  source: "llm" | "tool" | "internal";
  originalError: Error;
  message: string;
  recoverable: boolean;
  retryableReason?: string;
  degradedTool?: string;
}

// ---- 分类规则 ----

/**
 * 对错误进行分类，返回 ClassifiedError。
 *
 * @param err 原始错误对象
 * @param source 错误来源：llm 调用、工具执行、内部逻辑
 * @param toolName 如果是工具错误，提供工具名称用于降级建议
 */
export function classifyError(
  err: Error,
  source: "llm" | "tool" | "internal" = "internal",
  toolName?: string,
): ClassifiedError {
  const msg = err.message || String(err);

  // 1. 网络/超时/限流类 —— retryable
  if (isRetryable(msg)) {
    return {
      category: "retryable",
      source,
      originalError: err,
      message: msg,
      recoverable: true,
      retryableReason: detectRetryableReason(msg),
    };
  }

  // 2. 鉴权/配置/校验类 —— fatal
  if (isFatal(msg)) {
    return {
      category: "fatal",
      source,
      originalError: err,
      message: msg,
      recoverable: false,
    };
  }

  // 3. 工具/模型不可用类 —— degradable
  if (isDegradable(msg, source, toolName)) {
    return {
      category: "degradable",
      source,
      originalError: err,
      message: msg,
      recoverable: true,
      degradedTool: toolName,
    };
  }

  // 4. 默认：内部错误降级处理（宽松策略，避免因未分类错误直接失败）
  return {
    category: "degradable",
    source,
    originalError: err,
    message: msg,
    recoverable: true,
  };
}

// ---- 内部分类函数 ----

function isRetryable(msg: string): boolean {
  const patterns = [
    // 网络错误
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /network error/i,
    /fetch failed/i,
    /socket hang up/i,
    // HTTP 状态码
    /\b429\b/, // Too Many Requests
    /\b502\b/, // Bad Gateway
    /\b503\b/, // Service Unavailable
    /\b504\b/, // Gateway Timeout
    // 限流
    /rate limit/i,
    /too many requests/i,
    /quota exceeded/i,
    /please retry/i,
    // 超时
    /timed?[_\s]?out/i,
    /abort/i,
    /cancelled/i,
    // 连接池
    /connection pool/i,
    /no connection available/i,
  ];
  return patterns.some((p) => p.test(msg));
}

function isFatal(msg: string): boolean {
  const patterns = [
    // 鉴权
    /\b401\b/,
    /\b403\b/,
    /unauthorized/i,
    /invalid api key/i,
    /incorrect api key/i,
    /authentication failed/i,
    /not authorized/i,
    // 余额/配额耗尽
    /\b402\b/,
    /insufficient_quota/i,
    /billing/i,
    /payment required/i,
    /exceeded your current quota/i,
    /account balance/i,
    // 模型/配置
    /model not found/i,
    /model does not exist/i,
    /invalid model/i,
    /tool not found/i,
    /unknown tool/i,
    /not registered/i,
    // 输入校验
    /validation failed/i,
    /invalid parameter/i,
    /context length exceeded/i,
    /maximum context/i,
    // 内部致命错误
    /conversation not found/i,
  ];
  return patterns.some((p) => p.test(msg));
}

function isDegradable(msg: string, source: string, toolName?: string): boolean {
  // 工具执行错误（非网络）→ 可降级
  if (source === "tool" && toolName) return true;

  const patterns = [
    // 熔断器
    /circuit breaker/i,
    /temporarily disabled/i,
    // 模型降级
    /model overloaded/i,
    /model not available/i,
    /provider error/i,
    /collection not loaded/i,
    // 通用服务不可用
    /service unavailable/i,
    /temporarily unavailable/i,
  ];
  return patterns.some((p) => p.test(msg));
}

function detectRetryableReason(msg: string): string {
  if (/rate limit|too many requests|429/i.test(msg)) return "rate_limit";
  if (/timed?[_\s]?out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(
      msg,
    )
  )
    return "network";
  if (/50[23]/i.test(msg)) return "server_error";
  if (/quota exceeded/i.test(msg)) return "quota";
  return "unknown_retryable";
}

/**
 * 判断 ClassifiedError 是否可以自动重试。
 */
export function isRetryableError(err: ClassifiedError): boolean {
  return err.category === "retryable";
}

/**
 * 判断 ClassifiedError 是否需要降级处理。
 */
export function isDegradableError(err: ClassifiedError): boolean {
  return err.category === "degradable";
}

/**
 * 判断 ClassifiedError 是否致命（不可恢复）。
 */
export function isFatalError(err: ClassifiedError): boolean {
  return err.category === "fatal";
}
