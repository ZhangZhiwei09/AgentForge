// SSE Chunk 类型收窄 & ContentBlock 去重工具
// 通用版本：不依赖应用本地的 SSE 完整类型定义

import type { ContentBlock } from "@agentforge/shared-types";
import type { SSEBaseChunk } from "../protocol/types";

/**
 * 通用 SSE Chunk 解析（轻量版）。
 * 基于 discriminator + 关键字段检查进行运行时校验。
 * 返回 null 表示数据不符合预期协议 —— 调用方应记录 warn 日志并跳过该 chunk。
 *
 * 注意：这是跨应用通用版本，仅校验最关键的协议字段。
 * 对于应用特有的完整字段校验（如 meta chunk 中的 knowledge/intent 等），
 * 应在应用层使用 app 私有的 parseSSEChunk。
 */
export function parseSSEChunk(raw: unknown): SSEBaseChunk | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (typeof type !== "string") return null;

  switch (type) {
    case "meta":
      if (typeof obj.message_id !== "string") return null;
      break;
    case "token":
      if (typeof obj.content !== "string") return null;
      break;
    case "done":
      if (typeof obj.message_id !== "string") return null;
      break;
    case "content_block":
      if (obj.block == null) return null;
      break;
    case "error":
      if (typeof obj.content !== "string") return null;
      break;
    default:
      return null;
  }

  return raw as SSEBaseChunk;
}

/**
 * 为 ContentBlock 生成去重 key。
 * 穷尽覆盖 ContentBlock 联合类型的所有 6 种变体。
 * TypeScript 会在此函数中检查 exhaustiveness ——
 * 若 shared-types 新增 ContentBlock 类型，此处会编译报错。
 */
export function blockKey(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text:${block.content.slice(0, 50)}`;
    case "order_card":
      return `order:${block.data.orderId}`;
    case "policy_card":
      return `policy:${block.data.category}:${block.data.title}`;
    case "action_card":
      return `action:${block.data.title}`;
    case "status_card":
      return `status:${block.data.title}`;
    case "table":
      return `table:${block.data.headers.join(",")}:${block.data.rows.length}`;
  }
}

/**
 * ContentBlock 数组去重。
 * 避免 SSE content_block 事件和 Markdown fence 解析产生重复卡片。
 */
export function dedupeBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((b) => {
    const key = blockKey(b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
