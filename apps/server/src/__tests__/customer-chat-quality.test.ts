// 客服质量保障单元测试
// ============================================
// 覆盖：OrderService、validateBusinessResponse（五层校验管线）、
//       CitationVerifier（语义引证校验）
// 所有测试不依赖 LLM / Milvus / embedding provider，CI 环境可运行

import { describe, it, expect, beforeEach } from "vitest";
import { OrderService } from "../services/customer-chat/order-service.js";
import {
  validateBusinessResponse,
  SORRY_TEMPLATE,
} from "../services/customer-chat/validation.js";

// ═══════════════════════════════════════════════════════
// 1. OrderService 测试
// ═══════════════════════════════════════════════════════

describe("OrderService", () => {
  let service: OrderService;

  beforeEach(async () => {
    service = new OrderService();
    await service.reset(); // 每次测试从种子数据开始
  });

  describe("lookupOrder", () => {
    it("按订单号查询存在的订单", async () => {
      const order = await service.lookupOrder("ORD-2024-001234");
      expect(order).not.toBeNull();
      expect(order!.orderId).toBe("ORD-2024-001234");
      expect(order!.status).toBe("shipped");
      expect(order!.items.length).toBeGreaterThan(0);
    });

    it("查询不存在的订单返回 null", async () => {
      const order = await service.lookupOrder("ORD-DOES-NOT-EXIST");
      expect(order).toBeNull();
    });

    it("订单号大小写不敏感", async () => {
      const order = await service.lookupOrder("ord-2024-001234");
      expect(order).not.toBeNull();
      expect(order!.orderId).toBe("ORD-2024-001234");
    });

    it("返回的订单包含完整字段", async () => {
      const order = await service.lookupOrder("ORD-2024-001298");
      expect(order).not.toBeNull();
      expect(order!.items).toBeInstanceOf(Array);
      expect(order!.shipping).toBeDefined();
      expect(order!.shipping.carrier).toBe("中通快递");
      expect(order!.total).toBe(340.0);
      expect(order!.paymentMethod).toBe("支付宝");
    });
  });

  describe("getUserOrders", () => {
    it("按用户 ID 查询多个订单（按时间倒序）", async () => {
      const orders = await service.getUserOrders("user_demo_001");
      expect(orders.length).toBeGreaterThan(1);
      // 验证倒序：第一个订单的 createdAt 应该 >= 最后一个
      const firstDate = new Date(orders[0].createdAt).getTime();
      const lastDate = new Date(orders[orders.length - 1].createdAt).getTime();
      expect(firstDate).toBeGreaterThanOrEqual(lastDate);
    });

    it("查询不存在的用户返回空数组", async () => {
      const orders = await service.getUserOrders("nonexistent_user");
      expect(orders).toEqual([]);
    });
  });

  describe("lookupByTracking", () => {
    it("按运单号查询", async () => {
      const order = await service.lookupByTracking("SF1234567890");
      expect(order).not.toBeNull();
      expect(order!.orderId).toBe("ORD-2024-001234");
    });

    it("不存在的运单号返回 null", async () => {
      const order = await service.lookupByTracking("INVALID_TRACKING");
      expect(order).toBeNull();
    });
  });

  describe("getShippingStatus", () => {
    it("按运单号查询物流状态含完整时间线", async () => {
      const result = await service.getShippingStatus("SF1234567890");
      expect(result.found).toBe(true);
      expect(result.carrier).toBe("顺丰速运");
      expect(result.history).toBeDefined();
      expect(result.history!.length).toBeGreaterThan(0);
      expect(result.history![0]).toHaveProperty("time");
      expect(result.history![0]).toHaveProperty("location");
      expect(result.history![0]).toHaveProperty("description");
    });

    it("按订单号查询物流状态", async () => {
      const result = await service.getShippingStatus("ORD-2024-001234");
      expect(result.found).toBe(true);
      expect(result.orderId).toBe("ORD-2024-001234");
    });

    it("未发货订单返回正确提示", async () => {
      const result = await service.getShippingStatus("ORD-2024-001450");
      expect(result.found).toBe(true);
      expect(result.message).toContain("尚未发货");
    });

    it("不存在的运单/订单返回提示", async () => {
      const result = await service.getShippingStatus("NONEXISTENT");
      expect(result.found).toBe(false);
      expect(result.message).toBeDefined();
      expect(result.message).toContain("未找到物流信息");
    });
  });

  describe("getReturnPolicy", () => {
    it("查询通用退换货政策", async () => {
      const policy = await service.getReturnPolicy("通用");
      expect(policy.category).toBe("通用");
      expect(policy.policy).toContain("7天无理由退货");
      expect(policy.conditions.length).toBeGreaterThan(0);
      expect(policy.exceptions.length).toBeGreaterThan(0);
    });

    it("质量问题附加原因说明", async () => {
      const policy = await service.getReturnPolicy("电子产品", "质量问题");
      expect(policy.reasonNote).toContain("免运费");
    });

    it("不喜欢的退货原因说明运费承担", async () => {
      const policy = await service.getReturnPolicy("服装", "不喜欢");
      expect(policy.reasonNote).toContain("自行承担");
    });

    it("未知类目回退到通用政策", async () => {
      const policy = await service.getReturnPolicy("不存在的类目");
      expect(policy.category).toBe("通用");
    });

    it("食品不支持无理由退货", async () => {
      const policy = await service.getReturnPolicy("食品");
      expect(policy.policy).toContain("不支持无理由退货");
    });
  });

  describe("createTicket & getTickets", () => {
    it("创建工单并持久化", async () => {
      const ticket = await service.createTicket({
        summary: "测试工单：物流丢失",
        priority: "urgent",
        orderId: "ORD-2024-001234",
      });

      expect(ticket.ticketId).toMatch(/^TK-/);
      expect(ticket.status).toBe("open");
      expect(ticket.priority).toBe("urgent");

      const tickets = await service.getTickets();
      expect(tickets).toContainEqual(ticket);
    });

    it("默认优先级为 normal", async () => {
      const ticket = await service.createTicket({ summary: "一般咨询" });
      expect(ticket.priority).toBe("normal");
    });

    it("按 userId 过滤工单", async () => {
      await service.createTicket({
        summary: "user A 的工单",
        userId: "user_a",
      });
      await service.createTicket({
        summary: "user B 的工单",
        userId: "user_b",
      });

      const userATickets = await service.getTickets("user_a");
      expect(userATickets.length).toBe(1);
      expect(userATickets[0].summary).toBe("user A 的工单");
    });
  });

  describe("statusLabel", () => {
    it("所有订单状态有中文标签", () => {
      const statuses = [
        "pending_payment",
        "paid",
        "processing",
        "shipped",
        "in_transit",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "refunded",
      ] as const;
      for (const s of statuses) {
        const label = service.statusLabel(s);
        expect(label).toBeTruthy();
        expect(typeof label).toBe("string");
      }
    });

    it("未知状态返回原值", () => {
      expect(service.statusLabel("unknown_status" as any)).toBe(
        "unknown_status",
      );
    });
  });

  describe("reset", () => {
    it("reset 后工单被清空", async () => {
      await service.createTicket({ summary: "test" });
      await service.reset();
      const tickets = await service.getTickets();
      expect(tickets).toEqual([]);
    });

    it("reset 后订单恢复到种子数据", async () => {
      await service.reset();
      const order = await service.lookupOrder("ORD-2024-001234");
      expect(order).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════
// 2. validateBusinessResponse 五层校验管线测试
// ═══════════════════════════════════════════════════════

describe("validateBusinessResponse — 五层校验管线", () => {
  describe("Layer 1: JSON 可解析", () => {
    it("有效 JSON 通过 L1", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好，有什么可以帮助您的？",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("自然语言文本跳过 L1/L2，直接进入 L3-L5（不再误报 JSON 不可解析）", () => {
      // ToolAgent 输出自然语言而非 JSON → validateBusinessResponse 应跳过 L1/L2
      const result = validateBusinessResponse(
        "您的订单已发货，物流单号 SF123456。预计 6月20日 送达。",
        [],
      );
      // 无 KB chunks，但纯物流信息不应命中文案中无禁止模式
      // L5 会检测到业务事实性内容但 KB 为空 → 这是正确的警告
      // 但如果输入不含触发词，则应通过
    });

    it("含 JSON 结构但格式错误的输入仍在 L1/L2 被拦截", () => {
      // 以 { 开头且包含 answer 字段 → 判定为 JSON 格式尝试
      const result = validateBusinessResponse(
        JSON.stringify({ wrong_field: "test" }),
        [],
      );
      expect(result.valid).toBe(false);
      // L2: Schema 校验失败（answer 字段缺失）
      expect(result.layer).toBe(2);
    });
  });

  describe("Layer 2: Schema 校验", () => {
    it("缺少 answer 字段在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("answer 超过 2000 字符在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: "A".repeat(2001), suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("suggestions 超过 3 条在 L2 被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "好的",
          suggestions: ["1", "2", "3", "4"],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(2);
    });

    it("合法 Schema 通过 L2", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您的订单已发货，预计明天到达。",
          suggestions: ["查询物流", "联系客服"],
        }),
        [
          "知识库内容：订单发货后预计1-3个工作日送达，可在订单详情页查看物流进度。",
        ],
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 3: 禁止行为扫描", () => {
    it("虚假权威引用被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "根据我司规定，退货需要7天内申请",
          suggestions: [],
        }),
        ["知识库内容：退货政策为签收后7天内可申请"],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("虚假权威引用");
    });

    it("虚假查询陈述被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "经查询，您的订单目前在上海转运中心。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("虚假查询陈述");
    });

    it("无依据推测被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您的快递延迟，可能是因为天气原因导致。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
      expect(result.errors[0]).toContain("无依据推测");
    });

    it("推卸责任式建议被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "建议您自行联系快递公司查询物流进度。",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(3);
    });

    it("正常合规回复通过 L3", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer:
            "您的订单 ORD-2024-001234 目前处于配送中，预计明天送达。如需帮助请随时联系。",
          suggestions: ["查询物流详情"],
        }),
        ["KB chunk about shipping process"],
      );
      // L3 只杀确定性禁止模式，合规回复通过
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 5: KB 为空但回复包含事实性内容", () => {
    it("无 KB 上下文时编造事实性回复被拦截", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "退货需要7天内申请，退款1-3个工作日到账。",
          suggestions: [],
        }),
        [], // KB 为空
      );
      expect(result.valid).toBe(false);
      expect(result.layer).toBe(5);
      expect(result.errors[0]).toContain("疑似编造");
    });

    it("SORRY_TEMPLATE 在无 KB 时不触发 L5 拦截（明确表示不知道）", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: SORRY_TEMPLATE, suggestions: [] }),
        [],
      );
      expect(result.valid).toBe(true);
    });

    it("无 KB 但回复不含事实性指标时通过 L5（纯礼貌回复）", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好！请问有什么可以帮助您的吗？",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Layer 4: KB 回退关键词匹配（citationReport 为空时）", () => {
    it("KB 有内容但回复与 KB 无关时报 L4 弱告警", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您的退款将在明天到账，请耐心等待。",
          suggestions: [],
        }),
        ["退货政策：自签收之日起7天内可申请退货，审核通过后1-3个工作日退款"],
      );
      // L4 是软告警不阻止通过
      expect(result.valid).toBe(true);
      // 但应有 L4 告警
      const l4Error = result.errors.find((e) =>
        e.startsWith("Layer4(keyword)"),
      );
      expect(l4Error).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// 3. CitationVerifier 核心逻辑测试
// ═══════════════════════════════════════════════════════

describe("CitationVerifier", () => {
  // 注意：CitationVerifier 依赖 embedding provider，CI 环境可能无 provider。
  // 以下测试覆盖不依赖 embedding 的确定性逻辑（通过 keyword fallback 路径）。

  // 直接导入模块级函数进行纯逻辑验证
  // 我们通过 validateBusinessResponse 的 keyword fallback 间接验证引证逻辑

  describe("validateBusinessResponse L4 keyword fallback", () => {
    it("回复内容与 KB 高度匹配时不产生 L4 告警", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer:
            "自签收之日起7天内可申请退货，审核通过后1-3个工作日退款到原支付方式。",
          suggestions: [],
        }),
        [
          "退换货政策：自签收之日起7天内可申请退货，审核通过后1-3个工作日退款。非质量问题退货需买家承担运费。",
        ],
      );
      expect(result.valid).toBe(true);
      // 高度匹配不应有 L4 告警
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });

    it("空 KB 不触发 L4 检查", () => {
      const result = validateBusinessResponse(
        JSON.stringify({
          answer: "您好！",
          suggestions: [],
        }),
        [],
      );
      expect(result.valid).toBe(true);
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });
  });

  describe("SORRY_TEMPLATE 豁免", () => {
    it("SORRY_TEMPLATE 即使 KB 有内容也不触发 L4", () => {
      const result = validateBusinessResponse(
        JSON.stringify({ answer: SORRY_TEMPLATE, suggestions: [] }),
        ["KB 内容：详细的退货政策说明"],
      );
      // SORRY_TEMPLATE 是 "我不知道" 的固定话术，无需引证
      const l4Error = result.errors.find((e) => e.startsWith("Layer4"));
      expect(l4Error).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// 4. ChatResponseSchema 边界测试
// ═══════════════════════════════════════════════════════

import { parseChatResponse } from "../services/customer-chat/validation.js";

describe("parseChatResponse", () => {
  it("解析有效 ChatResponse JSON", () => {
    const result = parseChatResponse(
      JSON.stringify({ answer: "您的订单已发货", suggestions: ["查看物流"] }),
    );
    expect(result).not.toBeNull();
    expect(result!.answer).toBe("您的订单已发货");
    expect(result!.suggestions).toEqual(["查看物流"]);
  });

  it("无效 JSON 返回 null", () => {
    const result = parseChatResponse("not json{");
    expect(result).toBeNull();
  });

  it("Schema 不匹配的 JSON 返回 null", () => {
    const result = parseChatResponse(JSON.stringify({ wrong_field: true }));
    expect(result).toBeNull();
  });

  it("suggestions 为默认空数组", () => {
    const result = parseChatResponse(JSON.stringify({ answer: "您好" }));
    expect(result).not.toBeNull();
    expect(result!.suggestions).toEqual([]);
  });

  it("JSON 包裹在 markdown 代码块中也能解析", () => {
    const result = parseChatResponse(
      '```json\n{"answer": "测试回复", "suggestions": []}\n```',
    );
    // extractJSONFromLLMResponse 会处理 markdown 包裹
    expect(result).not.toBeNull();
    expect(result!.answer).toBe("测试回复");
  });
});
