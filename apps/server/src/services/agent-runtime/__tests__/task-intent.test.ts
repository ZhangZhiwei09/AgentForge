// TaskIntentClassifier 单元测试
//
// 覆盖：
//   - classify() regex 快速路径（simple_qa / complex_task）
//   - classify() LLM 兜底路径（含失败 / 低置信度降级）
//   - parseResult() markdown 代码块 / JSON 解析 / 边界
//   - Observability trace 集成（LLM 路径记录 span，regex 路径跳过）
//   - getTaskIntentClassifier() 单例

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

const mockChatSync = vi.fn();
const mockGenEnd = vi.fn();
const mockGeneration = vi.fn(() => ({ end: mockGenEnd }));

vi.mock("../../../providers/registry.js", () => ({
  getProvider: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock("@agentforge/logger", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../config.js", () => ({
  settings: {
    taskIntentModel: "task-intent-model",
    defaultModel: "default-model",
  },
}));

import { TaskIntentClassifier, getTaskIntentClassifier } from "../task-intent.js";
import { getProvider, resolveModel } from "../../../providers/registry.js";

// ── Helpers ─────────────────────────────────────────────────

/** Mock LLM 返回一个合法的分类 JSON 字符串（不含 markdown 包裹） */
function mockLLMResponse(subclass: string, confidence: number, reasoning: string) {
  mockChatSync.mockResolvedValueOnce({
    content: JSON.stringify({ subclass, confidence, reasoning }),
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  });
}

// ── Tests ──────────────────────────────────────────────────

describe("TaskIntentClassifier", () => {
  let classifier: TaskIntentClassifier;

  beforeEach(() => {
    vi.resetAllMocks();
    classifier = new TaskIntentClassifier();
    vi.mocked(resolveModel).mockReturnValue({
      providerName: "mock-provider",
      modelId: "mock-model",
    });
    vi.mocked(getProvider).mockReturnValue({
      chatSync: mockChatSync,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  // ═══════════════════════════════════════════════════════
  // classify() — Regex 快速路径
  // ═══════════════════════════════════════════════════════

  describe("classify() — regex fast path", () => {
    it("应识别简单事实查询为 simple_qa（退货条件是什么？）", async () => {
      const result = await classifier.classify("退货条件是什么？");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
      expect(result.reasoning).toContain("简单问答关键词命中");
      // 未触发 LLM
      expect(mockChatSync).not.toHaveBeenCalled();
    });

    it("应识别复杂多步操作为 complex_task", async () => {
      const result = await classifier.classify(
        "帮我查订单状态，如果有问题就退款，然后给我发邮件确认",
      );

      expect(result.subclass).toBe("complex_task");
      expect(result.confidence).toBe(0.85);
      expect(result.reasoning).toBe("复杂任务关键词命中");
      expect(mockChatSync).not.toHaveBeenCalled();
    });

    it("应识别数据分析请求为 complex_task", async () => {
      const result = await classifier.classify("分析上个月的销售数据并生成报表");

      expect(result.subclass).toBe("complex_task");
      expect(result.confidence).toBe(0.85);
      expect(mockChatSync).not.toHaveBeenCalled();
    });

    it("complex_task 命中时优先级高于 simple_qa（双模式均命中取 complex）", async () => {
      // "帮我分析一下退货条件" 同时命中 complex（帮我…分析）和 simple（退货条件）
      const result = await classifier.classify("帮我分析一下退货条件");

      expect(result.subclass).toBe("complex_task");
      expect(mockChatSync).not.toHaveBeenCalled();
    });

    it("多个 simple_qa 模式命中时应提升置信度", async () => {
      // "退货条件是什么？需要哪些材料？" → 两个 simple_qa 命中
      const result = await classifier.classify("退货条件是什么？需要哪些材料？");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
      expect(result.reasoning).toMatch(/简单问答关键词命中.*2个/);
    });
  });

  // ═══════════════════════════════════════════════════════
  // classify() — LLM 兜底路径
  // ═══════════════════════════════════════════════════════

  describe("classify() — LLM fallback", () => {
    it("模糊消息应走 LLM 分类并返回结果（你好 → simple_qa）", async () => {
      mockLLMResponse("simple_qa", 0.9, "普通问候，无需复杂处理");

      const result = await classifier.classify("你好");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.9);
      expect(result.reasoning).toBe("普通问候，无需复杂处理");
      expect(mockChatSync).toHaveBeenCalledTimes(1);
    });

    it("工具类请求应通过 LLM 识别为 complex_task（帮我创建一个工单）", async () => {
      mockLLMResponse("complex_task", 0.85, "需要创建工单，涉及系统操作");

      const result = await classifier.classify("帮我创建一个工单");

      expect(result.subclass).toBe("complex_task");
      expect(result.confidence).toBe(0.85);
      expect(mockChatSync).toHaveBeenCalledTimes(1);
    });

    it("LLM 返回低置信度（< 0.5）时应降级为 simple_qa 安全默认", async () => {
      mockLLMResponse("complex_task", 0.3, "不太确定");

      const result = await classifier.classify("今天天气怎么样");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.3);
      expect(result.reasoning).toBe("LLM 分类失败，默认 simple_qa");
    });

    it("LLM 调用异常抛错时应降级为 simple_qa 安全默认", async () => {
      mockChatSync.mockRejectedValueOnce(new Error("LLM timeout"));

      const result = await classifier.classify("随便聊聊");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.3);
      expect(result.reasoning).toBe("LLM 分类失败，默认 simple_qa");
    });

    it("空消息应走降级路径返回 simple_qa", async () => {
      mockChatSync.mockRejectedValueOnce(new Error("empty input"));

      const result = await classifier.classify("");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.3);
      expect(result.reasoning).toBe("LLM 分类失败，默认 simple_qa");
    });

    it("LLM 返回的 JSON 包裹在 markdown 代码块中时应正确解析", async () => {
      mockChatSync.mockResolvedValueOnce({
        content:
          '```json\n{"subclass":"complex_task","confidence":0.88,"reasoning":"多步骤订单处理"}\n```',
        usage: { prompt_tokens: 25, completion_tokens: 15 },
      });

      // 使用不命中任何 regex 的消息，确保走 LLM 路径
      const result = await classifier.classify("我想知道最近有什么促销活动");

      expect(result.subclass).toBe("complex_task");
      expect(result.confidence).toBe(0.88);
      expect(result.reasoning).toBe("多步骤订单处理");
    });

    it("LLM 返回非法 JSON 时应降级为 simple_qa", async () => {
      mockChatSync.mockResolvedValueOnce({
        content: "not valid json at all",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      // 使用不命中任何 regex 的消息，确保走 LLM 路径
      const result = await classifier.classify("今天的天气如何");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.3);
      expect(result.reasoning).toBe("LLM 分类失败，默认 simple_qa");
    });

    it("LLM 返回合法 JSON 但 subclass 不在枚举中时应降级", async () => {
      mockChatSync.mockResolvedValueOnce({
        content: '{"subclass":"unknown_type","confidence":0.9,"reasoning":"test"}',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      // 使用不命中任何 regex 的消息，确保走 LLM 路径
      const result = await classifier.classify("今天天气如何");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.3);
    });

    it("LLM 返回 reasoning 超 100 字符时应截断", async () => {
      const longReasoning = "a".repeat(200);
      mockChatSync.mockResolvedValueOnce({
        content: JSON.stringify({
          subclass: "simple_qa",
          confidence: 0.8,
          reasoning: longReasoning,
        }),
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });

      const result = await classifier.classify("测试长 reasoning");

      expect(result.subclass).toBe("simple_qa");
      expect(result.reasoning.length).toBeLessThanOrEqual(100);
    });
  });

  // ═══════════════════════════════════════════════════════
  // classify() — 返回结构合约
  // ═══════════════════════════════════════════════════════

  describe("classify() — result contract", () => {
    it("应返回合法的 subclass 和 confidence", async () => {
      const result = await classifier.classify("退货条件是什么？");

      expect(["simple_qa", "complex_task"]).toContain(result.subclass);
      expect(typeof result.confidence).toBe("number");
      expect(typeof result.reasoning).toBe("string");
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("多种输入下 confidence 始终在 [0, 1] 区间内", async () => {
      // 覆盖 regex simple_qa / regex complex_task / LLM 降级三种路径
      mockChatSync.mockRejectedValue(new Error("fail"));

      const inputs = [
        "退货条件是什么？", // regex → simple_qa
        "帮我查订单状态，如果有问题就退款", // regex → complex_task
        "随便聊聊", // LLM fail → simple_qa (0.3)
      ];

      for (const input of inputs) {
        const result = await classifier.classify(input);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  // classify() — Observability Trace 集成
  // ═══════════════════════════════════════════════════════

  describe("classify() — observability trace", () => {
    it("LLM 路径应创建并结束 generation span", async () => {
      mockChatSync.mockResolvedValueOnce({
        content: '{"subclass":"simple_qa","confidence":0.9,"reasoning":"问候"}',
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

      const trace = { generation: mockGeneration };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await classifier.classify("你好", trace as any);

      expect(mockGeneration).toHaveBeenCalledWith({
        name: "task-intent-classifier",
        model: "mock-model",
        input: { message: "你好" },
        metadata: { provider: "mock-provider" },
      });

      expect(mockGenEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { subclass: "simple_qa", confidence: 0.9 },
          usage: {
            promptTokens: 20,
            completionTokens: 10,
            totalTokens: 30,
          },
        }),
      );
    });

    it("LLM 路径即使解析失败也应结束 generation span（记录 unknown）", async () => {
      mockChatSync.mockResolvedValueOnce({
        content: "invalid json response",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const trace = { generation: mockGeneration };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await classifier.classify("今夕是何年", trace as any);

      expect(mockGenEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { subclass: "unknown", confidence: 0 },
        }),
      );
    });

    it("Regex 快速路径不应调用 trace.generation", async () => {
      const trace = { generation: mockGeneration };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await classifier.classify("退货条件是什么？", trace as any);

      expect(mockGeneration).not.toHaveBeenCalled();
    });

    it("未传 trace 时 LLM 路径不应报错", async () => {
      mockLLMResponse("simple_qa", 0.8, "测试");

      // 不传 trace → trace 为 undefined → generation() 不调用
      const result = await classifier.classify("测试问题");

      expect(result.subclass).toBe("simple_qa");
      expect(result.confidence).toBe(0.8);
    });
  });

  // ═══════════════════════════════════════════════════════
  // getTaskIntentClassifier() — 单例
  // ═══════════════════════════════════════════════════════

  describe("getTaskIntentClassifier()", () => {
    it("多次调用应返回同一个实例", () => {
      const a = getTaskIntentClassifier();
      const b = getTaskIntentClassifier();

      expect(a).toBe(b);
    });

    it("应返回 TaskIntentClassifier 实例", () => {
      const instance = getTaskIntentClassifier();

      expect(instance).toBeInstanceOf(TaskIntentClassifier);
    });
  });
});
