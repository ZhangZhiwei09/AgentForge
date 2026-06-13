// ── 卡片标记解析器 ──
// 从 Markdown 文本中提取 ```card:type\n{json}\n``` 围栏代码块
// 返回纯净 Markdown + 结构化卡片块数组

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
