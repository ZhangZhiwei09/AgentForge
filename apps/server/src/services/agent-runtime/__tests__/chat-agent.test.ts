// ChatAgent 单元测试
//
// 覆盖：
//   - RouteAgent 接口合约：route = "CHAT"、execute 为 AsyncGenerator
//   - execute() 流式事件：meta → token(s) → done
//   - 正常对话（问候 / 简单问题）→ 完整事件流
//   - suggestions 透传
//   - AbortSignal 中断
//   - 空消息降级到 fallback

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatAgent } from "../chat-agent.js";
import type { RouteContext, RouteStreamEvent } from "../types.js";
import type { ExecutionScope } from "../../../runtime/scope.js";
import type { LLMProvider } from "../../../providers/types.js";

// ── Mock 设置（hoisted）──
// 注意：vi.mock 中的相对路径是相对于本测试文件解析的
// chat-agent.ts 位于 agent-runtime/，本文件位于 agent-runtime/__tests__/
// 所以需要多一层 ../ 才能定位到相同模块

const mockChatSync = vi.hoisted(() => vi.fn());

vi.mock("../../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    chatSync: mockChatSync,
    streamChat: vi.fn(),
    listModels: vi.fn(() => []),
  } satisfies LLMProvider)),
}));

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

const mockMetricsInc = vi.hoisted(() => vi.fn());

vi.mock("../../../observability/metrics.js", () => ({
  agentRouteInvocations: {
    inc: mockMetricsInc,
  },
}));

// ── 辅助函数 ──

/** 收集 AsyncGenerator 的所有事件 */
async function collectEvents(
  gen: AsyncGenerator<RouteStreamEvent>,
): Promise<RouteStreamEvent[]> {
  const events: RouteStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** 获取类型安全的事件 */
function getEventsByType<T extends RouteStreamEvent["type"]>(
  events: RouteStreamEvent[],
  type: T,
): Extract<RouteStreamEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<
    RouteStreamEvent,
    { type: T }
  >[];
}

// ── Mock Trace ──

function createMockTrace() {
  const gen = {
    end: vi.fn(),
    update: vi.fn(),
  };
  return {
    generation: vi.fn().mockReturnValue(gen),
    update: vi.fn(),
    end: vi.fn(),
  };
}

// ── 基础 RouteContext ──

function createBaseContext(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    conversationId: "conv-test-1",
    sessionId: "session-test-1",
    userMessage: "你好",
    history: [],
    knowledgeContext: "",
    knowledgeResults: [],
    kbChunks: [],
    memoryContext: "",
    injectedMemories: [],
    resolvedModel: "gpt-4o-mini",
    providerName: "openai",
    withinServiceHours: true,
    assistantMsgId: "msg-test-1",
    intent: "问候",
    ...overrides,
  };
}

// ── 基础 ExecutionScope ──

function createMockScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    context: { signal: new AbortController().signal } as unknown as ExecutionScope["context"],
    node: {} as ExecutionScope["node"],
    buffer: {} as ExecutionScope["buffer"],
    controller: {} as ExecutionScope["controller"],
    trace: undefined,
    ...overrides,
  } as ExecutionScope;
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe("ChatAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 每次测试默认返回一个有效的 JSON 回复
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({
        answer: "你好！我是 AgentForge 智能助手，有什么可以帮助你的？",
        suggestions: ["介绍一下你自己", "你能做什么？"],
      }),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
      },
    });
  });

  // ── 结构合约 ──

  it('route 应始终为 "CHAT"（RouteAgent 接口合约）', () => {
    const agent = new ChatAgent();
    expect(agent.route).toBe("CHAT");
  });

  it("execute() 应返回 AsyncGenerator（可迭代、有 next / return / throw）", () => {
    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext());

    expect(gen).toBeDefined();
    expect(typeof gen.next).toBe("function");
    expect(typeof gen.return).toBe("function");
    expect(typeof gen.throw).toBe("function");
    // 同时满足 AsyncIterable 契约
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");

    // 清理 generator
    gen.return(undefined).catch(() => {});
  });

  // ── Meta 事件 ──

  it("execute() 首个事件应为 type='meta'，且 route 为 'CHAT'", async () => {
    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext());

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();
    expect(first.value.type).toBe("meta");
    expect(first.value.route).toBe("CHAT");
    expect(first.value.message_id).toBe("msg-test-1");
    expect(first.value.model).toBe("gpt-4o-mini");
    expect(first.value.provider).toBe("openai");
    expect(first.value.intent).toBe("问候");

    // 清理
    await gen.return(undefined);
  });

  // ── 问候（正常 JSON 响应）──

  it('execute() 处理问候 "你好" → 逐字符串出 token + done 事件', async () => {
    const answer = "你好！我是 AgentForge 智能助手。";
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer, suggestions: [] }),
      usage: { prompt_tokens: 50, completion_tokens: 15 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ userMessage: "你好" }));

    const events = await collectEvents(gen);

    // meta
    const metaEvents = getEventsByType(events, "meta");
    expect(metaEvents).toHaveLength(1);

    // tokens — 每个字符一个事件
    const tokenEvents = getEventsByType(events, "token");
    expect(tokenEvents).toHaveLength(answer.length);
    const combined = tokenEvents.map((t) => t.content).join("");
    expect(combined).toBe(answer);

    // done
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].route).toBe("CHAT");
    expect(doneEvents[0].fallback_used).toBeFalsy();
    expect(doneEvents[0].validated).toBe(true);

    // metrics 应为 success
    expect(mockMetricsInc).toHaveBeenCalledWith({ route: "CHAT", status: "success" });
  });

  // ── 简单问题 ──

  it('execute() 处理简单问题 "你是谁？" → token + done 事件', async () => {
    const answer = "我是 AgentForge，一个渐进式 AI Agent 平台。";
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer, suggestions: ["你能做什么？"] }),
      usage: { prompt_tokens: 60, completion_tokens: 20 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ userMessage: "你是谁？", intent: "能力询问" }));

    const events = await collectEvents(gen);

    // meta 事件存在
    expect(getEventsByType(events, "meta")).toHaveLength(1);

    // token 事件存在且内容正确
    const tokenEvents = getEventsByType(events, "token");
    expect(tokenEvents.length).toBeGreaterThan(0);
    const combined = tokenEvents.map((t) => t.content).join("");
    expect(combined).toBe(answer);

    // done 事件存在且正确
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].route).toBe("CHAT");
    expect(doneEvents[0].message_id).toBe("msg-test-1");
  });

  // ── Suggestions ──

  it("done 事件应包含 suggestions 数组（LLM 返回有效 suggestions 时）", async () => {
    const expectedSuggestions = ["介绍一下 AgentForge", "你能帮我做什么？", "如何开始使用？"];
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({
        answer: "你好！我是 AgentForge 智能助手。",
        suggestions: expectedSuggestions,
      }),
      usage: { prompt_tokens: 70, completion_tokens: 35 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ userMessage: "你好" }));

    const events = await collectEvents(gen);
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);

    expect(doneEvents[0].suggestions).toBeDefined();
    expect(doneEvents[0].suggestions).toEqual(expectedSuggestions);
  });

  it("done 事件 suggestions 应为 undefined（LLM 未返回 suggestions 时）", async () => {
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer: "好的。", suggestions: [] }),
      usage: { prompt_tokens: 30, completion_tokens: 5 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ userMessage: "好的" }));

    const events = await collectEvents(gen);
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    // suggestions 为空数组时，done 事件应省略该字段
    expect(doneEvents[0].suggestions).toBeUndefined();
  });

  // ── Observability trace 注入 ──

  it("scope 传入 trace 时应调用 trace.generation() 并记录 usage", async () => {
    const mockTrace = createMockTrace();
    const scope = createMockScope({ trace: mockTrace });

    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer: "你好！", suggestions: [] }),
      usage: { prompt_tokens: 40, completion_tokens: 10 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext(), scope);

    await collectEvents(gen);

    // 验证 trace.generation 被调用
    expect(mockTrace.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "chat-agent-response",
        model: "gpt-4o-mini",
      }),
    );

    // 验证 generation.end 被调用并携带 output
    const mockGen = mockTrace.generation.mock.results[0]?.value;
    expect(mockGen).toBeDefined();
    expect(mockGen.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ answer: expect.any(String) }),
        usage: expect.objectContaining({
          promptTokens: 40,
          completionTokens: 10,
        }),
      }),
    );
  });

  // ── AbortSignal 中断 ──

  it("execute() 传入 scope 后，scope 上下文中的 AbortSignal 应可访问", async () => {
    const controller = new AbortController();
    const scope = createMockScope({
      context: { signal: controller.signal } as unknown as ExecutionScope["context"],
    });

    mockChatSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          // 模拟 LLM 延迟响应，给 abort 留出时间窗口
          setTimeout(() => {
            resolve({
              content: JSON.stringify({ answer: "你好！", suggestions: [] }),
              usage: { prompt_tokens: 10, completion_tokens: 3 },
            });
          }, 50);
        }),
    );

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext(), scope);

    // 立即中断信号
    controller.abort();

    // 调用 return() 清理 generator（外部 AbortSignal 监听器的典型行为）
    const result = await gen.return(undefined);

    // generator 应正常结束
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("execute() 应能被 gen.return() 中断（无 AbortSignal 时）", async () => {
    mockChatSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              content: JSON.stringify({ answer: "你好！", suggestions: [] }),
              usage: { prompt_tokens: 10, completion_tokens: 3 },
            });
          }, 50);
        }),
    );

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext());

    // 发送第一个事件后中断
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe("meta");

    // 中断 generator
    const result = await gen.return(undefined);
    expect(result.done).toBe(true);
  });

  // ── JSON 解析失败降级 ──

  it("LLM 返回非 JSON 文本时，应将原始文本作为 answer 输出", async () => {
    const rawText = "你好，我是你的 AI 助手，有什么可以帮你的？";
    mockChatSync.mockResolvedValue({
      content: rawText,
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext());

    const events = await collectEvents(gen);

    const tokenEvents = getEventsByType(events, "token");
    const combined = tokenEvents.map((t) => t.content).join("");
    expect(combined).toBe(rawText);

    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    // 非空内容不应标记为 fallback
    expect(doneEvents[0].fallback_used).toBeFalsy();
  });

  // ── 空消息降级 ──

  it("execute() 处理 LLM 返回空内容 → 使用兜底文案，标记 fallback_used", async () => {
    mockChatSync.mockResolvedValue({
      content: "", // 空响应
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });

    const fallbackText = "你好，有什么可以帮助你的？";

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ userMessage: "" }));

    const events = await collectEvents(gen);

    // 验证 token 内容为兜底文案
    const tokenEvents = getEventsByType(events, "token");
    const combined = tokenEvents.map((t) => t.content).join("");
    expect(combined).toBe(fallbackText);

    // 验证 done 事件标记 fallback_used
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].fallback_used).toBe(true);
    expect(doneEvents[0].route).toBe("CHAT");
  });

  // ── LLM 调用异常降级 ──

  it("LLM 调用抛出异常时 → 使用硬编码 fallback 文案，记录错误 metrics", async () => {
    mockChatSync.mockRejectedValue(new Error("Connection refused"));

    const hardcodedFallback =
      "我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。请告诉我你需要什么帮助？";

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext());

    const events = await collectEvents(gen);

    // 验证 token 为硬编码 fallback
    const tokenEvents = getEventsByType(events, "token");
    const combined = tokenEvents.map((t) => t.content).join("");
    expect(combined).toBe(hardcodedFallback);

    // 验证 done 事件标记 fallback
    const doneEvents = getEventsByType(events, "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].fallback_used).toBe(true);

    // 验证 error metrics 被记录
    expect(mockMetricsInc).toHaveBeenCalledWith({ route: "CHAT", status: "error" });

    // 验证 warn 日志
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(Error),
      "ChatAgent LLM call failed, using fallback",
    );
  });

  // ── 带对话历史的上下文传递 ──

  it("execute() 应将最近 3 轮对话历史传递给 LLM", async () => {
    const history = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！有什么可以帮你的？" },
      { role: "user", content: "我想了解产品" },
      { role: "assistant", content: "当然，我们的产品是..." },
      { role: "user", content: "价格呢？" },
    ];

    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer: "价格方面...", suggestions: [] }),
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    });

    const agent = new ChatAgent();
    const gen = agent.execute(createBaseContext({ history }));
    await collectEvents(gen);

    // 验证 chatSync 收到的消息列表：最多最近 6 条（3 轮）+ 当前用户消息
    const callArgs = mockChatSync.mock.calls[0];
    const messages = callArgs[0];
    expect(messages).toHaveLength(history.length + 1); // history + current userMessage
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "你好",
    });
  });

  // ── 自定义 Persona ──

  it("构造函数接受自定义 Persona，不影响 route 和执行结构", () => {
    const customPersona = {
      id: "test-persona",
      version: "1.0.0",
      name: "TestBot",
      identity: "测试机器人",
      tone: "友好",
      capabilities: ["测试能力"],
      constraints: ["不讨论政治"],
      examples: [],
    };

    const agent = new ChatAgent(customPersona);
    expect(agent.route).toBe("CHAT");

    // execute 仍返回 AsyncGenerator
    const gen = agent.execute(createBaseContext());
    expect(typeof gen.next).toBe("function");
    expect(typeof gen.return).toBe("function");

    gen.return(undefined).catch(() => {});
  });

  // ── scope 为 undefined ──

  it("scope 为 undefined 时不应崩溃（无 trace 降级）", async () => {
    mockChatSync.mockResolvedValue({
      content: JSON.stringify({ answer: "你好！", suggestions: [] }),
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });

    const agent = new ChatAgent();
    // scope 传 undefined
    const gen = agent.execute(createBaseContext(), undefined);
    const events = await collectEvents(gen);

    expect(getEventsByType(events, "meta")).toHaveLength(1);
    expect(getEventsByType(events, "done")).toHaveLength(1);
  });
});
