// ── 富内容块类型系统 ──
// 用于客服对话中的结构化卡片渲染（订单卡、政策卡、操作卡、状态卡等）
//
// 两种传输路径：
// 1. LLM 文本生成 → Markdown fenced code block（```card:order\n{json}\n```）
//    → 前端 card-parser 提取 → 渲染为卡片组件
// 2. ToolAgent 直接产出 → SSE content_block 事件 → 前端直接入队渲染

// ── 卡片数据类型 ──

export interface OrderCardData {
  orderId: string;
  status: string;
  statusLabel: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  carrier?: string;
  trackingNo?: string;
  estimatedDelivery?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface PolicyCardData {
  category: string;
  title: string;
  conditions: string[];
  refundTimeline?: string;
  returnWindow?: string;
  exceptions?: string[];
}

export interface ActionCardData {
  title: string;
  description: string;
  actions: Array<{
    label: string;
    action: string;
    style?: "primary" | "secondary" | "danger";
    payload?: Record<string, unknown>;
  }>;
}

export interface StatusCardData {
  title: string;
  status: "pending" | "in_progress" | "success" | "error" | "warning";
  steps?: Array<{
    label: string;
    status: "wait" | "active" | "done" | "error";
    description?: string;
  }>;
  message?: string;
}

export interface TableBlockData {
  headers: string[];
  rows: string[][];
  caption?: string;
}

// ── ContentBlock 联合类型 ──

export type ContentBlockType =
  | "text"
  | "order_card"
  | "policy_card"
  | "action_card"
  | "status_card"
  | "table";

export interface TextBlock {
  type: "text";
  content: string; // markdown 字符串
}

export interface OrderCardBlock {
  type: "order_card";
  data: OrderCardData;
}

export interface PolicyCardBlock {
  type: "policy_card";
  data: PolicyCardData;
}

export interface ActionCardBlock {
  type: "action_card";
  data: ActionCardData;
}

export interface StatusCardBlock {
  type: "status_card";
  data: StatusCardData;
}

export interface TableBlock {
  type: "table";
  data: TableBlockData;
}

export type ContentBlock =
  | TextBlock
  | OrderCardBlock
  | PolicyCardBlock
  | ActionCardBlock
  | StatusCardBlock
  | TableBlock;

// ── SSE 协议扩展 ──

export interface ContentBlockChunk {
  type: "content_block";
  block: ContentBlock;
  message_id: string;
}

// ── Markdown 卡片标记解析 ──

export type CardFenceType = "order" | "policy" | "action" | "status" | "table";

export interface ParsedCardFence {
  fenceType: CardFenceType;
  rawJson: string;
  block: ContentBlock | null;
}
