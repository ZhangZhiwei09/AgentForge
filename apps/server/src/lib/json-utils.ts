// JSON工具函数 —— 从LLM响应中提取JSON对象
// 多个Service（agent、customer-chat、knowledge、memory-engine）共享

/**
 * 从LLM原始文本响应中提取JSON字符串
 * 处理常见的包装格式：Markdown代码块、前后文文字
 */
export function extractJSONFromLLMResponse(raw: string): string {
  let clean = raw.trim();

  // 去除 Markdown 代码块包裹
  if (clean.startsWith("```")) {
    const parts = clean.split("```");
    // 取第一个代码块内容（parts[1]），如果为空则取 parts[0]
    clean = parts[1] || parts[0] || "";
    if (clean.startsWith("json")) {
      clean = clean.slice(4);
    }
    clean = clean.trim();
  }

  // 查找最外层 JSON 对象
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    clean = jsonMatch[0];
  }

  return clean.trim();
}

/**
 * 从LLM原始文本响应中提取并解析JSON
 * @returns 解析后的对象，失败返回 null
 */
export function parseJSONFromLLMResponse(raw: string): unknown | null {
  try {
    const jsonStr = extractJSONFromLLMResponse(raw);
    return JSON.parse(jsonStr);
  } catch {
    // Expected: LLM responses may not contain valid JSON — caller handles null fallback
    return null;
  }
}
