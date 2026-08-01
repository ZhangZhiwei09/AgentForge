// ChatAgent unit tests —— 确定性，无真实 LLM 调用
//
// 覆盖：
//   - 正常流程：meta → token* → done（含 suggestions）
//   - JSON 解析失败 fallback
//   - LLM 调用异常 fallback
//   - 对话历史传递
//   - Golden Cases 确定性检查（requiredText / forbiddenText / maxLength）

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatAgent } from "../agent-runtime/chat-agent.js";
import type { RouteContext, RouteStreamEvent } from "../agent-runtime/types.js";

// ── Hoisted Mock Refs ──

const { mockChatSync } = vi.hoisted(() => ({
  mockChatSync: vi.fn(),
}));

// ── Mocks ──

vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    chatSync: mockChatSync,
    streamChat: vi.fn(),
    listModels: vi.fn(() => []),
  })),
  resolveModel: vi.fn(() => ["openai", "gpt-4o-mini"]),
}));

vi.mock("@agentforge/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Use real json-utils (pure functions, no mock needed)
vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/json-utils.js")
  >("../../lib/json-utils.js");
  return actual;
});

// ── Helpers ──

/** 创建一个最小 RouteContext，只包含 ChatAgent.execute 需要的字段 */
function makeContext(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    conversationId: "conv-1",
    sessionId: "session-1",
    userMessage: "你是谁？",
    history: [],
    knowledgeContext: "",
    knowledgeResults: [],
    kbChunks: [],
    memoryContext: "",
    injectedMemories: [],
    resolvedModel: "gpt-4o-mini",
    providerName: "openai",
    withinServiceHours: true,
    assistantMsgId: "msg-1",
    intent: "其他咨询",
    ...overrides,
  };
}

/** 收集 async generator 的所有事件 */
async function collectEvents(
  generator: AsyncGenerator<RouteStreamEvent>,
): Promise<RouteStreamEvent[]> {
  const events: RouteStreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

/** 从 token 事件中拼接完整回答文本 */
function reconstructAnswer(events: RouteStreamEvent[]): string {
  return events
    .filter((e) => e.type === "token")
    .map((e) => ("content" in e ? (e as { content: string }).content : ""))
    .join("");
}

// ── Tests ──

describe("ChatAgent", () => {
  let agent: ChatAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ChatAgent();
  });

  // ═══════════════════════════════════════════════════════
  // 正常流程
  // ═══════════════════════════════════════════════════════

  it("应该输出正确的 meta → token → done 事件序列", async () => {
    mockChatSync.mockResolvedValueOnce({
      content: JSON.stringify({
        answer: "我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。",
        suggestions: ["查询知识库", "诊断故障"],
      }),
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });

    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    // meta event
    const meta = events[0];
    expect(meta.type).toBe("meta");
    expect((meta as { message_id: string }).message_id).toBe("msg-1");
    expect((meta as { route: string }).route).toBe("CHAT");

    // token events
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);
    const answer = reconstructAnswer(events);
    expect(answer).toContain("AgentForge");

    // done event
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    expect((done as { validated: boolean }).validated).toBe(true);
    const doneWithSugs = done as { suggestions?: string[] };
    expect(doneWithSugs.suggestions).toEqual(["查询知识库", "诊断故障"]);
  });

  it("应该将对话历史传递给 LLM", async () => {
    mockChatSync.mockResolvedValueOnce({
      content: JSON.stringify({
        answer: "你好，有什么需要帮助的？",
        suggestions: [],
      }),
    });

    const ctx = makeContext({
      history: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，我是 AgentForge 助手。" },
        { role: "user", content: "你是谁？" },
      ],
    });

    await collectEvents(agent.execute(ctx));

    // 验证 chatSync 被调用时传入了历史消息
    const callArgs = mockChatSync.mock.calls[0];
    const messages = callArgs[0]; // 第一个参数是 messages 数组
    expect(messages.length).toBeGreaterThan(1); // 应该包含历史 + 当前消息
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "你是谁？",
    });
    // 历史消息应该包含前两轮
    expect(messages).toContainEqual({ role: "user", content: "你好" });
  });

  // ═══════════════════════════════════════════════════════
  // JSON 解析失败 → fallback
  // ═══════════════════════════════════════════════════════

  it("JSON 解析失败时应该使用原始文本作为回答", async () => {
    mockChatSync.mockResolvedValueOnce({
      content: "这是一段非 JSON 格式的纯文本回答。",
    });

    const ctx = makeContext({ userMessage: "你好" });
    const events = await collectEvents(agent.execute(ctx));

    const answer = reconstructAnswer(events);
    expect(answer).toBe("这是一段非 JSON 格式的纯文本回答。");

    const done = events[events.length - 1];
    expect((done as { fallback_used?: boolean }).fallback_used).toBeUndefined(); // 不是空内容兜底
  });

  it("LLM 返回空内容时应该使用 JSON fallback", async () => {
    mockChatSync.mockResolvedValueOnce({
      content: "",
    });

    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    const answer = reconstructAnswer(events);
    expect(answer).toBe("你好，有什么可以帮助你的？");

    const done = events[events.length - 1];
    expect((done as { fallback_used?: boolean }).fallback_used).toBe(true);
  });

  // ═══════════════════════════════════════════════════════
  // LLM 异常 → fallback
  // ═══════════════════════════════════════════════════════

  it("LLM 调用失败时应该使用硬编码 fallback", async () => {
    mockChatSync.mockRejectedValueOnce(new Error("API Timeout"));

    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    const answer = reconstructAnswer(events);
    expect(answer).toContain("AgentForge");
    expect(answer).toContain("查询知识库");
    expect(answer).toContain("诊断系统故障");

    const done = events[events.length - 1];
    expect((done as { fallback_used?: boolean }).fallback_used).toBe(true);
  });

  // ═══════════════════════════════════════════════════════
  // Golden Cases —— 确定性检查（零 LLM 成本）
  // ═══════════════════════════════════════════════════════

  describe("Golden Cases 确定性检查", () => {
    const deterministicCases = [
      {
        name: "capability-what-can-you-do",
        input: "你能帮我做什么？",
        mockResponse: JSON.stringify({
          answer: "我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。你需要查什么资料，还是遇到了系统问题？",
          suggestions: ["查询平台使用文档", "排查系统报错问题"],
        }),
        checks: {
          contains: ["查询知识库", "诊断系统故障"],
          notContains: ["我可以帮你做很多事情", "比如", "回答问题", "任务执行", "创意支持"],
          maxLength: 300,
        },
      },
      {
        name: "identity-who-are-you",
        input: "你是谁？",
        mockResponse: JSON.stringify({
          answer: "我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。请问你需要什么帮助？",
          suggestions: [],
        }),
        checks: {
          contains: ["AgentForge"],
          notContains: ["由 AI 驱动", "虚拟助手", "随时准备帮你"],
          maxLength: 200,
        },
      },
      {
        name: "identity-are-you-chatgpt",
        input: "你是ChatGPT吗？",
        mockResponse: JSON.stringify({
          answer: "不是，我是 AgentForge 智能助手。我能查询知识库、诊断系统故障。和 ChatGPT 没关系。",
          suggestions: ["查询知识库", "诊断系统故障"],
        }),
        checks: {
          contains: ["AgentForge"],
          notContains: ["是的", "对", "没错", "基于 ChatGPT"],
        },
      },
      {
        name: "boundary-out-of-scope",
        input: "帮我写一篇关于机器学习的论文",
        mockResponse: JSON.stringify({
          answer: "这不属于我的职责范围。我只负责查询知识库和诊断系统故障。写论文建议使用专门的写作工具，或联系你们团队的文档负责人。",
          suggestions: [],
        }),
        checks: {
          notContains: ["好的，我来帮你", "第一部分", "引言", "摘要", "以下是"],
        },
      },
      {
        name: "boundary-refund-request",
        input: "你能帮我处理退款吗？",
        mockResponse: JSON.stringify({
          answer: "退款处理不在我的能力范围内。我只负责查询知识库和诊断系统故障。如需退款帮助，建议联系财务或客服部门。",
          suggestions: [],
        }),
        checks: {
          notContains: ["退款政策", "退款流程", "7天", "3-7个工作日", "原路返回"],
        },
      },
      {
        name: "english-capability",
        input: "What can you do?",
        mockResponse: JSON.stringify({
          answer: "I am the AgentForge assistant. I can search the knowledge base and diagnose system issues. What do you need help with?",
          suggestions: ["Search knowledge base", "Diagnose an issue"],
        }),
        checks: {
          contains: ["AgentForge", "knowledge"],
          notContains: [
            "I can help you with many things",
            "answer questions",
            "write",
            "creative",
          ],
          maxLength: 300,
        },
      },
    ];

    for (const tc of deterministicCases) {
      it(`Golden: ${tc.name}`, async () => {
        mockChatSync.mockResolvedValueOnce({
          content: tc.mockResponse,
        });

        const ctx = makeContext({ userMessage: tc.input });
        const events = await collectEvents(agent.execute(ctx));
        const answer = reconstructAnswer(events);

        // 检查必须包含的文本
        for (const phrase of tc.checks.contains ?? []) {
          expect(
            answer,
            `[${tc.name}] 回答必须包含 "${phrase}"，实际回答: "${answer}"`,
          ).toContain(phrase);
        }

        // 检查禁止出现的文本
        for (const phrase of tc.checks.notContains ?? []) {
          expect(
            answer,
            `[${tc.name}] 回答禁止包含 "${phrase}"，实际回答: "${answer}"`,
          ).not.toContain(phrase);
        }

        // 检查最大长度
        if (tc.checks.maxLength) {
          expect(
            answer.length,
            `[${tc.name}] 回答长度 ${answer.length} 超过限制 ${tc.checks.maxLength}`,
          ).toBeLessThanOrEqual(tc.checks.maxLength);
        }
      });
    }
  });

  // ═══════════════════════════════════════════════════════
  // 自定义 Persona
  // ═══════════════════════════════════════════════════════

  it("应该支持自定义 Persona", async () => {
    mockChatSync.mockResolvedValueOnce({
      content: JSON.stringify({
        answer: "我是自定义助手，只能做一件事。",
        suggestions: [],
      }),
    });

    // 创建一个自定义 persona
    const customPersona = {
      id: "custom-test",
      version: "1.0.0",
      name: "自定义测试助手",
      identity: "你是一个自定义测试助手。",
      tone: "简洁",
      capabilities: ["只做测试"],
      constraints: ["不能做其他事情"],
      examples: [],
    };

    const customAgent = new ChatAgent(customPersona);
    const ctx = makeContext({ userMessage: "你能做什么？" });

    // 验证不会崩溃
    const events = await collectEvents(customAgent.execute(ctx));
    expect(events.length).toBeGreaterThan(0);

    // 验证 system prompt 中包含自定义内容
    const callArgs = mockChatSync.mock.calls[0];
    const systemPrompt = callArgs[2] as string;
    expect(systemPrompt).toContain("自定义测试助手");
    expect(systemPrompt).toContain("只做测试");
  });
});
