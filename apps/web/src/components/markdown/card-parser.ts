// ── 卡片标记解析器 ──
// 从 Markdown 文本中提取 ```card:type\n{json}\n``` 围栏代码块
// 返回纯净 Markdown + 结构化卡片块数组
//
// 流式增强：支持从部分 JSON 中提取字段，实现渐进式卡片渲染

import type { ContentBlock, CardFenceType } from "@agentforge/shared-types";

// 匹配 ```card:order|policy|action|status|table\n<json>\n```
// 使用 [^\S\n]* 匹配水平空白（空格/tab），避免 \s 吞掉 \n
const CARD_FENCE_REGEX =
  /```card:(order|policy|action|status|table)[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g;

const VALID_FENCE_TYPES: Set<string> = new Set([
  "order",
  "policy",
  "action",
  "status",
  "table",
]);

export interface ParsedResult {
  /** 移除卡片标记后的纯净 Markdown 文本 */
  cleanMarkdown: string;
  /** 解析出的卡片块（按在原文中的出现顺序排列） */
  blocks: Array<{
    /** 卡片在原文中的字符偏移位置 */
    index: number;
    block: ContentBlock;
  }>;
}

/** 流式卡片解析结果：部分字段 + 骨架标记 */
export interface StreamingCard {
  type: CardFenceType;
  /** 已成功解析的字段（部分数据） */
  partialData: Record<string, unknown>;
  /** JSON 是否已闭合（卡片完成） */
  isComplete: boolean;
  /** 围栏开始时在原文中的位置（用于切除 Markdown 中的原始文本） */
  fenceStartIndex: number;
  /** 围栏已占据的文本长度 */
  fenceLength: number;
}

/**
 * 从 Markdown 文本中提取所有卡片围栏代码块
 */
export function extractCardBlocks(markdown: string): ParsedResult {
  const blocks: ParsedResult["blocks"] = [];
  let cleanMarkdown = markdown;

  // 重置正则状态
  CARD_FENCE_REGEX.lastIndex = 0;
  const matches = [...markdown.matchAll(CARD_FENCE_REGEX)];

  // 从后往前替换，避免偏移量失效
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const fenceType = match[1] as CardFenceType;
    const rawJson = match[2]!;
    const block = parseFenceContent(fenceType, rawJson);

    if (block) {
      blocks.unshift({ index: match.index!, block });
    }
    // 移除卡片围栏（无论解析是否成功，都从 Markdown 中移除）
    cleanMarkdown =
      cleanMarkdown.slice(0, match.index!) +
      cleanMarkdown.slice(match.index! + match[0].length);
  }

  return {
    cleanMarkdown: cleanMarkdown.trim(),
    blocks,
  };
}

/**
 * 检查 Markdown 文本中是否存在未闭合的卡片围栏（流式过程中的半截标记）
 * 返回正在构建中的卡片类型，如果所有围栏都已闭合则返回 null
 */
export function hasUnclosedFence(markdown: string): CardFenceType | null {
  // 查找所有 ```card:type 开头
  const cardStartPattern =
    /```card:(order|policy|action|status|table)[^\S\n]*\n/g;

  const starts = [...markdown.matchAll(cardStartPattern)];
  if (starts.length === 0) return null;

  // 对每个 card 开头，检查其后是否有对应的闭合 ```
  // 简化策略：看最后一个 card 开头后面是否有 ``` 闭合它
  const lastStart = starts[starts.length - 1];
  const afterLastStart = markdown.slice(lastStart.index! + lastStart[0].length);

  // 在 card 内容之后查找闭合的 ```
  // 闭合的 ``` 应该在单独一行（前面是 \n，后面是行尾或 \n）
  // 注意：card 内容的 JSON 中可能包含 ```，但概率极低，暂不处理
  const closeAfterMatch = afterLastStart.match(/\n[^\S\n]*```/);

  // 如果没找到闭合，说明有未闭合的卡片围栏
  if (!closeAfterMatch) {
    const fenceType = lastStart[1];
    if (fenceType && VALID_FENCE_TYPES.has(fenceType)) {
      return fenceType as CardFenceType;
    }
  }

  return null;
}

/**
 * 流式解析：从正在构建中的卡片围栏中提取部分数据
 *
 * 策略：
 * 1. 找到最后一个未闭合的 ```card:type 开头
 * 2. 提取其中的 JSON 内容（可能不完整）
 * 3. 尝试修复被截断的 JSON（闭合缺失的括号/引号）
 * 4. 返回已解析的部分字段 + 卡片类型
 *
 * 如果 JSON 完全无法解析（语法错误太严重），返回 null
 */
export function tryParseStreamingCard(
  markdown: string,
): StreamingCard | null {
  const cardStartPattern =
    /```card:(order|policy|action|status|table)[^\S\n]*\n/g;

  const starts = [...markdown.matchAll(cardStartPattern)];
  if (starts.length === 0) return null;

  // 只看最后一个未闭合的 card 围栏
  const lastStart = starts[starts.length - 1];
  const fenceType = lastStart[1] as CardFenceType;

  if (!VALID_FENCE_TYPES.has(fenceType)) return null;

  const fenceStartIndex = lastStart.index!;
  const afterOpening = markdown.slice(fenceStartIndex + lastStart[0].length);

  // 检查是否已有闭合 ```
  const closeMatch = afterOpening.match(/\n[^\S\n]*```/);

  let rawJson: string;
  let isComplete = false;

  if (closeMatch) {
    // 围栏已闭合：提取完整 JSON
    rawJson = afterOpening.slice(0, closeMatch.index!).trim();
    isComplete = true;
  } else {
    // 围栏未闭合：提取到目前为止的所有内容
    rawJson = afterOpening.trim();
    isComplete = false;
  }

  if (!rawJson) {
    // 围栏刚打开，还没内容 — 返回空卡片用于显示骨架
    return {
      type: fenceType,
      partialData: {},
      isComplete: false,
      fenceStartIndex,
      fenceLength: lastStart[0].length + (closeMatch ? closeMatch.index! + closeMatch[0].length : afterOpening.length),
    };
  }

  const partialData = parsePartialJSON(rawJson);

  return {
    type: fenceType,
    partialData: partialData ?? {},
    isComplete,
    fenceStartIndex,
    fenceLength:
      lastStart[0].length +
      (closeMatch ? closeMatch.index! + closeMatch[0].length : afterOpening.length),
  };
}

/**
 * 宽松 JSON 解析：尝试修复常见的流式截断问题
 */
function parsePartialJSON(raw: string): Record<string, unknown> | null {
  // 尝试 1：直接解析（如果碰巧是完整 JSON）
  try {
    return JSON.parse(raw.trim());
  } catch {
    // 继续
  }

  // 尝试 2：修复截断 —— 补全缺失的括号和引号
  const repaired = repairTruncatedJSON(raw.trim());
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {
      // 继续
    }
  }

  // 尝试 3：只提取已完成的键值对（截断到最后一个完整值）
  const truncated = truncateToLastCompleteValue(raw.trim());
  if (truncated) {
    try {
      return JSON.parse(truncated);
    } catch {
      // 继续
    }
  }

  return null;
}

/**
 * 修复被流式截断的 JSON 字符串
 * 处理：缺失的闭合引号、括号、不完整的值
 */
function repairTruncatedJSON(raw: string): string | null {
  if (!raw) return null;

  let s = raw;

  // 如果以 { 或 [ 开头，尝试修复
  if (!s.startsWith("{") && !s.startsWith("[")) return null;

  // 统计未闭合的结构
  let inString = false;
  let braceCount = 0;
  let bracketCount = 0;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === "\\" && inString) {
      // 跳过转义字符
      i++; // skip next char
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") braceCount++;
    if (ch === "}") braceCount--;
    if (ch === "[") bracketCount++;
    if (ch === "]") bracketCount--;
  }

  // 修复策略：闭合仍在进行中的字符串，然后闭合括号

  // 1. 如果仍在字符串中，追加闭合引号
  if (inString) {
    // 检查最后一个非空白字符是否是值分隔符
    s += '"';
  }

  // 2. 如果最后一个非空白字符是 , 或 :，移除它（等待下一个值）
  const lastNonWS = s.trimEnd().slice(-1);
  if (lastNonWS === "," || lastNonWS === ":") {
    // 尝试去掉尾部逗号/冒号后补全
    const trimmed = s.trimEnd().slice(0, -1);
    // 重新计算括号
    let b2 = 0, k2 = 0;
    let inStr2 = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "\\" && inStr2) { i++; continue; }
      if (ch === '"') { inStr2 = !inStr2; continue; }
      if (inStr2) continue;
      if (ch === "{") b2++;
      if (ch === "}") b2--;
      if (ch === "[") k2++;
      if (ch === "]") k2--;
    }
    // 如果去掉尾部逗号后括号已平衡，就用它
    if (b2 === 0 && k2 === 0 && !inStr2) {
      return trimmed;
    }
    // 否则回退到原始 s，继续修复括号
  }

  // 3. 闭合数组和对象
  s += "]".repeat(Math.max(0, bracketCount));
  s += "}".repeat(Math.max(0, braceCount));

  // 如果什么也没修复，返回 null
  if (s === raw) return null;

  return s;
}

/**
 * 截断到最后一个完整的值，丢弃正在构建中的不完整字段
 */
function truncateToLastCompleteValue(raw: string): string | null {
  if (!raw.startsWith("{")) return null;

  // 找到最后一个完整的 , 或 { 后面的位置
  // 策略：找到最后一个引号对（完整的字符串值），然后闭合

  // 简单实现：找到最后一个 "key": value 的完整对
  // 更简单：从尾到头找最后一个 } 或 ] 或 "（完整字符串结尾）
  let inString = false;
  let depth = 0;
  const cutPoints: number[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && inString) { i++; continue; }
    if (ch === '"') {
      inString = !inString;
      if (!inString) {
        // 字符串刚刚闭合 — 这是一个安全的截断点
        cutPoints.push(i + 1);
      }
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; cutPoints.push(i + 1); }
    if (ch === "]") cutPoints.push(i + 1);
    // 数字或布尔值结束：数字后跟 , 或 }
  }

  if (cutPoints.length === 0) return null;

  // 使用最后一个安全截断点
  const cutAt = cutPoints[cutPoints.length - 1];
  let truncated = raw.slice(0, cutAt);

  // 去掉尾部逗号/冒号
  truncated = truncated.trimEnd();
  if (truncated.endsWith(",") || truncated.endsWith(":")) {
    truncated = truncated.slice(0, -1);
  }

  // 重新计算括号
  let b2 = 0, k2 = 0;
  let inStr2 = false;
  for (let i = 0; i < truncated.length; i++) {
    const ch = truncated[i];
    if (ch === "\\" && inStr2) { i++; continue; }
    if (ch === '"') { inStr2 = !inStr2; continue; }
    if (inStr2) continue;
    if (ch === "{") b2++;
    if (ch === "}") b2--;
    if (ch === "[") k2++;
    if (ch === "]") k2--;
  }
  truncated += "]".repeat(Math.max(0, k2)) + "}".repeat(Math.max(0, b2));

  if (truncated === "{") return "{}";

  return truncated;
}

/**
 * 根据围栏类型和 JSON 内容解析为 ContentBlock
 */
function parseFenceContent(
  fenceType: CardFenceType,
  rawJson: string,
): ContentBlock | null {
  try {
    const data = JSON.parse(rawJson.trim());

    switch (fenceType) {
      case "order":
        return { type: "order_card", data };
      case "policy":
        return { type: "policy_card", data };
      case "action":
        return { type: "action_card", data };
      case "status":
        return { type: "status_card", data };
      case "table":
        return { type: "table", data };
      default:
        return null;
    }
  } catch {
    // JSON 解析失败 → 静默忽略（不做卡片渲染）
    return null;
  }
}
