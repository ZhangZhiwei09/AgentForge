// 客服工具集 —— 用于 TOOL 路径的 Agent 调用
// 初期提供 stub 实现，返回合理假数据供 LLM 合成回复
// 后续可接入真实 OrderService / TicketService / ShippingService

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";

// ═══════════════════════════════════════════════════════
// 1. lookup_order —— 按订单号查询订单状态
// ═══════════════════════════════════════════════════════

const lookupOrderDef: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup_order",
    description:
      "查询订单状态。用户需要提供订单号来查询订单的当前状态、物流信息等。",
    parameters: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description: "订单号，例如 'ORD-2024-001234'",
        },
      },
      required: ["order_id"],
    },
  },
};

async function lookupOrderExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const orderId = (args.order_id as string) || "未知订单";

  // Stub: 返回模拟订单数据
  const stubOrders: Record<string, unknown> = {
    "ORD-2024-001234": {
      order_id: "ORD-2024-001234",
      status: "已发货",
      items: [{ name: "商品A", quantity: 1, price: 299.0 }],
      total: 299.0,
      shipping: { carrier: "顺丰快递", tracking_no: "SF1234567890" },
      estimated_delivery: "2026-06-15",
      created_at: "2026-06-10",
    },
  };

  const order =
    stubOrders[orderId] || {
      order_id: orderId,
      status: "未查询到",
      message: `订单 ${orderId} 未找到，请检查订单号是否正确。`,
    };

  return JSON.stringify(order, null, 2);
}

// ═══════════════════════════════════════════════════════
// 2. create_support_ticket —— 创建客服工单
// ═══════════════════════════════════════════════════════

const createSupportTicketDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_support_ticket",
    description:
      "为客户创建客服工单。当问题无法立刻解决或客户要求投诉/升级时使用。",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "问题摘要，简要描述客户遇到的问题",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "工单优先级：normal（普通）或 urgent（紧急）",
        },
      },
      required: ["summary"],
    },
  },
};

async function createSupportTicketExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const summary = (args.summary as string) || "未提供摘要";
  const priority = (args.priority as string) || "normal";
  const ticketId = `TK-${Date.now().toString(36).toUpperCase()}`;

  return JSON.stringify(
    {
      ticket_id: ticketId,
      status: "已创建",
      priority,
      summary,
      created_at: new Date().toISOString(),
      message:
        priority === "urgent"
          ? "工单已标记为紧急，客服团队将在 1 小时内响应。"
          : "工单已创建，客服团队将在 24 小时内响应。",
    },
    null,
    2,
  );
}

// ═══════════════════════════════════════════════════════
// 3. check_return_policy —— 查询退换货政策
// ═══════════════════════════════════════════════════════

const checkReturnPolicyDef: ToolDefinition = {
  type: "function",
  function: {
    name: "check_return_policy",
    description:
      "查询退换货政策。可以根据商品类别或退货原因查询具体的退货规则。",
    parameters: {
      type: "object",
      properties: {
        product_category: {
          type: "string",
          description: "商品类别，例如 '电子产品'、'服装'、'食品'",
        },
        reason: {
          type: "string",
          description: "退货原因，例如 '质量问题'、'不喜欢'、'发错货'",
        },
      },
      required: [],
    },
  },
};

async function checkReturnPolicyExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const category = (args.product_category as string) || "通用";
  const reason = (args.reason as string) || "未指定";

  // Stub: 返回通用退货政策
  return JSON.stringify(
    {
      policy: "7天无理由退货",
      conditions: [
        "商品完好，不影响二次销售",
        "保留原包装和配件",
        "非特殊商品（食品、内衣等开封后不可退）",
      ],
      refund_timeline: "收到退货后 1-3 个工作日退款到原支付方式",
      category_note:
        category !== "通用"
          ? `${category}类商品适用标准退货政策`
          : "通用退货政策适用于大部分商品",
      reason_note:
        reason === "质量问题"
          ? "质量问题退货免运费，请保留问题照片"
          : "非质量问题退货需自行承担运费",
    },
    null,
    2,
  );
}

// ═══════════════════════════════════════════════════════
// 4. check_shipping_status —— 查询物流状态
// ═══════════════════════════════════════════════════════

const checkShippingStatusDef: ToolDefinition = {
  type: "function",
  function: {
    name: "check_shipping_status",
    description:
      "查询物流配送状态。根据运单号查询快递的当前位置和预计送达时间。",
    parameters: {
      type: "object",
      properties: {
        tracking_number: {
          type: "string",
          description: "快递单号",
        },
        order_id: {
          type: "string",
          description: "订单号（如果没有运单号，可通过订单号关联查询）",
        },
      },
      required: [],
    },
  },
};

async function checkShippingStatusExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const trackingNo = (args.tracking_number as string) || "未知";
  const orderId = (args.order_id as string) || "";

  // Stub: 返回模拟物流数据
  return JSON.stringify(
    {
      tracking_number: trackingNo || `关联订单 ${orderId}`,
      status: "运输中",
      current_location: "上海分拣中心",
      estimated_delivery: "2026-06-15",
      history: [
        { time: "2026-06-13 08:30", status: "到达上海分拣中心" },
        { time: "2026-06-12 20:00", status: "离开深圳转运中心" },
        { time: "2026-06-12 10:00", status: "商家已发货" },
      ],
      note: "以上为模拟物流数据，实际以快递公司官网为准",
    },
    null,
    2,
  );
}

// ═══════════════════════════════════════════════════════
// 工具注册列表
// ═══════════════════════════════════════════════════════

export const customerServiceTools: RegisteredTool[] = [
  {
    definition: lookupOrderDef,
    execute: lookupOrderExecute,
    riskLevel: "read_only",
    timeout: 15_000,
    requireApproval: false,
    category: "customer_service",
    parallelizable: false,
  },
  {
    definition: createSupportTicketDef,
    execute: createSupportTicketExecute,
    riskLevel: "mutation",
    timeout: 30_000,
    requireApproval: false, // 用户通过 HUMAN 路由已隐式确认
    category: "customer_service",
    parallelizable: false,
  },
  {
    definition: checkReturnPolicyDef,
    execute: checkReturnPolicyExecute,
    riskLevel: "safe",
    timeout: 10_000,
    requireApproval: false,
    category: "customer_service",
    parallelizable: false,
  },
  {
    definition: checkShippingStatusDef,
    execute: checkShippingStatusExecute,
    riskLevel: "read_only",
    timeout: 15_000,
    requireApproval: false,
    category: "customer_service",
    parallelizable: false,
  },
];
