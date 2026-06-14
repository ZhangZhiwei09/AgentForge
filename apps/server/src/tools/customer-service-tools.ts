// 客服工具集 —— 用于 TOOL 路径的 Agent 调用
//
// 接入 OrderService 提供真实的模拟数据查询能力：
//   - lookup_order: 按订单号查询订单状态、商品、物流
//   - check_shipping_status: 按运单号/订单号查询物流详情（含时间线）
//   - check_return_policy: 按商品类目和退货原因查询退换货政策
//   - create_support_ticket: 创建客服工单并持久化到文件
//
// 所有工具通过 OrderService 单例操作，数据持久化到 data/orders.json 和 data/tickets.json

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import { getOrderService } from "../services/customer-chat/order-service.js";
import { logger } from "@agentforge/logger";

// ═══════════════════════════════════════════════════════
// 1. lookup_order —— 按订单号查询订单状态
// ═══════════════════════════════════════════════════════

const lookupOrderDef: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup_order",
    description:
      "查询订单状态和详情。需要提供订单号（格式如 ORD-2024-001234），返回订单当前状态、商品列表、金额、物流单号等信息。",
    parameters: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description: "订单号，格式为 ORD-YYYY-NNNNNN，例如 ORD-2024-001234",
        },
      },
      required: ["order_id"],
    },
  },
};

async function lookupOrderExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const orderId = (args.order_id as string) || "";
  if (!orderId) {
    return JSON.stringify({ error: "请提供订单号" });
  }

  try {
    const service = getOrderService();
    const order = await service.lookupOrder(orderId);

    if (!order) {
      return JSON.stringify(
        {
          found: false,
          order_id: orderId,
          message: `订单 ${orderId} 未找到。请检查订单号是否正确。可尝试的格式：ORD-2024-001234。`,
          suggestion: "如果您不确定订单号，可以尝试提供快递单号查询物流。",
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        found: true,
        order_id: order.orderId,
        status: service.statusLabel(order.status),
        items: order.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit_price: i.unitPrice,
          subtotal: i.quantity * i.unitPrice,
        })),
        payment: {
          method: order.paymentMethod || "未指定",
          subtotal: order.subtotal,
          shipping_fee: order.shippingFee,
          discount: order.discount,
          total: order.total,
        },
        shipping: {
          carrier: order.shipping.carrier || "待分配",
          tracking_no: order.shipping.trackingNo || "暂无",
          estimated_delivery: order.shipping.estimatedDelivery || "待确定",
        },
        created_at: order.createdAt,
        notes: order.notes || null,
      },
      null,
      2,
    );
  } catch (e) {
    logger.error(e, "lookup_order failed");
    return JSON.stringify({
      error: "订单查询服务暂时不可用，请稍后再试或转接人工客服。",
    });
  }
}

// ═══════════════════════════════════════════════════════
// 2. create_support_ticket —— 创建客服工单
// ═══════════════════════════════════════════════════════

const createSupportTicketDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_support_ticket",
    description:
      "为客户创建客服工单。当问题无法立刻解决、客户要求投诉/升级、或需要售后团队跟进时使用。工单创建后会被持久化保存。",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "问题摘要，用一两句话描述客户遇到的具体问题和诉求",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description:
            "工单优先级：normal（普通，24小时响应）或 urgent（紧急，1小时响应）",
        },
        order_id: {
          type: "string",
          description: "关联的订单号（如果有），例如 ORD-2024-001234",
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
  const priority = (args.priority as "normal" | "urgent") || "normal";
  const orderId = (args.order_id as string) || undefined;

  try {
    const service = getOrderService();
    const ticket = await service.createTicket({ summary, priority, orderId });

    return JSON.stringify(
      {
        ticket_id: ticket.ticketId,
        status: "已创建",
        priority: ticket.priority,
        summary: ticket.summary,
        order_id: ticket.orderId || null,
        created_at: ticket.createdAt,
        response_time:
          priority === "urgent"
            ? "工单已标记为紧急，客服团队将在 1 小时内响应处理。"
            : "工单已创建，客服团队将在 24 小时内响应处理。",
        tracking_tip: `您可以通过工单号 ${ticket.ticketId} 查询处理进度。`,
      },
      null,
      2,
    );
  } catch (e) {
    logger.error(e, "create_support_ticket failed");
    return JSON.stringify({
      error:
        "工单创建服务暂时不可用，请稍后再试。如有紧急问题，请拨打客服热线：400-XXX-XXXX。",
    });
  }
}

// ═══════════════════════════════════════════════════════
// 3. check_return_policy —— 查询退换货政策
// ═══════════════════════════════════════════════════════

const checkReturnPolicyDef: ToolDefinition = {
  type: "function",
  function: {
    name: "check_return_policy",
    description:
      "查询退换货政策。可以根据商品类别（电子产品、服装、食品等）和退货原因（质量问题、不喜欢等）查询适用的退货规则、条件、退款时间和运费承担方。",
    parameters: {
      type: "object",
      properties: {
        product_category: {
          type: "string",
          description: "商品类别，可选：通用、电子产品、服装、食品",
        },
        reason: {
          type: "string",
          description: "退货原因，如：质量问题、发错货、不喜欢、不想要了",
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
  const reason = (args.reason as string) || undefined;

  try {
    const service = getOrderService();
    const policy = await service.getReturnPolicy(category, reason);

    return JSON.stringify(
      {
        category: policy.category,
        policy: policy.policy,
        return_window: policy.returnWindow,
        conditions: policy.conditions,
        refund_timeline: policy.refundTimeline,
        shipping_responsibility: policy.shippingResponsibility,
        exceptions: policy.exceptions,
        reason_note: policy.reasonNote,
      },
      null,
      2,
    );
  } catch (e) {
    logger.error(e, "check_return_policy failed");
    return JSON.stringify({
      error: "退换货政策查询暂时不可用，请稍后再试。",
    });
  }
}

// ═══════════════════════════════════════════════════════
// 4. check_shipping_status —— 查询物流状态
// ═══════════════════════════════════════════════════════

const checkShippingStatusDef: ToolDefinition = {
  type: "function",
  function: {
    name: "check_shipping_status",
    description:
      "查询物流配送状态。输入运单号（如 SF1234567890）或订单号（如 ORD-2024-001234），返回当前物流状态、位置、运输历史和预计送达时间。",
    parameters: {
      type: "object",
      properties: {
        tracking_number: {
          type: "string",
          description: "快递单号，如 SF1234567890",
        },
        order_id: {
          type: "string",
          description:
            "订单号（如果没有运单号，可通过订单号关联查询），如 ORD-2024-001234",
        },
      },
      required: [],
    },
  },
};

async function checkShippingStatusExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const trackingNo = (args.tracking_number as string) || "";
  const orderId = (args.order_id as string) || "";
  const query = trackingNo || orderId;

  if (!query) {
    return JSON.stringify({
      error: "请提供运单号或订单号以查询物流信息。",
    });
  }

  try {
    const service = getOrderService();
    const result = await service.getShippingStatus(query);

    if (!result.found) {
      return JSON.stringify(result, null, 2);
    }

    return JSON.stringify(
      {
        found: true,
        order_id: result.orderId,
        carrier: result.carrier,
        tracking_no: result.trackingNo,
        current_status: result.status,
        estimated_delivery: result.estimatedDelivery,
        history: result.history?.map((h) => ({
          time: h.time,
          location: h.location,
          description: h.description,
        })),
      },
      null,
      2,
    );
  } catch (e) {
    logger.error(e, "check_shipping_status failed");
    return JSON.stringify({
      error: "物流查询服务暂时不可用，请稍后再试。",
    });
  }
}

// ═══════════════════════════════════════════════════════
// 5. search_knowledge_base —— RAG 知识库检索
// ═══════════════════════════════════════════════════════

const searchKnowledgeBaseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "搜索客服知识库，获取退换货政策、物流说明、会员权益、支付方式等业务相关信息。" +
      "当用户询问政策类问题（退货规则、配送时间、会员等级等）且当前没有订单上下文时使用此工具。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询语句，使用用户问题的核心关键词",
        },
      },
      required: ["query"],
    },
  },
};

async function searchKnowledgeBaseExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args.query as string) || "";
  if (!query.trim()) {
    return JSON.stringify({ error: "请提供搜索查询" });
  }

  try {
    // ── Pipeline: Recall → Rerank → Threshold → Return ──
    const { KnowledgeService } = await import("../services/knowledge.js");
    const service = new KnowledgeService();

    // 1. Recall: 从 Milvus 检索 top-10 候选
    const rawResults = await service.search(query, null, 10);

    if (!rawResults || rawResults.length === 0) {
      return JSON.stringify({
        query,
        found: false,
        message:
          "未找到相关知识库内容。请基于通用知识回答用户，并建议联系人工客服获取准确信息。",
      });
    }

    // 2. Rerank: 去重 + 分数排序
    const seen = new Set<string>();
    const deduped: Array<{ content: string; score: number; source: string }> =
      [];
    for (const r of rawResults) {
      const key = r.content.slice(0, 100).trim();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        content: r.content,
        score: Math.round(r.score * 100) / 100,
        source: r.docTitle || "知识库",
      });
    }
    // 按分数降序
    deduped.sort((a, b) => b.score - a.score);

    // 取 top-5
    const reranked = deduped.slice(0, 5);

    // 3. Threshold: 最高分低于 0.5 → 不返回（避免低质量信息）
    const topScore = reranked[0]?.score ?? 0;
    if (topScore < 0.5) {
      return JSON.stringify({
        query,
        found: false,
        topScore,
        message:
          "知识库中未找到高相关度内容。请基于通用知识回答，并告知用户此信息可能需要人工核实。",
      });
    }

    // 4. 质量标记
    const qualityLabel =
      topScore >= 0.8 ? "high" : topScore >= 0.65 ? "medium" : "low";

    return JSON.stringify({
      query,
      found: true,
      quality: qualityLabel,
      topScore,
      results: reranked.map((r) => ({
        content: r.content,
        score: r.score,
        source: r.source,
      })),
      note:
        qualityLabel === "low"
          ? "相关度较低，建议在回复中标注'仅供参考'并建议用户联系人工核实。"
          : undefined,
    });
  } catch (e) {
    logger.error(e, "search_knowledge_base failed");
    return JSON.stringify({
      error: "知识库搜索暂时不可用，请基于通用知识回答用户。",
    });
  }
}

// ═══════════════════════════════════════════════════════
// 工具注册列表
// ═══════════════════════════════════════════════════════

export const customerServiceTools: RegisteredTool[] = [
  {
    definition: searchKnowledgeBaseDef,
    execute: searchKnowledgeBaseExecute,
    riskLevel: "read_only",
    timeout: 10_000,
    requireApproval: false,
    category: "customer_service",
    parallelizable: false,
  },
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
    requireApproval: false, // 创建工单是低风险操作，客服场景无交互式审批UI，设为false避免Agent永久挂起
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
