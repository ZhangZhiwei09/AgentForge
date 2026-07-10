// SSE Chunk 类型收窄
// 应用级完整版本：依赖 @/lib/sse-types.ts 中的完整 SSEDataChunk 类型
// 通用版块（blockKey、dedupeBlocks）已迁移至 @agentforge/cui

import type { SSEDataChunk } from "./sse-types";

/**
 * 解析并校验 SSE 数据块。
 * 采用轻量 discriminator 检查：验证 type 字段 + 每个变体最关键的一个字段。
 * 返回 null 表示数据不符合预期协议 —— 调用方应记录 warn 日志并跳过该 chunk。
 *
 * 设计选择：手写 Type Guard 而非 Zod。
 * - SSE 数据来自自有后端，TypeScript 编译期已保证协议结构
 * - discriminator + 关键字段检查足以防御序列化损坏 / 中间人篡改
 * - 零运行时依赖，不影响 bundle size
 */
export function parseSSEChunk(raw: unknown): SSEDataChunk | null {
  if (typeof raw !== "object" || raw === null) return null;

  // 安全取值 —— 此时 raw 的类型尚未确认
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (typeof type !== "string") return null;

  switch (type) {
    case "meta":
      // meta chunk 必须携带 message_id
      if (typeof obj.message_id !== "string") return null;
      break;
    case "token":
      // token chunk 必须携带 content 字符串
      if (typeof obj.content !== "string") return null;
      break;
    case "done":
      // done chunk 必须携带 message_id
      if (typeof obj.message_id !== "string") return null;
      break;
    case "content_block":
      // content_block chunk 必须携带 block 对象
      if (obj.block == null) return null;
      break;
    case "error":
      // error chunk 必须携带 content 字符串
      if (typeof obj.content !== "string") return null;
      break;
    default:
      // 未知的 type 值 —— 可能是新协议或损坏数据
      return null;
  }

  // 通过 discriminator + 关键字段检查，类型安全收窄
  return raw as SSEDataChunk;
}
