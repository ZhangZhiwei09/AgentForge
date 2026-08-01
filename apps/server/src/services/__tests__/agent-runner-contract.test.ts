/**
 * Agent Runner Contract Test — Baseline
 *
 * Captures AgentService's behavior as a contract snapshot.
 * These tests define the expected Agent Runner contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock refs ----
const {
  mockStreamChat,
  mockToolExecute,
  mockToolListNames,
  mockToolGetDefinitions,
  mockToolGetAll,
  mockTruncateHistory,
} = vi.hoisted(() => ({
  mockStreamChat: vi.fn(),
  mockToolExecute: vi.fn(async () => ({
    status: "success" as const,
    output: JSON.stringify({ results: [], found: false }),
  })),
  mockToolListNames: vi.fn(() => ["search_knowledge_base", "calculator"]),
  mockToolGetDefinitions: vi.fn(() => []),
  mockToolGetAll: vi.fn(() => []),
  mockTruncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
}));

// ---- Mocks ----
vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({ streamChat: mockStreamChat, chatSync: vi.fn() })),
  resolveModel: vi.fn(() => ["openai", "gpt-4o"]),
  listProviders: vi.fn(() => []),
}));

vi.mock("../../tools/registry.js", () => ({
  toolRegistry: {
    init: vi.fn(),
    getDefinitions: mockToolGetDefinitions,
    execute: mockToolExecute,
    listNames: mockToolListNames,
    getAll: mockToolGetAll,
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: mockTruncateHistory,
  estimateTokenCount: vi.fn(() => 100),
}));

vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/json-utils.js")>("../../lib/json-utils.js");
  return actual;
});

vi.mock("@agentforge/shared-prompts", () => ({
  react_system_prompt: { content: "You are a helpful agent. Use agent_decide for decisions." },
}));

// Mock prisma
const conversationStore = new Map<string, Record<string, unknown>>();
const messageStore = new Map<string, Array<Record<string, unknown>>>();
const sessionStore = new Map<string, Record<string, unknown>>();
const approvalStore = new Map<string, Record<string, unknown>>();

vi.mock("../../db.js", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return conversationStore.get(args.where.id) || null;
      }),
    },
    message: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const msgs = messageStore.get(args.data.conversationId as string) || [];
        msgs.push(args.data);
        messageStore.set(args.data.conversationId as string, msgs);
        return args.data;
      }),
      findMany: vi.fn(async () => []),
    },
    agentSession: {
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const data = { ...args.create, ...args.update };
        sessionStore.set(data.id as string, data);
        return data;
      }),
      findMany: vi.fn(async () => Array.from(sessionStore.values())),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return sessionStore.get(args.where.id) || null;
      }),
    },
    agentApproval: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        approvalStore.set(args.data.id as string, args.data);
        return args.data;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return approvalStore.get(args.where.id) || null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = approvalStore.get(args.where.id) || {};
        const updated = { ...existing, ...args.data };
        approvalStore.set(args.where.id, updated);
        return updated;
      }),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { AgentService } from "../agent.js";
import type { AgentStreamEvent } from "@agentforge/shared-types";

// ── Helpers ──────────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: AgentStreamEvent[]): string[] {
  return events.map((e) => e.type);
}

// ── Mock LLM Configurations ──────────────────────────────────

/**
 * NOTE: parseAgentDecideFromArgs expects a FLAT JSON structure:
 *   { observation, analysis, plan, action, [tool, args_json, reason] | [content, summary] | [question, clarify_context] }
 * The decision fields are NOT nested under a "decision" key.
 */

/** Normal: tool_call(agent_decide) → respond  */
function mockNormalToolThenRespond() {
  mockStreamChat.mockImplementation(async function* () {
    yield {
      type: "tool_call",
      tool_call: {
        id: "tc-1",
        name: "agent_decide",
        arguments: JSON.stringify({
          observation: "用户想查询产品价格",
          analysis: "需要调用搜索知识库工具获取信息",
          plan: "先搜索知识库再回答",
          action: "tool_call",
          tool: "search_knowledge_base",
          args_json: JSON.stringify({ query: "产品价格" }),
          reason: "需要从知识库获取产品信息",
        }),
      },
    };
    yield { type: "done", usage: { prompt_tokens: 100, completion_tokens: 20 } };
  });
}

/** Normal: direct respond (no tools) */
function mockDirectRespond(responseContent = "这是您的答案。") {
  mockStreamChat.mockImplementation(async function* () {
    yield {
      type: "tool_call",
      tool_call: {
        id: "tc-1",
        name: "agent_decide",
        arguments: JSON.stringify({
          observation: "用户问题很简单",
          analysis: "可以直接回答",
          plan: "直接回复",
          action: "respond",
          content: responseContent,
          summary: "已回答用户问题",
        }),
      },
    };
    yield { type: "done", usage: { prompt_tokens: 100, completion_tokens: 10 } };
  });
}

/** ask_user pause */
function mockAskUser(question: string) {
  mockStreamChat.mockImplementation(async function* () {
    yield {
      type: "tool_call",
      tool_call: {
        id: "tc-1",
        name: "agent_decide",
        arguments: JSON.stringify({
          observation: "用户问题不够具体",
          analysis: "需要向用户确认",
          plan: "提出澄清问题",
          action: "ask_user",
          question,
          clarify_context: "用户提到'产品'但没有具体型号",
        }),
      },
    };
    yield { type: "done", usage: { prompt_tokens: 100, completion_tokens: 15 } };
  });
}

/** Tool call loop — used for max iterations test */
function mockToolCallLoop() {
  mockStreamChat.mockImplementation(async function* () {
    yield {
      type: "tool_call",
      tool_call: {
        id: "tc-loop",
        name: "agent_decide",
        arguments: JSON.stringify({
          observation: "working",
          analysis: "keep going",
          plan: "continue",
          action: "tool_call",
          tool: "search_knowledge_base",
          args_json: JSON.stringify({ query: "test" }),
          reason: "need more data",
        }),
      },
    };
    yield { type: "done", usage: { prompt_tokens: 100, completion_tokens: 20 } };
  });
}

/** LLM throws errors inside generator, exhausts all retries */
function mockDegrade(message = "Connection timeout") {
  mockStreamChat.mockImplementation(async function* () {
    throw Object.assign(new Error(message), { category: "degradable" });
  });
}

// ── Tests ────────────────────────────────────────────────────

describe("AgentRunner Contract — Baseline (Legacy Runner)", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    conversationStore.clear();
    messageStore.clear();
    sessionStore.clear();
    approvalStore.clear();
    vi.clearAllMocks();

    conversationStore.set("conv-contract", {
      id: "conv-contract",
      userId: "user-1",
      title: "Contract Test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  // ═════════════════════════════════════════════════════════
  // Contract 1: Normal tool_call → respond path
  // ═════════════════════════════════════════════════════════

  describe("Contract 1: Normal streaming path", () => {
    it("produces the canonical event type sequence for tool_call → observe path", async () => {
      // With native agent_decide tool_call, respondOnly is NOT triggered.
      // The agent loops until maxIterations, so the sequence is:
      //   meta → think → act → clear_stream → observe → ... → error (max iterations)
      mockNormalToolThenRespond();

      const events = await collectEvents(
        service.run("conv-contract", "查询产品价格", {
          maxIterations: 2,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const types = eventTypes(events);
      expect(types[0]).toBe("agent_meta");
      expect(types).toContain("agent_think");
      expect(types).toContain("agent_act");
      expect(types).toContain("agent_clear_stream");
      expect(types).toContain("agent_observe");
      // Max iterations reached — terminates with error
      expect(types[types.length - 1]).toBe("agent_error");
    }, 10000);

    it("produces the canonical respond-only sequence for direct respond", async () => {
      // Direct respond via agent_decide (action=respond):
      //   meta → think → act → responding → respond → done
      // Note: agent_token is only yielded in the respondOnly (clean text) path, not
      // when the decision is extracted from agent_decide JSON.
      mockDirectRespond("查询结果：产品价格为299元");

      const events = await collectEvents(
        service.run("conv-contract", "查询产品价格", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const types = eventTypes(events);
      expect(types[0]).toBe("agent_meta");
      expect(types).toContain("agent_think");
      expect(types).toContain("agent_respond");
      expect(types[types.length - 1]).toBe("agent_done");
    }, 10000);

    it("yields agent_meta with required fields", async () => {
      mockNormalToolThenRespond();

      const events = await collectEvents(
        service.run("conv-contract", "查询产品价格", {
          maxIterations: 2,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const meta = events.find((e) => e.type === "agent_meta");
      expect(meta).toBeDefined();
      expect((meta as unknown as Record<string, unknown>).session_id).toBeTruthy();
      expect((meta as unknown as Record<string, unknown>).model).toBeTruthy();
      expect((meta as unknown as Record<string, unknown>).provider).toBeTruthy();
      expect((meta as unknown as Record<string, unknown>).max_iterations).toBe(2);
    }, 10000);

    it("yields agent_done with required fields on success", async () => {
      mockDirectRespond("查询结果：产品价格为299元");

      const events = await collectEvents(
        service.run("conv-contract", "查询产品价格", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const done = events.find((e) => e.type === "agent_done" as unknown) as unknown as Record<string, unknown>;
      expect(done).toBeDefined();
      expect(done.total_steps).toBeTypeOf("number");
      expect(done.session_id).toBeTruthy();
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 2: Direct respond path (no tools)
  // ═════════════════════════════════════════════════════════

  describe("Contract 2: Direct respond path", () => {
    it("completes without agent_observe when no tools are called", async () => {
      mockDirectRespond("这是您的答案。");

      const events = await collectEvents(
        service.run("conv-contract", "简单问题", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const types = eventTypes(events);
      expect(types).toContain("agent_respond");
      expect(types).not.toContain("agent_observe"); // No tools called
      expect(types[types.length - 1]).toBe("agent_done");
    }, 10000);

    it("sets the final content to the LLM response", async () => {
      mockDirectRespond("产品A的价格是299元");

      const events = await collectEvents(
        service.run("conv-contract", "产品A价格", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const respond = events.find((e) => e.type === "agent_respond" as unknown) as unknown as Record<string, unknown>;
      expect(respond).toBeDefined();
      // The content is embedded in the agent_respond event
      expect(respond.content).toContain("299元");
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 3: ask_user → pause (no agent_done)
  // ═════════════════════════════════════════════════════════

  describe("Contract 3: ask_user → pause", () => {
    it("yields agent_ask_user with question and session_id", async () => {
      mockAskUser("请问您需要查询的是哪款产品？");

      const events = await collectEvents(
        service.run("conv-contract", "查产品", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const askEvent = events.find((e) => e.type === "agent_ask_user" as unknown) as unknown as Record<string, unknown>;
      expect(askEvent).toBeDefined();
      expect(askEvent.question).toBeDefined();
      expect(askEvent.session_id).toBeDefined();

      // Paused session must NOT have agent_done
      const doneEvent = events.find((e) => e.type === "agent_done");
      expect(doneEvent).toBeUndefined();
    }, 10000);

    it("saves session as paused in session store", async () => {
      mockAskUser("请确认您的需求");

      await collectEvents(
        service.run("conv-contract", "查产品", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      // Session store should contain the paused session
      const sessions = Array.from(sessionStore.values());
      const pausedSession = sessions.find((s) => s.status === "paused");
      expect(pausedSession).toBeDefined();
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 4: Degrade (non-terminating)
  // ═════════════════════════════════════════════════════════

  describe("Contract 4: LLM degrade → continue (non-terminating)", () => {
    it("yields agent_degraded and does NOT terminate on first degradation", async () => {
      mockDegrade();

      const events = await collectEvents(
        service.run("conv-contract", "复杂查询", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const types = eventTypes(events);
      expect(types).toContain("agent_degraded");

      // After degrade, agent continues to next iteration — eventually reaches max
      expect(types).toContain("agent_error");
    }, 10000);

    it("the degrade reason is included in the event", async () => {
      mockDegrade("OpenAI API timeout");

      const events = await collectEvents(
        service.run("conv-contract", "查询", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const degraded = events.find((e) => e.type === "agent_degraded" as unknown) as unknown as Record<string, unknown>;
      expect(degraded).toBeDefined();
      expect(degraded.reason).toContain("timeout");
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 5: Event ordering invariants
  // ═════════════════════════════════════════════════════════

  describe("Contract 5: Event ordering invariants", () => {
    it("meta is always the first event", async () => {
      mockDirectRespond("Hello");

      const events = await collectEvents(
        service.run("conv-contract", "Hi", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      expect(events[0].type).toBe("agent_meta");
    }, 10000);

    it("agent_responding precedes agent_respond", async () => {
      mockDirectRespond("Answer text");

      const events = await collectEvents(
        service.run("conv-contract", "Question", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const respondingIdx = events.findIndex((e) => e.type === "agent_responding");
      const respondIdx = events.findIndex((e) => e.type === "agent_respond");

      expect(respondingIdx).toBeGreaterThan(-1);
      expect(respondIdx).toBeGreaterThan(respondingIdx);
    }, 10000);

    it("agent_clear_stream appears before agent_responding on tool_call path", async () => {
      mockNormalToolThenRespond();

      const events = await collectEvents(
        service.run("conv-contract", "查询", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const clearIdx = events.findIndex((e) => e.type === "agent_clear_stream");
      const respondingIdx = events.findIndex((e) => e.type === "agent_responding");

      // On tool_call path, clear_stream comes before responding
      if (clearIdx !== -1 && respondingIdx !== -1) {
        expect(clearIdx).toBeLessThan(respondingIdx);
      }
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 6: skipMessageSave options
  // ═════════════════════════════════════════════════════════

  describe("Contract 6: skipUserMessageSave / skipAssistantMessageSave", () => {
    it("skips saving user message when skipUserMessageSave is true", async () => {
      mockDirectRespond("Response");

      messageStore.set("conv-contract", []);

      await collectEvents(
        service.run("conv-contract", "Task", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      // No messages should have been saved
      const messages = messageStore.get("conv-contract") || [];
      expect(messages.length).toBe(0);
    }, 10000);

    it("completes successfully with both skip flags", async () => {
      mockDirectRespond("OK");

      const events = await collectEvents(
        service.run("conv-contract", "Task", {
          maxIterations: 3,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      expect(events[events.length - 1].type).toBe("agent_done");
    }, 10000);
  });

  // ═════════════════════════════════════════════════════════
  // Contract 7: Max iterations enforced
  // ═════════════════════════════════════════════════════════

  describe("Contract 7: Max iterations enforced", () => {
    it("terminates with agent_error when max iterations reached", async () => {
      mockToolCallLoop();

      const events = await collectEvents(
        service.run("conv-contract", "Infinite task", {
          maxIterations: 2,
          skipUserMessageSave: true,
          skipAssistantMessageSave: true,
        }),
      );

      const types = eventTypes(events);
      expect(types).toContain("agent_error");
      expect(types[types.length - 1]).toBe("agent_error");

      const errorEvent = events[events.length - 1] as unknown as unknown as Record<string, unknown>;
      expect(errorEvent.error).toContain("Maximum iterations");
    }, 10000);
  });
});
