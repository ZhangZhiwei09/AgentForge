import { describe, it, expect } from "vitest";
import {
  OrderCardDataSchema,
  PolicyCardDataSchema,
  ActionCardDataSchema,
  StatusCardDataSchema,
  TableBlockDataSchema,
} from "../protocol/schemas";

describe("OrderCardDataSchema", () => {
  it("validates a complete order", () => {
    const result = OrderCardDataSchema.safeParse({
      orderId: "ORD-001",
      status: "shipped",
      statusLabel: "已发货",
      items: [{ name: "商品A", quantity: 2, price: 99.0 }],
      total: 198.0,
      createdAt: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = OrderCardDataSchema.safeParse({ orderId: "123" });
    expect(result.success).toBe(false);
  });

  it("accepts optional fields", () => {
    const result = OrderCardDataSchema.safeParse({
      orderId: "ORD-002",
      status: "delivered",
      statusLabel: "已送达",
      items: [],
      total: 0,
      createdAt: "2026-06-01",
      carrier: "顺丰",
      trackingNo: "SF123456",
    });
    expect(result.success).toBe(true);
  });
});

describe("PolicyCardDataSchema", () => {
  it("validates a complete policy", () => {
    const result = PolicyCardDataSchema.safeParse({
      category: "退换货政策",
      title: "7天无理由退货",
      conditions: ["商品完好", "不影响二次销售"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional exceptions", () => {
    const result = PolicyCardDataSchema.safeParse({
      category: "售后",
      title: "保修政策",
      conditions: ["非人为损坏"],
      exceptions: ["屏幕碎裂不在保修范围"],
    });
    expect(result.success).toBe(true);
  });
});

describe("ActionCardDataSchema", () => {
  it("validates valid action card", () => {
    const result = ActionCardDataSchema.safeParse({
      title: "您可能需要",
      description: "",
      actions: [{ label: "查询订单", action: "lookup_order" }],
    });
    expect(result.success).toBe(true);
  });

  it("validates action with style", () => {
    const result = ActionCardDataSchema.safeParse({
      title: "确认操作",
      description: "是否确认退款？",
      actions: [
        { label: "确认退款", action: "confirm_refund", style: "danger" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid style", () => {
    const result = ActionCardDataSchema.safeParse({
      title: "Test",
      description: "",
      actions: [{ label: "X", action: "x", style: "unknown" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("StatusCardDataSchema", () => {
  it("validates status with steps", () => {
    const result = StatusCardDataSchema.safeParse({
      title: "物流追踪",
      status: "in_progress",
      steps: [
        { label: "已揽收", status: "done" },
        { label: "运输中", status: "active" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = StatusCardDataSchema.safeParse({
      title: "Test",
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });
});

describe("TableBlockDataSchema", () => {
  it("validates a table", () => {
    const result = TableBlockDataSchema.safeParse({
      headers: ["类目", "价格"],
      rows: [["电子产品", "¥99"], ["服装", "¥199"]],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional caption", () => {
    const result = TableBlockDataSchema.safeParse({
      headers: ["名称"],
      rows: [["A"]],
      caption: "产品列表",
    });
    expect(result.success).toBe(true);
  });
});
