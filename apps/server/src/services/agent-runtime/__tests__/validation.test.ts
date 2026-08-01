// Business Response Validation 单元测试
//
// 覆盖 5 层校验管线：
//   L1: JSON 可解析
//   L2: Zod Schema 校验
//   L3: 禁止行为扫描
//   L4: Citation 引证校验
//   L5: 事实性声明检查（KB 为空时防编造）
//
// 额外覆盖：parseChatResponse、固定话术常量、FORBIDDEN_PATTERNS

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateBusinessResponse,
  parseChatResponse,
  SORRY_TEMPLATE,
  FALLBACK_PREFIX,
  ChatResponseSchema,
  FORBIDDEN_PATTERNS,
} from "../validation.js";
import type { CitationReport } from "../citation-verifier.js";

// ── Mock 设置 ──

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("@agentforge/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      warn: mockLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

// 将 extractJSONFromLLMResponse mock 为透传，隔离 JSON 提取逻辑
const mockExtractJSON = vi.hoisted(() =>
  vi.fn((raw: string) => raw),
);

vi.mock("../../lib/json-utils.js", () => ({
  extractJSONFromLLMResponse: mockExtractJSON,
}));

// ── 辅助工厂函数 ──

function makeCitationReport(
  overrides: Partial<CitationReport> = {},
): CitationReport {
  return {
    sentences: [],
    coverageRate: 1.0,
    avgScore: 0.95,
    level: "embedding",
    weakSentenceIndices: [],
    ...overrides,
  };
}

function citedSentence(
  text: string,
  status: "cited" | "weak_citation" | "uncited" = "cited",
) {
  return {
    text,
    isFactual: true,
    bestScore: status === "cited" ? 0.92 : status === "weak_citation" ? 0.62 : 0.3,
    bestChunkIndex: 0,
    bestChunkPreview: "匹配的 KB 片段...",
    status,
  };
}

function nonFactualSentence(text: string) {
  return {
    text,
    isFactual: false,
    bestScore: 1.0,
    bestChunkIndex: -1,
    bestChunkPreview: "",
    status: "cited" as const,
  };
}

// ── 测试 ──

describe("validateBusinessResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: 有效响应通过全部校验层 ──

  it("valid JSON response with answer and suggestions passes all validation layers", () => {
    const rawText = JSON.stringify({
      answer: "您好，有什么可以帮助您的？",
      suggestions: ["如何充值", "如何退款"],
    });
    // 空 KB + 纯问候语（无事实性指标）→ 通过所有校验层，无 L4/L5 告警
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.layer).toBe(0);
  });

  // ── Test 2: JSON 格式但 answer 为空 → Layer 2 Schema 校验失败 ──

  it("rejects JSON response with empty answer at Layer 2 (schema validation)", () => {
    const rawText = JSON.stringify({ answer: "", suggestions: [] });
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Layer2");
    expect(result.errors[0]).toContain("Schema校验失败");
    expect(result.errors[0]).toContain("answer");
  });

  // ── Test 3: JSON 格式但缺少必填字段 → Layer 2 Schema 校验失败 ──

  it("rejects JSON response missing required answer field at Layer 2", () => {
    const rawText = JSON.stringify({ suggestions: ["你好"] });
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(2);
    expect(result.errors[0]).toContain("Layer2");
  });

  // ── Test 4: answer 超过 2000 字符 → Layer 2 Schema 校验失败 ──

  it("rejects answer exceeding 2000 characters at Layer 2", () => {
    const longAnswer = "A".repeat(2001);
    const rawText = JSON.stringify({ answer: longAnswer });
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(2);
    expect(result.errors[0]).toContain("Layer2");
  });

  // ── Test 5: suggestions 超过 3 个 → Layer 2 Schema 校验失败 ──

  it("rejects response with more than 3 suggestions at Layer 2", () => {
    const rawText = JSON.stringify({
      answer: "有效回答",
      suggestions: ["一", "二", "三", "四"],
    });
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(2);
    expect(result.errors[0]).toContain("Layer2");
  });

  // ── Test 6: suggestions 默认值生效（不传 suggestions 时默认为空数组） ──

  it("treats missing suggestions as empty array (Zod default)", () => {
    const rawText = JSON.stringify({ answer: "有效回答" });
    const knowledgeChunks = ["有效回答"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(true);
  });

  // ── Test 7: 禁止行为 —— 虚假权威引用 ──

  it("rejects response containing forbidden pattern: 虚假权威引用 at Layer 3", () => {
    const rawText = JSON.stringify({
      answer: "根据我司规定，您的账户已被冻结。",
      suggestions: [],
    });
    const knowledgeChunks = ["账户管理政策"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("Layer3");
    expect(result.errors[0]).toContain("虚假权威引用");
  });

  // ── Test 8: 禁止行为 —— 虚假查询陈述 ──

  it("rejects response containing forbidden pattern: 虚假查询陈述 at Layer 3", () => {
    const rawText = JSON.stringify({
      answer: "经查询后台数据库，未发现您的订单记录。",
      suggestions: [],
    });
    const knowledgeChunks = ["订单查询说明"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("虚假查询陈述");
  });

  // ── Test 9: 禁止行为 —— 无依据推测原因 ──

  it("rejects response containing forbidden pattern: 无依据推测原因 at Layer 3", () => {
    const rawText = JSON.stringify({
      answer: "这可能是由于网络波动导致的连接超时。",
      suggestions: [],
    });
    const knowledgeChunks = ["网络问题排查"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("无依据推测原因");
  });

  // ── Test 10: 禁止行为 —— 推卸责任式建议 ──

  it("rejects response containing forbidden pattern: 推卸责任式建议 at Layer 3", () => {
    const rawText = JSON.stringify({
      answer: "建议您自行查阅相关文档解决此问题。",
      suggestions: [],
    });
    const knowledgeChunks = ["文档链接"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("推卸责任式建议");
  });

  // ── Test 11: 多个禁止模式同时命中 ──

  it("reports all forbidden patterns when multiple match", () => {
    const rawText = JSON.stringify({
      answer:
        "根据平台规定，您的账户存在异常。可能是由于密码泄露。建议您自行修改密码。",
      suggestions: [],
    });
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("虚假权威引用");
    expect(result.errors[0]).toContain("无依据推测原因");
    expect(result.errors[0]).toContain("推卸责任式建议");
  });

  // ── Test 12: 非 JSON 格式文本直接进入 Layer 3+ 校验 ──

  it("falls through JSON parsing for non-JSON text and checks Layer 3+", () => {
    const rawText = "根据公司规定，您的订单已取消。";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    // 非 JSON 文本也能命中禁止行为扫描
    expect(result.valid).toBe(false);
    expect(result.layer).toBe(3);
    expect(result.errors[0]).toContain("虚假权威引用");
    // JSON 解析失败时应记录 warn 日志
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  // ── Test 13: Layer 5 — KB 为空但回复包含事实性内容 → 疑似编造 ──

  it("rejects response with factual claims when KB is empty at Layer 5 (数字+时间)", () => {
    const rawText = "该功能将在3个工作日内部署完成。";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(5);
    expect(result.errors[0]).toContain("Layer5");
    expect(result.errors[0]).toContain("疑似编造");
  });

  // ── Test 14: Layer 5 — KB 为空 + 金额/折扣相关 → 疑似编造 ──

  it("rejects response with price/amount claims when KB is empty at Layer 5", () => {
    const rawText = "该服务费用为500元，当前可享受8折优惠。";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(5);
    expect(result.errors[0]).toContain("Layer5");
  });

  // ── Test 15: Layer 5 — KB 为空 + 行业术语 → 疑似编造 ──

  it("rejects response with domain terminology when KB is empty at Layer 5", () => {
    const rawText = "请检查您的配置策略和部署状态，确认权限审批流程是否正常。";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(false);
    expect(result.layer).toBe(5);
  });

  // ── Test 16: 返回结构 { valid, errors[], layer } ──

  it("returns correct ValidationResult shape", () => {
    const result = validateBusinessResponse(
      JSON.stringify({ answer: "你好" }),
      [],
    );

    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("layer");
    expect(typeof result.valid).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.layer).toBe("number");
  });

  // ── Test 17: 有效 CitationReport — 全部句子有引证 → 通过 ──

  it("passes when citation report shows all factual sentences are cited", () => {
    const rawText = JSON.stringify({ answer: "配置需重启实例后生效。" });
    const knowledgeChunks = [
      "修改配置后需要重启实例才能生效，这是系统的设计要求。",
    ];
    const citationReport = makeCitationReport({
      sentences: [
        citedSentence("配置需重启实例后生效。", "cited"),
      ],
      coverageRate: 1.0,
      avgScore: 0.95,
      weakSentenceIndices: [],
    });

    const result = validateBusinessResponse(
      rawText,
      knowledgeChunks,
      citationReport,
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── Test 18: 低引证覆盖率 — 存在 uncited 事实性句子 → Layer 4 软告警 ──

  it("adds Layer 4 soft warning when citation report has uncited factual sentences", () => {
    const rawText = JSON.stringify({
      answer: "系统支持自动扩容。最大可扩容至100个节点。",
    });
    const knowledgeChunks = ["系统支持自动扩容功能，用户可在控制台配置。"];
    const citationReport = makeCitationReport({
      sentences: [
        citedSentence("系统支持自动扩容。", "cited"),
        citedSentence("最大可扩容至100个节点。", "uncited"),
      ],
      coverageRate: 0.5,
      avgScore: 0.5,
      weakSentenceIndices: [1],
    });

    const result = validateBusinessResponse(
      rawText,
      knowledgeChunks,
      citationReport,
    );

    // L4 是软告警，valid 仍为 true
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("Layer4"))).toBe(true);
    expect(result.errors.some((e) => e.includes("无引证来源"))).toBe(true);
  });

  // ── Test 19: 低引证覆盖率 — 存在 weak_citation 句子 → Layer 4 软告警 ──

  it("adds Layer 4 soft warning when citation report has weak_citation sentences", () => {
    const rawText = JSON.stringify({
      answer: "建议您使用新版本部署。需要审批后才能发布。",
    });
    const knowledgeChunks = ["部署流程涉及审批环节，审批完成后自动发布。"];
    const citationReport = makeCitationReport({
      sentences: [
        citedSentence("建议您使用新版本部署。", "weak_citation"),
        citedSentence("需要审批后才能发布。", "weak_citation"),
      ],
      coverageRate: 0,
      avgScore: 0.5,
      weakSentenceIndices: [0, 1],
    });

    const result = validateBusinessResponse(
      rawText,
      knowledgeChunks,
      citationReport,
    );

    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.includes("引证较弱"))).toBe(true);
    expect(result.errors.some((e) => e.includes("coverage="))).toBe(true);
    expect(result.errors.some((e) => e.includes("avg_score="))).toBe(true);
    expect(result.errors.some((e) => e.includes("level="))).toBe(true);
  });

  // ── Test 20: 无 citationReport — 关键词回退：命中率正常 → 无告警 ──

  it("falls back to keyword matching when no citationReport provided and KB hit rate is sufficient", () => {
    const rawText = JSON.stringify({
      answer: "退款流程需要先提交申请，然后等待审批，审批通过后3个工作日到账。",
    });
    const knowledgeChunks = [
      "退款流程：用户提交退款申请后等待审批，审批通过后退款金额将在3个工作日到账。",
    ];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(true);
    // 关键词命中率足够高，无 L4 告警
    expect(result.errors.filter((e) => e.includes("Layer4")).length).toBe(0);
  });

  // ── Test 21: 无 citationReport — 关键词回退：命中率过低 → Layer 4 警告 ──

  it("adds Layer 4 keyword fallback warning when KB hit rate is below 50%", () => {
    const rawText = JSON.stringify({
      answer: "量子计算驱动的AI模型优化方案已部署。",
    });
    const knowledgeChunks = [
      "普通服务器维护流程：定期检查磁盘空间和网络连接状态。",
    ];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    // 关键词完全不重叠 → 命中率 0%
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.includes("Layer4(keyword)"))).toBe(true);
    expect(result.errors.some((e) => e.includes("KB命中率过低"))).toBe(true);
  });

  // ── Test 22: KB 为空 + 无事实性指示词 → 宽松模式，不误报 ──

  it("does not trigger Layer 5 when KB is empty but answer has no factual indicators (relaxed validation)", () => {
    const rawText = "您好，请问有什么可以帮助您的吗？";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    // 纯问候语，无数字、无业务关键词 → 不应触发 Layer 5
    expect(result.valid).toBe(true);
  });

  // ── Test 23: KB 为空 + 纯情感回复 → 宽松模式，不误报 ──

  it("does not trigger Layer 5 when KB is empty and answer is purely conversational", () => {
    const rawText = "感谢您的耐心等待，我们会尽快处理您的问题。";
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(true);
  });

  // ── Test 24: SORRY_TEMPLATE 固定话术 → 跳过 L4/L5 ──

  it("skips Layer 4 and Layer 5 when answer matches SORRY_TEMPLATE", () => {
    const knowledgeChunks: string[] = [];

    const result = validateBusinessResponse(SORRY_TEMPLATE, knowledgeChunks);

    // SORRY_TEMPLATE 不含禁止模式也不含业务事实性指标 → 应通过
    // 且不触发 L5（虽然 KB 为空）
    expect(result.valid).toBe(true);
  });

  // ── Test 25: KB 有内容 + SORRY_TEMPLATE → 跳过 L4 校验 ──

  it("skips Layer 4 citation check when answer is SORRY_TEMPLATE even with KB chunks", () => {
    const knowledgeChunks = ["这是一个 KB 片段"];
    const citationReport = makeCitationReport({
      sentences: [citedSentence(SORRY_TEMPLATE, "uncited")],
      coverageRate: 0,
      avgScore: 0,
    });

    const result = validateBusinessResponse(
      SORRY_TEMPLATE,
      knowledgeChunks,
      citationReport,
    );

    // SORRY_TEMPLATE 固定话术豁免 L4 校验
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── Test 26: 中文文本混用英文标点 ──

  it("handles mixed Chinese and English text correctly", () => {
    const rawText = JSON.stringify({
      answer: "您的API密钥将在30天后过期。请尽快更新。Update your API key.",
      suggestions: ["如何更新API密钥", "密钥管理"],
    });
    const knowledgeChunks = ["API密钥管理：密钥有效期为90天，过期前30天会发送提醒。"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    // 中文部分无禁止行为，关键词可命中 KB
    expect(result.valid).toBe(true);
  });

  // ── Test 27: 全角数字和中文标点符号 ──

  it("handles full-width characters and Chinese punctuation", () => {
    const rawText = JSON.stringify({
      answer: "您的订单金额为１００元，预计在３个工作日内发货。",
      suggestions: [],
    });
    const knowledgeChunks = ["订单发货时效为3个工作日。"];

    const result = validateBusinessResponse(rawText, knowledgeChunks);

    expect(result.valid).toBe(true);
  });
});

// ── parseChatResponse ──

describe("parseChatResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ChatResponse for valid JSON", () => {
    const rawText = JSON.stringify({
      answer: "你好",
      suggestions: ["问题一", "问题二"],
    });

    const result = parseChatResponse(rawText);

    expect(result).toEqual({
      answer: "你好",
      suggestions: ["问题一", "问题二"],
    });
  });

  it("applies default empty suggestions array", () => {
    const rawText = JSON.stringify({ answer: "你好" });

    const result = parseChatResponse(rawText);

    expect(result).toEqual({
      answer: "你好",
      suggestions: [],
    });
  });

  it("returns null for invalid JSON", () => {
    const rawText = "这不是JSON";

    const result = parseChatResponse(rawText);

    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("returns null for valid JSON that fails schema", () => {
    const rawText = JSON.stringify({ answer: "" });

    const result = parseChatResponse(rawText);

    expect(result).toBeNull();
  });

  it("returns null for JSON missing answer field", () => {
    const rawText = JSON.stringify({ suggestions: ["test"] });

    const result = parseChatResponse(rawText);

    expect(result).toBeNull();
  });
});

// ── 常量与 Schema ──

describe("constants and schema", () => {
  it("SORRY_TEMPLATE is a non-empty Chinese string", () => {
    expect(SORRY_TEMPLATE).toBeTypeOf("string");
    expect(SORRY_TEMPLATE.length).toBeGreaterThan(0);
    expect(/[一-鿿]/.test(SORRY_TEMPLATE)).toBe(true);
  });

  it("FALLBACK_PREFIX is a non-empty string", () => {
    expect(FALLBACK_PREFIX).toBeTypeOf("string");
    expect(FALLBACK_PREFIX.length).toBeGreaterThan(0);
  });

  it("FORBIDDEN_PATTERNS contains all four prohibited patterns", () => {
    expect(FORBIDDEN_PATTERNS).toHaveLength(4);
    const labels = FORBIDDEN_PATTERNS.map((p) => p.label);
    expect(labels).toContain("虚假权威引用");
    expect(labels).toContain("虚假查询陈述");
    expect(labels).toContain("无依据推测原因");
    expect(labels).toContain("推卸责任式建议");
  });

  it("FORBIDDEN_PATTERNS each have a valid RegExp and label", () => {
    for (const entry of FORBIDDEN_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.label).toBeTypeOf("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("ChatResponseSchema rejects answer exceeding 2000 characters", () => {
    const longAnswer = "A".repeat(2001);
    const result = ChatResponseSchema.safeParse({ answer: longAnswer });

    expect(result.success).toBe(false);
  });

  it("ChatResponseSchema accepts answer exactly 2000 characters", () => {
    const maxAnswer = "A".repeat(2000);
    const result = ChatResponseSchema.safeParse({ answer: maxAnswer });

    expect(result.success).toBe(true);
  });

  it("ChatResponseSchema defaults suggestions to empty array when omitted", () => {
    const result = ChatResponseSchema.safeParse({ answer: "test" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestions).toEqual([]);
    }
  });
});
