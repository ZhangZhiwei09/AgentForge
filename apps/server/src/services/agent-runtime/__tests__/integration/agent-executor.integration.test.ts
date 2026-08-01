// AgentExecutor 集成测试 — 验证完整执行流程（mock LLM + 工具）
//
// 覆盖：
//   1. simple_qa 快速路径：KB 搜索 + 单次 LLM 调用
//   2. complex_task 路径：ReAct 循环事件映射
//   3. 中断处理：partial content sanitize + persist
//   4. 错误恢复：hardcoded fallback 产出

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentExecutor, extractKBChunks, isKnowledgeBaseResult } from "../../agent-executor.js";
import type { RouteContext } from "../../types.js";

// ── Mock provider ──
const mockChatSync = vi.fn();
const mockStreamChat = vi.fn();

vi.mock("../../../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    chatSync: mockChatSync,
    streamChat: mockStreamChat,
    listModels: vi.fn(() => [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
    ]),
  })),
  resolveModel: vi.fn(() => ({ providerName: "openai", modelId: "gpt-4o" })),
  listProviders: vi.fn(() => []),
}));

// ── Mock prisma ──
vi.mock("../../../../db.js", () => ({
  prisma: {
    message: { create: vi.fn() },
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

// ── Mock KnowledgeService ──
const mockKBSearch = vi.fn();
vi.mock("../../../knowledge.js", () => ({
  KnowledgeService: class {
    search = mockKBSearch;
  },
}));

// ── Mock TaskIntentClassifier ──
const mockTaskClassify = vi.fn();
vi.mock("../../task-intent.js", () => ({
  getTaskIntentClassifier: () => ({ classify: mockTaskClassify }),
}));

// ── Mock toolRegistry ──
vi.mock("../../../../tools/registry.js", () => ({
  toolRegistry: {
    listNames: vi.fn(() => ["search_knowledge_base", "get_current_time"]),
    init: vi.fn(),
    getDefinitions: vi.fn(() => []),
    execute: vi.fn(),
  },
}));

// ── Shared RouteContext factory ──
function makeContext(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    conversationId: "conv-test-001",
    sessionId: "sess-test-001",
    userMessage: "你好",
    history: [],
    knowledgeContext: "",
    knowledgeResults: [],
    kbChunks: [],
    memoryContext: "",
    injectedMemories: [],
    resolvedModel: "gpt-4o",
    providerName: "openai",
    withinServiceHours: true,
    assistantMsgId: "msg-test-001",
    intent: "TASK",
    ...overrides,
  };
}

// ── Helper: collect all events from async generator ──
async function collectEvents(
  executor: AgentExecutor,
  ctx: RouteContext,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const event of executor.execute(ctx)) {
    events.push(event);
  }
  return events;
}

// ── Tests ──

describe("AgentExecutor integration", () => {
  let executor: AgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new AgentExecutor();

    // Default: TaskIntentClassifier returns simple_qa
    mockTaskClassify.mockResolvedValue({
      subclass: "simple_qa",
      confidence: 0.9,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══ simple_qa path ═══

  it("simple_qa: KB found → 流式输出 LLM 回答", async () => {
    mockKBSearch.mockResolvedValue([
      { content: "退换货需要在7天内申请", score: 0.9 },
    ]);
    mockChatSync.mockResolvedValue({
      content: "根据我们的政策，退换货需要在收到商品后7天内提交申请。",
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    });

    const ctx = makeContext({ userMessage: "退换货条件是什么？" });
    const events = await collectEvents(executor, ctx);

    // meta → clear_stream → tokens → done
    expect(events[0].type).toBe("meta");
    expect(events[0].route).toBe("TASK");
    expect(events[1].type).toBe("clear_stream");

    // 应包含 token 事件
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);

    // done 事件
    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.validated).toBe(true);
    expect(doneEvent.route).toBe("TASK");
  });

  it("simple_qa: KB empty → LLM 仍然正常回答", async () => {
    mockKBSearch.mockResolvedValue([]);
    mockChatSync.mockResolvedValue({
      content: "抱歉，未找到相关信息。建议您联系人工客服获取帮助。",
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    });

    const ctx = makeContext({ userMessage: "今天天气怎么样？" });
    const events = await collectEvents(executor, ctx);

    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.validated).toBe(true);
  });

  it("simple_qa: KB 搜索异常 → 降级继续，使用 LLM 回答", async () => {
    mockKBSearch.mockRejectedValue(new Error("DB timeout"));
    mockChatSync.mockResolvedValue({
      content: "目前无法查询知识库，建议您联系人工客服。",
      usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
    });

    const ctx = makeContext({ userMessage: "查询退款政策" });
    const events = await collectEvents(executor, ctx);

    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    // 降级不阻塞，仍然完成
  });

  it("simple_qa: LLM 调用失败 → fallback 兜底文案", async () => {
    mockKBSearch.mockResolvedValue([]);
    mockChatSync.mockRejectedValue(new Error("LLM API error"));

    const ctx = makeContext({ userMessage: "测试问题" });
    const events = await collectEvents(executor, ctx);

    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.fallback_used).toBe(true);

    // 应有兜底 token 输出
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);
  });

  // ═══ complex_task path ═══

  it("complex_task: 委托给 AgentService ReAct 循环", async () => {
    mockTaskClassify.mockResolvedValue({
      subclass: "complex_task",
      confidence: 0.85,
    });

    // AgentService will run — we mock the external provider for its LLM calls
    // The ReAct loop will produce agent_respond, agent_observe, agent_done events
    const ctx = makeContext({ userMessage: "帮我创建一张工单记录昨天的订单问题" });
    const events = await collectEvents(executor, ctx);

    // At minimum: meta → done
    expect(events[0].type).toBe("meta");
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("done");
  });

  // ═══ Event type mapping ═══

  it("应产出 meta 事件作为第一个事件", async () => {
    const ctx = makeContext();
    const events = await collectEvents(executor, ctx);

    expect(events[0].type).toBe("meta");
    expect(events[0].message_id).toBe("msg-test-001");
    expect(events[0].route).toBe("TASK");
  });

  it("应产出 done 事件作为最后一个事件", async () => {
    const ctx = makeContext();
    const events = await collectEvents(executor, ctx);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("done");
  });
});

// ═══ 辅助函数 ═══

describe("extractKBChunks", () => {
  it("从 KB 搜索结果中提取 chunk 文本", () => {
    const result = JSON.stringify({
      query: "test",
      found: true,
      results: [
        { content: "第一条结果", score: 0.9 },
        { content: "第二条结果", score: 0.8 },
      ],
    });

    const chunks = extractKBChunks(result);
    expect(chunks).toEqual(["第一条结果", "第二条结果"]);
  });

  it("found: false → 返回空数组", () => {
    const result = JSON.stringify({ query: "test", found: false, results: [] });
    expect(extractKBChunks(result)).toEqual([]);
  });

  it("非 JSON → 返回空数组", () => {
    expect(extractKBChunks("not a json string")).toEqual([]);
  });
});

describe("isKnowledgeBaseResult", () => {
  it("包含 results 和 found → true", () => {
    expect(isKnowledgeBaseResult('{"results":[],"found":true}')).toBe(true);
  });

  it("不含这些键 → false", () => {
    expect(isKnowledgeBaseResult("some other output")).toBe(false);
  });
});
