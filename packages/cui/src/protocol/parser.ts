// ── 协议解析器 ──
// 统一解析入口：接收 Markdown 字符串或 ContentBlockChunk，返回校验后的 ParsedCardResult

import type { ContentBlockChunk } from "@agentforge/shared-types";
import type { ParsedCard, ParsedCardResult } from "./types";
import { CARD_FENCE_TYPE_MAP } from "./types";
import { ContentBlockChunkSchema, getPartialSchema } from "./schemas";
import { extractCardBlocks } from "../parsing/card-parser";

/**
 * 统一卡片解析入口。
 * - 接收 Markdown 字符串 → 内部调用 extractCardBlocks，逐块校验
 * - 接收 ContentBlockChunk → 直接校验 block 字段
 *
 * 返回 ParsedCardResult，包含成功解析的卡片列表和跳过计数。
 */
export function parseCard(
  input: string | ContentBlockChunk,
): ParsedCardResult {
  // 路径 A：SSE content_block 事件
  if (typeof input === "object" && input !== null) {
    return parseFromChunk(input as ContentBlockChunk);
  }

  // 路径 B：Markdown 字符串
  return parseFromMarkdown(input as string);
}

/**
 * 校验单个卡片数据。
 * 返回 ParsedCard，validated=false 时 errors 包含具体失败原因。
 */
export function validateCardData<T = unknown>(
  blockType: string,
  data: unknown,
): ParsedCard<T> {
  const schema = getPartialSchema(blockType);
  if (!schema) {
    return {
      type: blockType,
      data: data as T,
      validated: false,
      errors: [{ path: "type", message: `Unknown block type: ${blockType}` }],
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return {
      type: blockType,
      data: result.data as T,
      validated: true,
    };
  }

  return {
    type: blockType,
    data: data as T,
    validated: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

// ── Private helpers ──

function parseFromChunk(chunk: ContentBlockChunk): ParsedCardResult {
  const chunkResult = ContentBlockChunkSchema.safeParse(chunk);
  if (!chunkResult.success) {
    return { cards: [], skippedCount: 1 };
  }

  const { block } = chunkResult.data;
  const result = validateCardData(block.type, "data" in block ? (block as Record<string, unknown>).data : block);
  return { cards: [result], skippedCount: 0 };
}

function parseFromMarkdown(markdown: string): ParsedCardResult {
  const { blocks } = extractCardBlocks(markdown);
  const cards: ParsedCard[] = [];
  let skippedCount = 0;

  for (const { block } of blocks) {
    if (block.type === "text") {
      // TextBlock 不需要校验
      cards.push({
        type: "text",
        data: block as unknown,
        validated: true,
      });
      continue;
    }

    const data = (block as unknown as Record<string, unknown>).data;
    const cardType =
      block.type in reverseFenceMap
        ? reverseFenceMap[block.type]
        : block.type;

    if (!data || typeof data !== "object") {
      skippedCount++;
      continue;
    }

    const result = validateCardData(block.type, data);
    if (result.validated) {
      cards.push(result);
    } else {
      skippedCount++;
    }
  }

  return { cards, skippedCount };
}

/** 反向映射 ContentBlockType → 简称（用于日志和调试） */
const reverseFenceMap: Record<string, string> = {};
for (const [fence, block] of Object.entries(CARD_FENCE_TYPE_MAP)) {
  reverseFenceMap[block] = fence;
}
