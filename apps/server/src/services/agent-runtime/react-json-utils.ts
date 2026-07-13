// ReAct JSON 检测与清理工具函数
// 独立模块，避免 agent-executor ↔ agent 之间的循环依赖

/**
 * 检测文本是否为 ReAct Agent 内部 JSON（统一启发式规则）。
 * 要求同时出现 observation + analysis + plan 三个键，避免误判。
 */
export function looksLikeReActJSON(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("{") &&
    /"observation"\s*:/.test(trimmed) &&
    /"analysis"\s*:/.test(trimmed) &&
    /"plan"\s*:/.test(trimmed) &&
    /"decision"\s*:/.test(trimmed) // 五键检测：decision 是 ReAct 独有特征，避免误判正常 JSON
  );
}

/**
 * 检测并清理 ReAct Agent 内部 JSON 输出（防止泄漏到用户界面）。
 *
 * 优先级（与 tryExtractRespondContent 统一）：
 *   decision.content → decision.question → parsed.content →
 *   parsed.summary → plan → observation
 *
 * @returns 提取的自然语言文本，或原始文本（非 ReAct JSON），或 null（ReAct JSON 无法提取）
 */
export function sanitizeReActJSON(text: string): string | null {
  const trimmed = text.trim();

  if (!looksLikeReActJSON(trimmed)) return text;

  try {
    const parsed = JSON.parse(trimmed);
    const decision = parsed.decision;

    // 优先：decision 中的 content 字段（LLM 尝试回答）
    if (typeof decision === "object" && decision?.content) {
      return String(decision.content);
    }

    // decision.question — LLM 需要向用户提问澄清
    if (typeof decision === "object" && decision?.question && typeof decision.question === "string" && decision.question.trim()) {
      return decision.question.trim();
    }

    // decision 是动作（如 search_knowledge_base）但没有 content → 无法直接展示
    if (typeof decision === "string") {
      return null;
    }

    // 次选：顶层的 content / summary 字段（与 tryExtractRespondContent 统一优先级）
    if (parsed.content && typeof parsed.content === "string") {
      return parsed.content;
    }
    if (parsed.summary && typeof parsed.summary === "string") {
      return parsed.summary;
    }

    // 再次：plan 或 observation 可能包含可读信息（优先级与 tryExtractRespondContent 一致）
    if (typeof parsed.plan === "string" && parsed.plan.trim()) {
      return parsed.plan.trim();
    }
    if (typeof parsed.observation === "string" && parsed.observation.trim()) {
      return parsed.observation.trim();
    }

    return null;
  } catch {
    // Expected: ReAct JSON extraction is best-effort — returns null for non-JSON content
    return null;
  }
}
