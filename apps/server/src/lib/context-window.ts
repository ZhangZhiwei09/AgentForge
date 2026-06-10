// 上下文窗口管理 —— 防止对话历史超出LLM的token限制
// 使用字符数粗略估算token数（4字符 ≈ 1 token 是保守估计）
// 未来可升级为 tiktoken 精确计数

import type { ChatMessage } from "../providers/types.js";

/** 粗略估算消息列表的token数（字符数 / 3.5） */
export function estimateTokenCount(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    // tool call arguments也计入
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name?.length || 0) + (tc.function?.arguments?.length || 0);
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

/**
 * 截断历史消息以适配token预算
 * - 始终保留system消息
 * - 从最新消息向前取，直到预算耗尽
 * - 保证至少保留最新的user消息
 */
export function truncateHistory(
  messages: ChatMessage[],
  maxTokens: number,
): ChatMessage[] {
  if (messages.length === 0) return messages;

  const estimate = estimateTokenCount(messages);
  if (estimate <= maxTokens) return messages;

  // 分离system消息和其他消息
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const rest = systemMsg ? messages.slice(1) : messages;

  const systemTokens = systemMsg ? estimateTokenCount([systemMsg]) : 0;
  const budget = maxTokens - systemTokens;

  // 从后向前选取消息直到budget耗尽
  const selected: ChatMessage[] = [];
  let usedTokens = 0;

  for (let i = rest.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokenCount([rest[i]]);
    if (usedTokens + msgTokens > budget && selected.length > 0) {
      // 确保最新的user消息被保留
      const hasUserMsg = selected.some((m) => m.role === "user");
      if (hasUserMsg || rest[i].role !== "user") break;
    }
    selected.unshift(rest[i]);
    usedTokens += msgTokens;
  }

  // 确保至少有一条user消息
  const hasUser = selected.some((m) => m.role === "user");
  if (!hasUser) {
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i].role === "user") {
        selected.unshift(rest[i]);
        break;
      }
    }
  }

  return systemMsg ? [systemMsg, ...selected] : selected;
}
