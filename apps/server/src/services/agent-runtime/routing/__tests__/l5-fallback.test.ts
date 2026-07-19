// L5 Regex Fallback 单元测试
//
// 覆盖：
//   - INTENT_TO_ROUTE 映射常量校验
//   - fallbackClassify() 各输入场景的 route 正确性
//   - confidence / reasoning 输出验证
//   - 边界：空字符串、未知消息、RouteName 有效性

import { describe, it, expect } from "vitest";
import { fallbackClassify, INTENT_TO_ROUTE } from "../l5-fallback.js";
import type { RouteName } from "../../types.js";

const VALID_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  "SAFETY",
  "CHAT",
  "TASK",
  "HUMAN",
  "DIAGNOSIS",
]);

// ═══════════════════════════════════════════════════════
// INTENT_TO_ROUTE — 映射常量校验
// ═══════════════════════════════════════════════════════

describe("INTENT_TO_ROUTE", () => {
  // ── 每个 key 映射到合法的 RouteName ──

  it("每个 key 都应映射到合法的 RouteName", () => {
    for (const [intent, route] of Object.entries(INTENT_TO_ROUTE)) {
      expect(
        VALID_ROUTES.has(route),
        `Intent "${intent}" maps to "${route}", which is not a valid RouteName`
      ).toBe(true);
    }
  });

  // ── 无重复 / 冲突映射 ──

  it("不应存在重复或冲突的映射条目（每个 intent 仅出现一次）", () => {
    // JS 对象天然不允许重复 key，此处验证映射表结构的正确性：
    // 所有 key 必须为 string，所有 value 必须为有效 RouteName
    const keys = Object.keys(INTENT_TO_ROUTE);
    const uniqueKeys = new Set(keys);

    expect(keys.length).toBe(uniqueKeys.size);

    for (const route of Object.values(INTENT_TO_ROUTE)) {
      expect(
        VALID_ROUTES.has(route),
        `Route value "${route}" is not a valid RouteName`
      ).toBe(true);
    }
  });

  // ── 遍历每个映射条目，验证键值对应关系 ──

  it("应包含所有预期的意图到路由映射", () => {
    expect(INTENT_TO_ROUTE["退货退款"]).toBe("TASK");
    expect(INTENT_TO_ROUTE["物流查询"]).toBe("TASK");
    expect(INTENT_TO_ROUTE["售后联系"]).toBe("HUMAN");
    expect(INTENT_TO_ROUTE["账户会员"]).toBe("TASK");
    expect(INTENT_TO_ROUTE["支付订单"]).toBe("TASK");
    expect(INTENT_TO_ROUTE["其他咨询"]).toBe("TASK");
  });

  it('仅「售后联系」应映射到 HUMAN，其余均为 TASK', () => {
    for (const [intent, route] of Object.entries(INTENT_TO_ROUTE)) {
      if (intent === "售后联系") {
        expect(route).toBe("HUMAN");
      } else {
        expect(route).toBe("TASK");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// fallbackClassify — 分类逻辑
// ═══════════════════════════════════════════════════════

describe("fallbackClassify", () => {
  // ── 退货退款类 → TASK ──

  it('"退换货" 应分类为 TASK（命中退货退款意图）', () => {
    const result = fallbackClassify("退换货");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("退货退款");
  });

  it('"我要退货" 应分类为 TASK（命中退货退款意图）', () => {
    const result = fallbackClassify("我要退货");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("退货退款");
  });

  // ── 订单 / 支付类 → TASK ──

  it('"订单查询" 应分类为 TASK（命中支付订单意图）', () => {
    const result = fallbackClassify("订单查询");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("支付订单");
  });

  it('"怎么支付" 应分类为 TASK（命中支付订单意图）', () => {
    const result = fallbackClassify("怎么支付");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("支付订单");
  });

  // ── 物流类 → TASK ──

  it('"查物流" 应分类为 TASK（命中物流查询意图）', () => {
    const result = fallbackClassify("查物流");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("物流查询");
  });

  // ── 账户会员类 → TASK ──

  it('"会员积分怎么查" 应分类为 TASK（命中账户会员意图）', () => {
    const result = fallbackClassify("会员积分怎么查");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("账户会员");
  });

  // ── 售后联系类 → HUMAN ──

  it('"投诉" 应分类为 HUMAN（命中售后联系意图）', () => {
    const result = fallbackClassify("投诉");
    expect(result.route).toBe("HUMAN");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("售后联系");
  });

  it('"转接人工" 应分类为 HUMAN（命中售后联系意图）', () => {
    const result = fallbackClassify("转接人工");
    expect(result.route).toBe("HUMAN");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("售后联系");
  });

  it('"我要找客服" 应分类为 HUMAN（命中售后联系意图）', () => {
    const result = fallbackClassify("我要找客服");
    expect(result.route).toBe("HUMAN");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("售后联系");
  });

  it('"你们客服电话多少" 应分类为 HUMAN（命中售后联系意图）', () => {
    const result = fallbackClassify("你们客服电话多少");
    expect(result.route).toBe("HUMAN");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("售后联系");
  });

  // ── 未知消息 / 兜底 → TASK ──

  it('未知消息 "今天天气怎么样" 应兜底为 TASK（命中其他咨询意图）', () => {
    const result = fallbackClassify("今天天气怎么样");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("其他咨询");
  });

  it('无意义消息 "abcdefg" 应兜底为 TASK', () => {
    const result = fallbackClassify("abcdefg");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("其他咨询");
  });

  // ── 空字符串 → TASK（安全默认） ──

  it("空字符串应安全兜底为 TASK", () => {
    const result = fallbackClassify("");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("其他咨询");
  });

  // ── confidence 数值校验 ──

  it("匹配到单个关键词时 confidence 应为 0.7", () => {
    // "退货" 仅命中退货退款中的一个关键词
    const result = fallbackClassify("退货");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0.7);
  });

  it('匹配到单个关键词时 confidence 应为 0.7（regex 无 g flag，每次仅返回首个匹配）', () => {
    // "退货退款" 命中退货退款 regex，但无 g flag，match() 仅返回首个匹配
    const result = fallbackClassify("退货退款");
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0.7);
  });

  it("未匹配时 confidence 应为 0", () => {
    const result = fallbackClassify("今天天气怎么样");
    expect(result.confidence).toBe(0);
  });

  // ── reasoning 格式校验 ──

  it("reasoning 应包含 fallback 标识和意图名称", () => {
    const result = fallbackClassify("我要退货");
    expect(result.reasoning).toMatch(/^IntentDetector fallback: /);
    expect(result.reasoning).toMatch(/\(confidence: \d\.\d{2}\)/);
  });

  it("reasoning 应包含两位小数的 confidence", () => {
    const result = fallbackClassify("退货退款");
    const match = result.reasoning.match(/\(confidence: (\d\.\d{2})\)/);
    expect(match).not.toBeNull();
    if (match) {
      // 验证 confidence 与 reasoning 中的数值一致
      const reasoningConfidence = parseFloat(match[1]);
      expect(reasoningConfidence).toBe(result.confidence);
    }
  });

  // ── 返回值始终包含合法 RouteName ──

  it("任意输入均应返回合法的 RouteName", () => {
    const inputs = [
      "退货退款",
      "查物流",
      "投诉",
      "转人工",
      "订单",
      "会员",
      "今天天气怎么样",
      "",
      "hello world",
      "12345",
    ];

    for (const input of inputs) {
      const result = fallbackClassify(input);
      expect(
        VALID_ROUTES.has(result.route),
        `Input "${input}" returned invalid route "${result.route}"`
      ).toBe(true);
    }
  });

  // ── 参数化：遍历 INTENT_TO_ROUTE 每个 entry，验证一致性 ──

  it("每个 INTENT_TO_ROUTE 的 intent 都应能被正确路由", () => {
    // 为每个 intent 提供一个能触发它的最小输入
    const triggerInputs: Record<string, string> = {
      退货退款: "我要退货",
      物流查询: "查物流",
      售后联系: "我要投诉",
      账户会员: "查会员积分",
      支付订单: "订单支付问题",
      其他咨询: "今天天气怎么样",
    };

    for (const [intent, expectedRoute] of Object.entries(INTENT_TO_ROUTE)) {
      const input = triggerInputs[intent];
      expect(input).toBeDefined(); // 确保触发器存在

      const result = fallbackClassify(input!);
      expect(
        result.route,
        `Intent "${intent}" with input "${input}" should route to "${expectedRoute}", got "${result.route}"`
      ).toBe(expectedRoute);
    }
  });

  // ── 返回值结构完整性 ──

  it("返回值应包含 route、confidence、reasoning 三个字段", () => {
    const result = fallbackClassify("测试消息");

    expect(result).toHaveProperty("route");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("reasoning");

    expect(typeof result.route).toBe("string");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.reasoning).toBe("string");
  });

  it("confidence 应为 0 到 1 之间的数字", () => {
    const inputs = [
      "退货退款",
      "物流查询",
      "投诉",
      "会员",
      "订单",
      "天气",
      "",
    ];

    for (const input of inputs) {
      const result = fallbackClassify(input);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  // ── escalationReason 字段不要求（HUMAN 路由也不强制） ──

  it("HUMAN 路由时 escalationReason 可为 undefined", () => {
    const result = fallbackClassify("投诉");
    expect(result.route).toBe("HUMAN");
    // escalationReason 是可选的，fallback 不负责填充它
    expect(result.escalationReason).toBeUndefined();
  });
});
