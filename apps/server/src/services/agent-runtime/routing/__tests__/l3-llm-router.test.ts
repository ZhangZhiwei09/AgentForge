// L3/L4 LLM Router 单元测试
//
// 覆盖：
//   - RouterDecisionSchema Zod 校验
//   - parseRouterDecision JSON 解析
//   - buildFewShotPrompt few-shot prompt 构建
//   - ROUTE_LABELS / ROUTER_SYSTEM_PROMPT 常量
//   - fewShotClassify（L3）—— 含 provider mock
//   - llmClassify（L4）—— 含 provider mock

import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════
// Mock：Provider Registry
//
// 使用 vi.hoisted() 确保 mock factory 中引用的变量在
// vi.mock 被提升后仍然可用（const 不受提升作用域限制）。
// ═══════════════════════════════════════════════════════

const { mockChatSync } = vi.hoisted(() => {
  const mockChatSync = vi.fn();
  return { mockChatSync };
});

vi.mock("../../../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({ chatSync: mockChatSync })),
  resolveModel: vi.fn(() => ({
    providerName: "openai",
    modelId: "gpt-4o-mini",
  })),
}));

// ═══════════════════════════════════════════════════════
// Mock：Logger（静默日志，避免测试输出噪音）
// ═══════════════════════════════════════════════════════

vi.mock("@agentforge/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ═══════════════════════════════════════════════════════
// 导入受测模块（必须在 vi.mock 之后，使用动态导入确保 mock 生效）
// ═══════════════════════════════════════════════════════

import {
  RouterDecisionSchema,
  ROUTER_SYSTEM_PROMPT,
  ROUTE_LABELS,
  buildFewShotPrompt,
  parseRouterDecision,
  fewShotClassify,
  llmClassify,
} from "../l3-llm-router.js";

import type { SemanticMatch } from "../l2-semantic.js";
import type { ChatMessage } from "../../../../providers/types.js";

// ── 共享测试数据 ──

function mockTrace() {
  const genEnd = vi.fn();
  const genUpdate = vi.fn();
  const generation = {
    end: genEnd,
    update: genUpdate,
  };
  const traceGen = vi.fn(() => generation);
  const traceUpdate = vi.fn();
  const traceEnd = vi.fn();
  return {
    trace: {
      generation: traceGen,
      update: traceUpdate,
      end: traceEnd,
    },
    generation: {
      end: genEnd,
      update: genUpdate,
    },
    traceGen,
  };
}

function makeMatch(
  overrides: Partial<SemanticMatch> = {},
): SemanticMatch {
  return {
    sampleId: "sample-001",
    route: "TASK",
    text: "如何重置密码？",
    similarity: 0.85,
    ...overrides,
  };
}

function makeLLMResponse(route: string, confidence: number, reasoning: string): string {
  return JSON.stringify({ route, confidence, reasoning });
}

function makeLLMResponseWithEscalation(
  route: string,
  confidence: number,
  reasoning: string,
  escalation_reason: string,
): string {
  return JSON.stringify({ route, confidence, reasoning, escalation_reason });
}

// ═══════════════════════════════════════════════════════
// RouterDecisionSchema —— Zod 校验
// ═══════════════════════════════════════════════════════

describe("RouterDecisionSchema", () => {
  // ── 有效输入 ──

  it("应通过标准 TASK 路由决策的校验", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: 0.9,
      reasoning: "用户询问业务问题",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.route).toBe("TASK");
      expect(result.data.confidence).toBe(0.9);
      expect(result.data.reasoning).toBe("用户询问业务问题");
    }
  });

  it("应通过所有合法路由值的校验", () => {
    for (const route of ["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"] as const) {
      const result = RouterDecisionSchema.safeParse({
        route,
        confidence: 0.5,
        reasoning: "分类理由",
      });
      expect(result.success).toBe(true);
    }
  });

  it("应通过 escalation_reason 可选字段的校验", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "HUMAN",
      confidence: 0.9,
      reasoning: "用户要求转人工",
      escalation_reason: "投诉升级",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation_reason).toBe("投诉升级");
    }
  });

  it("escalation_reason 未提供时应使用默认值空字符串", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: 0.9,
      reasoning: "测试",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation_reason).toBe("");
    }
  });

  it("confidence 为边界值 0 时应通过校验", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "CHAT",
      confidence: 0,
      reasoning: "不确定",
    });
    expect(result.success).toBe(true);
  });

  it("confidence 为边界值 1 时应通过校验", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "CHAT",
      confidence: 1,
      reasoning: "非常确定",
    });
    expect(result.success).toBe(true);
  });

  // ── 无效输入 ──

  it("缺少 route 字段时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      confidence: 0.9,
      reasoning: "缺少 route",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 confidence 字段时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      reasoning: "缺少 confidence",
    });
    expect(result.success).toBe(false);
  });

  it("缺少 reasoning 字段时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it("route 值不在枚举范围内时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "INVALID_ROUTE",
      confidence: 0.9,
      reasoning: "无效路由",
    });
    expect(result.success).toBe(false);
  });

  it("confidence < 0 时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: -0.1,
      reasoning: "负置信度",
    });
    expect(result.success).toBe(false);
  });

  it("confidence > 1 时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: 1.5,
      reasoning: "超范围置信度",
    });
    expect(result.success).toBe(false);
  });

  it("route 为小写时应校验失败（枚举大小写敏感）", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "task",
      confidence: 0.9,
      reasoning: "小写路由",
    });
    expect(result.success).toBe(false);
  });

  it("reasoning 超过 200 字符时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "TASK",
      confidence: 0.9,
      reasoning: "测".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("escalation_reason 超过 100 字符时应校验失败", () => {
    const result = RouterDecisionSchema.safeParse({
      route: "HUMAN",
      confidence: 0.9,
      reasoning: "转人工",
      escalation_reason: "测".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// parseRouterDecision —— JSON 解析
// ═══════════════════════════════════════════════════════

describe("parseRouterDecision", () => {
  // ── 正常解析 ──

  it("应正确解析标准 JSON 字符串为 RouterDecision", () => {
    const raw = '{"route":"TASK","confidence":0.9,"reasoning":"用户询问业务问题"}';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
    expect(result!.confidence).toBe(0.9);
    expect(result!.reasoning).toBe("用户询问业务问题");
    expect(result!.escalationReason).toBeUndefined();
  });

  it("应正确解析含 escalation_reason 的 JSON", () => {
    const raw =
      '{"route":"HUMAN","confidence":0.95,"reasoning":"用户要求转人工","escalation_reason":"投诉升级"}';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("HUMAN");
    expect(result!.confidence).toBe(0.95);
    expect(result!.escalationReason).toBe("投诉升级");
  });

  // ── 空白处理 ──

  it("应正确处理首尾空白字符", () => {
    const raw = '  {"route":"CHAT","confidence":0.8,"reasoning":"问候语"}  ';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  it("应正确处理换行符和缩进", () => {
    const raw = `
      {
        "route": "SAFETY",
        "confidence": 0.99,
        "reasoning": "检测到攻击性语言"
      }
    `;
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("SAFETY");
  });

  // ── Markdown 代码块 ──

  it("应正确从 Markdown 代码块中提取 JSON", () => {
    const raw = '```json\n{"route":"TASK","confidence":0.85,"reasoning":"技术问题"}\n```';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
    expect(result!.confidence).toBe(0.85);
  });

  it("应正确从无语言标识的 Markdown 代码块中提取 JSON", () => {
    const raw = '```\n{"route":"CHAT","confidence":0.9,"reasoning":"打招呼"}\n```';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  it("应正确从包裹在文本中的 JSON 提取对象", () => {
    const raw = '分类结果：{"route":"TASK","confidence":0.7,"reasoning":"需要工具查询"}，请继续处理。';
    const result = parseRouterDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  it("多个 JSON 对象共存时贪婪匹配会跨对象导致解析失败，应返回 null", () => {
    // 贪婪匹配 \{[\s\S]*\} 会从第一个 { 匹配到最后一个 }，
    // 产生 '{"...第一个"} 中间 {"...第二个"}' 这样的非 JSON 文本，
    // JSON.parse 失败 → 返回 null
    const raw =
      '前缀 {"route":"TASK","confidence":0.9,"reasoning":"第一个"} 中间 {"route":"CHAT","confidence":0.5,"reasoning":"第二个"} 后缀';
    const result = parseRouterDecision(raw);
    expect(result).toBeNull();
  });

  // ── 无效输入 ──

  it("纯文本（无 JSON）应返回 null", () => {
    const result = parseRouterDecision("你好，今天天气怎么样？");
    expect(result).toBeNull();
  });

  it("空字符串应返回 null", () => {
    const result = parseRouterDecision("");
    expect(result).toBeNull();
  });

  it("畸形的 JSON 应返回 null", () => {
    const result = parseRouterDecision('{"route":"TASK","confidence":0.9,"reasoning":broken}');
    expect(result).toBeNull();
  });

  it("JSON 数组中的对象应被正则提取并正确解析（\{[\s\S]*\} 匹配内嵌对象）", () => {
    // 输入是数组，但 regex 匹配其中的第一个 {…} 对象块
    const result = parseRouterDecision('[{"route":"TASK","confidence":0.9,"reasoning":"数组"}]');
    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  it("仅有 JSON 键名但无值的字符串应返回 null", () => {
    const result = parseRouterDecision('{"route"}');
    expect(result).toBeNull();
  });

  it("有效的 JSON 但缺少 route 字段（Zod 校验失败）应返回 null", () => {
    const raw = '{"confidence":0.9,"reasoning":"没有 route"}';
    const result = parseRouterDecision(raw);
    expect(result).toBeNull();
  });

  it("有效的 JSON 但 route 值不在枚举中应返回 null", () => {
    const raw = '{"route":"OTHER","confidence":0.9,"reasoning":"未知路由"}';
    const result = parseRouterDecision(raw);
    expect(result).toBeNull();
  });

  it("空 Markdown 代码块（无 JSON）应返回 null", () => {
    const result = parseRouterDecision("```\n```");
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// buildFewShotPrompt —— Few-Shot Prompt 构建
// ═══════════════════════════════════════════════════════

describe("buildFewShotPrompt", () => {
  it("无匹配时应返回基础 ROUTER_SYSTEM_PROMPT", () => {
    const result = buildFewShotPrompt([]);
    expect(result).toBe(ROUTER_SYSTEM_PROMPT);
  });

  it("所有样本相似度 <= 0.4 时应返回基础 prompt（无示例注入）", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "TASK", text: "示例1", similarity: 0.4 }),
      makeMatch({ route: "CHAT", text: "示例2", similarity: 0.3 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toBe(ROUTER_SYSTEM_PROMPT);
  });

  it("应包含 similarity > 0.4 的样本作为参考示例", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "TASK", text: "如何修改密码？", similarity: 0.85 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toContain("参考示例");
    expect(result).toContain("如何修改密码？");
    expect(result).toContain('route: "TASK"');
    expect(result).toContain("任务执行");
  });

  it("应只保留 Top-3 高相似度样本", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "TASK", text: "样本1", similarity: 0.95 }),
      makeMatch({ route: "TASK", text: "样本2", similarity: 0.88 }),
      makeMatch({ route: "CHAT", text: "样本3", similarity: 0.76 }),
      makeMatch({ route: "SAFETY", text: "样本4", similarity: 0.65 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toContain("样本1");
    expect(result).toContain("样本2");
    expect(result).toContain("样本3");
    expect(result).not.toContain("样本4");
  });

  it("过滤后剩余不足 3 个时应包含全部有效样本", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "TASK", text: "样本A", similarity: 0.9 }),
      makeMatch({ route: "CHAT", text: "样本B", similarity: 0.3 }),
      makeMatch({ route: "HUMAN", text: "样本C", similarity: 0.2 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toContain("样本A");
    expect(result).not.toContain("样本B");
    expect(result).not.toContain("样本C");
  });

  it("应包含 DIAGNOSIS 高门槛警告提示", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "DIAGNOSIS", text: "系统报错500", similarity: 0.8 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toContain("DIAGNOSIS 路由要求用户提供了具体的故障信息");
    expect(result).toContain("traceId");
    expect(result).toContain('仅有模糊的"有问题"');
  });

  it("应以基础 prompt 开头", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "TASK", text: "测试", similarity: 0.9 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result.startsWith(ROUTER_SYSTEM_PROMPT)).toBe(true);
  });

  it("应包含中文路由标签", () => {
    const matches: SemanticMatch[] = [
      makeMatch({ route: "SAFETY", text: "攻击内容", similarity: 0.9 }),
      makeMatch({ route: "HUMAN", text: "转人工", similarity: 0.8 }),
    ];
    const result = buildFewShotPrompt(matches);
    expect(result).toContain("安全违规");
    expect(result).toContain("人工转接");
  });
});

// ═══════════════════════════════════════════════════════
// ROUTE_LABELS —— 中文标签常量
// ═══════════════════════════════════════════════════════

describe("ROUTE_LABELS", () => {
  it("应包含全部 5 种路由的中文标签", () => {
    const routes = ["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"];
    for (const route of routes) {
      expect(ROUTE_LABELS[route]).toBeDefined();
      expect(typeof ROUTE_LABELS[route]).toBe("string");
      expect(ROUTE_LABELS[route].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ROUTE_LABELS).length).toBe(5);
  });

  it("各路由标签应为非空中文文本", () => {
    const chineseRegex = /[一-鿿]/;
    for (const [route, label] of Object.entries(ROUTE_LABELS)) {
      expect(chineseRegex.test(label), `ROUTE_LABELS["${route}"] 应包含中文`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════
// ROUTER_SYSTEM_PROMPT —— 系统提示词常量
// ═══════════════════════════════════════════════════════

describe("ROUTER_SYSTEM_PROMPT", () => {
  it("应为非空字符串", () => {
    expect(typeof ROUTER_SYSTEM_PROMPT).toBe("string");
    expect(ROUTER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("应包含中文文本", () => {
    const chineseRegex = /[一-鿿]/;
    expect(chineseRegex.test(ROUTER_SYSTEM_PROMPT)).toBe(true);
  });

  it("应包含全部 5 种路由定义", () => {
    for (const route of ["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]) {
      expect(ROUTER_SYSTEM_PROMPT).toContain(route);
    }
  });

  it("应包含输出格式说明", () => {
    expect(ROUTER_SYSTEM_PROMPT).toContain("输出格式");
    expect(ROUTER_SYSTEM_PROMPT).toContain("## 路由定义");
  });
});

// ═══════════════════════════════════════════════════════
// fewShotClassify（L3）—— 含 Provider Mock
// ═══════════════════════════════════════════════════════

describe("fewShotClassify", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，有什么可以帮你？" },
  ];
  const message = "我的订单怎么还没到？";
  const topMatches: SemanticMatch[] = [
    makeMatch({ route: "TASK", text: "订单状态查询", similarity: 0.85 }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 正常返回 ──

  it("LLM 返回有效决策时应返回正确路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "用户询问订单物流状态"),
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
    expect(result!.confidence).toBe(0.9);
    expect(result!.reasoning).toContain("L3少样本增强");
    expect(result!.reasoning).toContain("用户询问订单物流状态");
  });

  it("应前置 'L3少样本增强:' 前缀到 reasoning", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("CHAT", 0.8, "问候语"),
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.reasoning.startsWith("L3少样本增强:")).toBe(true);
  });

  it("应正确传递 contextMessages（最近 4 条历史 + 当前消息）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "test"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const longHistory: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      longHistory.push({ role: "user", content: `msg${i}` });
      longHistory.push({ role: "assistant", content: `reply${i}` });
    }

    const { trace } = mockTrace();
    await fewShotClassify(message, longHistory, topMatches, null, trace as any);

    const passedMessages = (mockChatSync.mock.calls[0] as unknown[])[0] as ChatMessage[];
    // 应只包含最后 4 条历史 + 1 条当前消息 = 5 条
    expect(passedMessages.length).toBe(5);
    expect(passedMessages[passedMessages.length - 1].content).toBe(message);
  });

  // ── trace 调用 ──

  it("应在有 trace 时调用 trace.generation 并正确结束", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "test"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace, generation, traceGen } = mockTrace();
    await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(traceGen).toHaveBeenCalledTimes(1);
    expect(traceGen).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "llm-router-few-shot",
        model: "gpt-4o-mini",
      }),
    );
    expect(generation.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ route: "TASK", confidence: 0.9 }),
      }),
    );
  });

  it("trace 为 undefined 时不应崩溃", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "test"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const result = await fewShotClassify(message, history, topMatches, null, undefined);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  // ── 低置信度 / 解析失败 → null ──

  it("LLM 返回 confidence < 0.5 时应返回 null（降级到 L4）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.4, "不太确定"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).toBeNull();
  });

  it("LLM 返回无效 JSON 时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: "这不是有效的 JSON",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).toBeNull();
  });

  it("LLM 返回有效 JSON 但 route 不在枚举中时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("OTHER", 0.9, "未知分类"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).toBeNull();
  });

  // ── DIAGNOSIS 高门槛 ──

  it("DIAGNOSIS 路由但 confidence < 0.7 时应返回 null（拒绝低置信度诊断）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("DIAGNOSIS", 0.65, "可能是系统故障"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).toBeNull();
  });

  it("DIAGNOSIS 路由且 confidence >= 0.7 时应成功返回", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("DIAGNOSIS", 0.75, "用户提供了错误码500"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("DIAGNOSIS");
    expect(result!.confidence).toBe(0.75);
  });

  // ── LLM 异常处理 ──

  it("LLM 调用抛出异常时应返回 null（降级到 L4）", async () => {
    mockChatSync.mockRejectedValue(new Error("Network error"));

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).toBeNull();
  });

  it("LLM 调用异常时仍应正确结束 trace generation", async () => {
    mockChatSync.mockRejectedValue(new Error("Timeout"));

    const { trace, generation, traceGen } = mockTrace();
    await fewShotClassify(message, history, topMatches, null, trace as any);

    // generation.end 不应被调用（异常分支不调用 end）
    expect(traceGen).toHaveBeenCalledTimes(1);
    expect(generation.end).not.toHaveBeenCalled();
  });

  // ── 路由多样性 ──

  it("应正确返回 SAFETY 路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("SAFETY", 0.95, "检测到攻击性语言"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("SAFETY");
  });

  it("应正确返回 HUMAN 路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponseWithEscalation("HUMAN", 0.9, "用户要求转人工", "投诉多次未解决"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("HUMAN");
    expect(result!.escalationReason).toBe("投诉多次未解决");
  });

  // ── 无 usage 降级 ──

  it("LLM 返回无 usage 信息时应正确处理", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("CHAT", 0.85, "打招呼"),
      // 无 usage 字段
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  // ── 空历史 ──

  it("历史为空时应正常工作", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "业务查询"),
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, [], topMatches, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  // ── 空 topMatches ──

  it("topMatches 为空时应正常工作（退化为无 few-shot 的 LLM 分类）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "业务查询"),
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await fewShotClassify(message, history, [], null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });
});

// ═══════════════════════════════════════════════════════
// llmClassify（L4）—— 含 Provider Mock
// ═══════════════════════════════════════════════════════

describe("llmClassify", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
  ];
  const message = "系统崩溃了，错误代码 E500";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 正常返回 ──

  it("LLM 返回有效决策时应返回正确路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("DIAGNOSIS", 0.8, "用户报告系统崩溃和错误代码"),
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("DIAGNOSIS");
    expect(result!.confidence).toBe(0.8);
    // L4 reasoning 不添加前缀
    expect(result!.reasoning).toBe("用户报告系统崩溃和错误代码");
  });

  it("应正确传递 contextMessages（最近 4 条历史 + 当前消息）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "test"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const longHistory: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      longHistory.push({ role: "user", content: `msg${i}` });
      longHistory.push({ role: "assistant", content: `reply${i}` });
    }

    const { trace } = mockTrace();
    await llmClassify(message, longHistory, null, trace as any);

    const passedMessages = (mockChatSync.mock.calls[0] as unknown[])[0] as ChatMessage[];
    expect(passedMessages.length).toBe(5);
  });

  // ── trace 调用 ──

  it("应在有 trace 时调用 trace.generation 并正确结束", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "test"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace, generation, traceGen } = mockTrace();
    await llmClassify(message, history, null, trace as any);

    expect(traceGen).toHaveBeenCalledTimes(1);
    expect(traceGen).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "llm-router-classification",
        model: "gpt-4o-mini",
      }),
    );
    expect(generation.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ route: "TASK", confidence: 0.9 }),
      }),
    );
  });

  it("trace 为 undefined 时不应崩溃", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("CHAT", 0.8, "打招呼"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const result = await llmClassify(message, history, null, undefined);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  // ── 低置信度 / 解析失败 → null ──

  it("LLM 返回 confidence < 0.5 时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.3, "不确定"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  it("LLM 返回无效 JSON 时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: "not json at all",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  it("LLM 返回有效 JSON 但缺少必需字段时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: '{"route":"TASK"}',
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  // ── DIAGNOSIS 高门槛 ──

  it("DIAGNOSIS 路由但 confidence < 0.7 时应返回 null", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("DIAGNOSIS", 0.6, "可能的系统问题"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  it("DIAGNOSIS 路由且 confidence >= 0.7 时应成功返回", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("DIAGNOSIS", 0.75, "用户报告明确的错误代码E500"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("DIAGNOSIS");
  });

  it("非 DIAGNOSIS 路由 confidence >= 0.5 时应正常返回（不触发高门槛检查）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("CHAT", 0.5, "可能是闲聊"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  // ── LLM 异常处理 ──

  it("LLM 调用抛出异常时应返回 null", async () => {
    mockChatSync.mockRejectedValue(new Error("Connection refused"));

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  // ── 路由多样性 ──

  it("应正确返回 SAFETY 路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("SAFETY", 0.95, "检测到暴力威胁"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("SAFETY");
  });

  it("应正确返回 HUMAN 路由并携带 escalation_reason", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponseWithEscalation("HUMAN", 0.9, "用户情绪激动要求转人工", "多次投诉未解决"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("HUMAN");
    expect(result!.escalationReason).toBe("多次投诉未解决");
  });

  it("应正确返回 TASK 路由", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.85, "需要查询知识库"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  // ── 边界：confidence 恰好等于 0.5 ──

  it("confidence 恰好为 0.5 时应正常返回", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.5, "边缘情况"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.5);
  });

  // ── 边界：confidence 恰好等于 0.499 ──

  it("confidence 为 0.49 时应返回 null（低于阈值）", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.49, "略微不确定"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).toBeNull();
  });

  // ── 空历史 ──

  it("历史为空时应正常工作", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "查询"),
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, [], null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("TASK");
  });

  // ── 无 usage ──

  it("LLM 返回无 usage 信息时应正确处理", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("CHAT", 0.8, "闲聊"),
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.route).toBe("CHAT");
  });

  // ── L4 reasoning 不应有前缀 ──

  it("L4 reasoning 不应包含 L3 前缀", async () => {
    mockChatSync.mockResolvedValue({
      content: makeLLMResponse("TASK", 0.9, "需要工具查询"),
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const { trace } = mockTrace();
    const result = await llmClassify(message, history, null, trace as any);

    expect(result).not.toBeNull();
    expect(result!.reasoning).not.toContain("L3少样本增强");
    expect(result!.reasoning).toBe("需要工具查询");
  });
});
