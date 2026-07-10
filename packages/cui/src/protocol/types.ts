// ── 卡片协议类型定义 ──
// 版本号、类型枚举、SSE 基础事件类型

/** 卡片协议版本号（SemVer） */
export const CARD_PROTOCOL_VERSION = "1.0.0";

/** 所有支持的卡片围栏类型（Markdown Fence transport） */
export const CARD_FENCE_TYPES = [
  "order",
  "policy",
  "action",
  "status",
  "table",
] as const;

/** 所有支持的 ContentBlock 类型 */
export const CONTENT_BLOCK_TYPES = [
  "text",
  "order_card",
  "policy_card",
  "action_card",
  "status_card",
  "table",
] as const;

/** CardFenceType → ContentBlockType 映射 */
export const CARD_FENCE_TYPE_MAP: Record<string, string> = {
  order: "order_card",
  policy: "policy_card",
  action: "action_card",
  status: "status_card",
  table: "table",
};

/** 协议元信息 */
export const CardProtocolMeta = {
  version: CARD_PROTOCOL_VERSION,
  supportedFenceTypes: CARD_FENCE_TYPES,
  supportedBlockTypes: CONTENT_BLOCK_TYPES,
} as const;

/** 通用 ParsedCard 包装 —— parseCard() 返回值的基础结构 */
export interface ParsedCard<T = unknown> {
  type: string;
  data: T;
  validated: boolean;
  errors?: Array<{ path: string; message: string }>;
}

/** 统一解析结果 */
export interface ParsedCardResult {
  cards: ParsedCard[];
  /** 解析过程中被跳过的无效数据计数 */
  skippedCount: number;
}

/** 轻量 SSE 事件基础类型 —— 用于跨应用的通用 SSE chunk 校验。
 *  仅包含 discriminator + 最关键字段，不包含应用特有的完整字段。 */
export type SSEBaseChunk =
  | { type: "meta"; message_id: string }
  | { type: "token"; content: string; message_id: string }
  | { type: "done"; message_id: string }
  | { type: "content_block"; block: Record<string, unknown>; message_id: string }
  | { type: "error"; content: string };
