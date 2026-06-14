// 降级链 —— 当工具执行失败后，构建替代方案提示并注入到 Agent 上下文
// 让 Agent 在下一轮 ReAct 迭代中看到失败原因并尝试替代工具，而非直接终止

import type { ClassifiedError } from "./error-classifier.js";

// ---- 工具替代映射 ----

/**
 * 工具名 → 推荐替代工具列表。
 * 当某个工具失败时，Agent 会被告知这些替代方案。
 */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  http_request: ["web_search", "web_fetch"],
  web_search: ["web_fetch", "http_request"],
  web_fetch: ["web_search", "http_request"],
  file_read: ["file_search"],
  file_write: ["file_read"], // 降级为只读
  db_query: [], // 无替代
  code_execute: ["calculator"], // 降级为简单计算
  calculator: [], // 无替代
  file_search: [], // 无替代
  get_current_time: [], // 无替代
};

/**
 * 根据工具名获取推荐的替代工具列表。
 */
export function getAlternativeTools(toolName: string): string[] {
  return TOOL_ALTERNATIVES[toolName] || [];
}

// ---- 降级消息构建 ----

/**
 * 构建降级消息（中文），注入到对话上下文作为工具执行结果。
 * Agent 在下一轮迭代中会看到此消息，并据此调整策略。
 *
 * @param failure 分类后的错误
 * @param toolName 失败的工具名称
 * @param attemptedRetries 已尝试的重试次数
 * @returns 中文降级提示消息
 */
export function buildDegradationMessage(
  failure: ClassifiedError,
  toolName: string,
  attemptedRetries: number = 0,
): string {
  const alternatives = getAlternativeTools(toolName);

  let message = `[工具执行失败] 工具 "${toolName}" 执行失败`;

  if (attemptedRetries > 0) {
    message += `（已重试 ${attemptedRetries} 次）`;
  }

  message += `。\n失败原因: ${failure.message}`;

  if (alternatives.length > 0) {
    const altList = alternatives.map((t) => `"${t}"`).join("、");
    message += `\n\n建议替代方案: ${altList}`;
    message += `\n请尝试使用替代工具，或调整参数后重试。如果所有替代方案都不可行，请考虑跳过此步骤或向用户说明情况。`;
  } else {
    message += `\n\n该工具无替代方案。请考虑以下选项：\n`;
    message += `1. 调整调用参数后重试该工具\n`;
    message += `2. 使用其他已有信息完成任务\n`;
    message += `3. 如果确实无法继续，请向用户说明原因`;
  }

  return message;
}

/**
 * 构建 LLM 调用失败的降级消息（中文）。
 * 用于当 LLM provider 不可用时的降级提示。
 */
export function buildLLMDegradationMessage(
  failure: ClassifiedError,
  attemptedRetries: number = 0,
): string {
  let message = `[模型调用失败] LLM 调用失败`;

  if (attemptedRetries > 0) {
    message += `（已重试 ${attemptedRetries} 次）`;
  }

  message += `。\n错误详情: ${failure.message}`;

  if (failure.retryableReason === "rate_limit") {
    message += `\n建议: 稍等片刻后重试，或切换到其他可用模型。`;
  } else if (failure.retryableReason === "timeout") {
    message += `\n建议: 简化当前任务描述，或拆分为更小的子任务。`;
  } else {
    message += `\n建议: 检查 API 密钥和网络连接，或联系管理员。`;
  }

  return message;
}

// ---- 降级结果类型 ----

export interface DegradationResult {
  /** 是否已降级处理 */
  degraded: boolean;
  /** 注入到对话的消息（Agent 在下一轮看到） */
  injectedMessage: string;
  /** 推荐的替代工具列表 */
  alternativeTools: string[];
}
