// ── Zod 协议校验 Schema ──
// 对每种卡片数据进行运行时校验。
// 每个 Schema 同时导出 .partial() 变体，用于流式构建中的部分数据校验。

import { z } from "zod";

// ── 枚举 ──

export const ActionStyleEnum = z.enum(["primary", "secondary", "danger"]);
export const StatusEnum = z.enum([
  "pending",
  "in_progress",
  "success",
  "error",
  "warning",
]);
export const StepStatusEnum = z.enum(["wait", "active", "done", "error"]);

// ── 卡片数据 Schema ──

/** 订单卡片 */
export const OrderCardDataSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number(),
      price: z.number(),
    }),
  ),
  total: z.number(),
  carrier: z.string().optional(),
  trackingNo: z.string().optional(),
  estimatedDelivery: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

/** 政策卡片 */
export const PolicyCardDataSchema = z.object({
  category: z.string(),
  title: z.string(),
  conditions: z.array(z.string()),
  refundTimeline: z.string().optional(),
  returnWindow: z.string().optional(),
  exceptions: z.array(z.string()).optional(),
});

/** 操作按钮卡片 */
export const ActionCardDataSchema = z.object({
  title: z.string(),
  description: z.string(),
  actions: z.array(
    z.object({
      label: z.string(),
      action: z.string(),
      style: ActionStyleEnum.optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

/** 状态追踪卡片 */
export const StatusCardDataSchema = z.object({
  title: z.string(),
  status: StatusEnum,
  steps: z
    .array(
      z.object({
        label: z.string(),
        status: StepStatusEnum,
        description: z.string().optional(),
      }),
    )
    .optional(),
  message: z.string().optional(),
});

/** 表格 */
export const TableBlockDataSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  caption: z.string().optional(),
});

// ── ContentBlock discriminated union ──

export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }),
  z.object({ type: z.literal("order_card"), data: OrderCardDataSchema }),
  z.object({ type: z.literal("policy_card"), data: PolicyCardDataSchema }),
  z.object({ type: z.literal("action_card"), data: ActionCardDataSchema }),
  z.object({ type: z.literal("status_card"), data: StatusCardDataSchema }),
  z.object({ type: z.literal("table"), data: TableBlockDataSchema }),
]);

export const ContentBlockChunkSchema = z.object({
  type: z.literal("content_block"),
  block: ContentBlockSchema,
  message_id: z.string(),
});

// ── Streaming partial schemas ──

/** 流式构建中的部分数据校验（所有字段 optional） */
export const OrderCardDataPartialSchema = OrderCardDataSchema.partial();
export const PolicyCardDataPartialSchema = PolicyCardDataSchema.partial();
export const ActionCardDataPartialSchema = ActionCardDataSchema.partial();
export const StatusCardDataPartialSchema = StatusCardDataSchema.partial();
export const TableBlockDataPartialSchema = TableBlockDataSchema.partial();

/** 根据卡片类型获取对应的 partial schema */
export function getPartialSchema(
  blockType: string,
): z.ZodTypeAny | null {
  switch (blockType) {
    case "order_card":
      return OrderCardDataPartialSchema;
    case "policy_card":
      return PolicyCardDataPartialSchema;
    case "action_card":
      return ActionCardDataPartialSchema;
    case "status_card":
      return StatusCardDataPartialSchema;
    case "table":
      return TableBlockDataPartialSchema;
    default:
      return null;
  }
}
