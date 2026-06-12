// AgentService tests — ReAct loop, tool_call/respond/ask_user, max iterations, parse fallback
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock refs ----
const {
  mockAgentStreamChat,
  mockToolExecute,
  mockToolListNames,
  mockToolGetDefinitions,
  mockTruncateHistory,
} = vi.hoisted(() => ({
  mockAgentStreamChat: vi.fn(),
  mockToolExecute: vi.fn(async () => "tool result"),
  mockToolListNames: vi.fn(() => ["calculator", "web_search"]),
  mockToolGetDefinitions: vi.fn(() => []),
  mockTruncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
}));

// ---- Mocks ----

vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    streamChat: mockAgentStreamChat,
    chatSync: vi.fn(),
    listModels: vi.fn(() => [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
    ]),
  })),
  resolveModel: vi.fn(() => ["openai", "gpt-4o"]),
  listProviders: vi.fn(() => []),
}));

vi.mock("../../tools/registry.js", () => ({
  toolRegistry: {
    init: vi.fn(),
    getDefinitions: mockToolGetDefinitions,
    execute: mockToolExecute,
    listNames: mockToolListNames,
    getAll: vi.fn(() => []),
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: mockTruncateHistory,
  estimateTokenCount: vi.fn(() => 100),
}));

// Use real json-utils (no mock needed — it's pure functions)
vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/json-utils.js")
  >("../../lib/json-utils.js");
  return actual;
});

// Use real shared-prompts for react_system_prompt
vi.mock("@agentforge/shared-prompts", () => ({
  react_system_prompt: {
    content: "You are a helpful agent. Use agent_decide for decisions.",
  },
}));

// Mock prisma
const conversationStore = new Map<string, Record<string, unknown>>();
const messageStore = new Map<string, Array<Record<string, unknown>>>();
const sessionStore = new Map<string, Record<string, unknown>>();

vi.mock("../../db.js", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return conversationStore.get(args.where.id) || null;
      }),
      findFirst: vi.fn(async () => null),
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
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return sessionStore.get(args.where.id) || null;
      }),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { AgentService } from "../agent.js";
import type { AgentStreamEvent } from "@agentforge/shared-types";

describe("AgentService", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    conversationStore.clear();
    messageStore.clear();
    sessionStore.clear();
    vi.clearAllMocks();

    conversationStore.set("conv-agent", {
      id: "conv-agent",
      userId: "user-agent",
      title: "Agent Test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  async function collectAgentEvents(
    gen: AsyncGenerator<AgentStreamEvent>,
  ): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  describe("run", () => {
    it("should yield agent_meta event with session info", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "obs",
              analysis: "an",
              plan: "pl",
              action: "respond",
              content: "Done!",
              summary: "Completed",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "Do something"),
      );

      const meta = events.find((e) => e.type === "agent_meta");
      expect(meta).toBeDefined();
      expect(meta!.session_id).toBeTruthy();
      expect(meta!.model).toBe("gpt-4o");
    });

    it("should yield agent_think event with observation/analysis/plan", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "The user asked a question",
              analysis: "Simple query",
              plan: "Answer directly",
              action: "respond",
              content: "Here is your answer.",
              summary: "Answered question",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "What is the weather?"),
      );

      const think = events.find((e) => e.type === "agent_think");
      expect(think).toBeDefined();
      if (think && think.type === "agent_think") {
        expect(think.observation).toBeTruthy();
        expect(think.analysis).toBeTruthy();
        expect(think.plan).toBeTruthy();
      }
    });

    it("should handle respond decision from agent_decide", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "obs",
              analysis: "an",
              plan: "pl",
              action: "respond",
              content: "Final answer",
              summary: "Done",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "Solve task"),
      );

      const respond = events.find((e) => e.type === "agent_respond");
      expect(respond).toBeDefined();
      if (respond && respond.type === "agent_respond") {
        expect(respond.content).toBe("Final answer");
        expect(respond.summary).toBe("Done");
      }

      const done = events.find((e) => e.type === "agent_done");
      expect(done).toBeDefined();
    });

    it("should handle tool_call decision from agent_decide", async () => {
      let streamCallCount = 0;
      mockAgentStreamChat.mockImplementation(async function* () {
        if (streamCallCount === 0) {
          streamCallCount++;
          // First call: LLM decides to use a tool
          yield {
            type: "tool_call",
            tool_call: {
              id: "tc",
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: "Need to calculate",
                analysis: "Math required",
                plan: "Use calculator",
                action: "tool_call",
                tool: "calculator",
                args_json: '{"expr":"2+2"}',
                reason: "Need math",
              }),
            },
          };
          yield {
            type: "done",
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          };
        } else {
          // Second call: LLM responds after tool result
          yield {
            type: "tool_call",
            tool_call: {
              id: "tc2",
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: "Got result 4",
                analysis: "Answer ready",
                plan: "Respond",
                action: "respond",
                content: "The answer is 4",
                summary: "Calculated 2+2",
              }),
            },
          };
          yield {
            type: "done",
            usage: { prompt_tokens: 15, completion_tokens: 5 },
          };
        }
      });

      mockToolExecute.mockResolvedValueOnce("4");

      const events = await collectAgentEvents(
        service.run("conv-agent", "Calculate 2+2"),
      );

      // Should have agent_act for tool_call
      const actEvents = events.filter((e) => e.type === "agent_act");
      expect(actEvents.length).toBeGreaterThanOrEqual(1);

      // Should have agent_observe with tool result
      const observe = events.find((e) => e.type === "agent_observe");
      expect(observe).toBeDefined();

      // Should eventually respond
      const respond = events.find((e) => e.type === "agent_respond");
      expect(respond).toBeDefined();

      // Should complete
      const done = events.find((e) => e.type === "agent_done");
      expect(done).toBeDefined();
    });

    it("should handle ask_user decision — pause session", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "Ambiguous request",
              analysis: "Need clarification",
              plan: "Ask user",
              action: "ask_user",
              question: "Which file do you want me to read?",
              clarify_context: "Multiple files found",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 8, completion_tokens: 5 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "Read the file"),
      );

      const askUser = events.find((e) => e.type === "agent_ask_user");
      expect(askUser).toBeDefined();
      if (askUser && askUser.type === "agent_ask_user") {
        expect(askUser.question).toBe("Which file do you want me to read?");
        expect(askUser.session_id).toBeTruthy();
      }
    });

    it("should fall back to JSON text parsing when agent_decide not called", async () => {
      // LLM returns JSON text instead of tool_call
      const decisionJSON = JSON.stringify({
        observation: "task is simple",
        analysis: "no tools needed",
        plan: "respond directly",
        decision: {
          action: "respond",
          content: "Simple answer",
          summary: "Done",
        },
      });

      mockAgentStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: decisionJSON };
        yield {
          type: "done",
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "Simple question"),
      );

      // Should still work via parseStep fallback
      const respond = events.find((e) => e.type === "agent_respond");
      expect(respond).toBeDefined();

      const done = events.find((e) => e.type === "agent_done");
      expect(done).toBeDefined();
    });

    it("should handle max iterations — stop and yield error", async () => {
      // Always return tool_call to force another iteration
      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "Still working",
              analysis: "Need more",
              plan: "Keep going",
              action: "tool_call",
              tool: "calculator",
              args_json: "{}",
              reason: "loop",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
      });

      mockToolExecute.mockResolvedValue("ok");

      const events = await collectAgentEvents(
        service.run("conv-agent", "Infinite loop task", { maxIterations: 3 }),
      );

      const error = events.find((e) => e.type === "agent_error");
      expect(error).toBeDefined();
      if (error && error.type === "agent_error") {
        expect(error.error).toContain("Maximum iterations");
      }
    });

    it("should yield agent_error for non-existent conversation", async () => {
      const events = await collectAgentEvents(
        service.run("nonexistent", "Task"),
      );

      const error = events.find((e) => e.type === "agent_error");
      expect(error).toBeDefined();
      if (error && error.type === "agent_error") {
        expect(error.error).toContain("not found");
      }
    });

    it("should yield agent_token events during streaming", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "The " };
        yield { type: "token", content: "answer " };
        yield { type: "token", content: "is 42" };
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "o",
              analysis: "a",
              plan: "p",
              action: "respond",
              content: "The answer is 42",
              summary: "done",
            }),
          },
        };
        yield {
          type: "done",
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "What is the answer?"),
      );

      const tokens = events.filter((e) => e.type === "agent_token");
      expect(tokens.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle provider stream errors gracefully", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        throw new Error("API connection failed");
      });

      const events = await collectAgentEvents(
        service.run("conv-agent", "Test"),
      );

      // With retry logic, the agent retries LLM failures and degrades gracefully
      // rather than immediately failing. Check for either error or degradation.
      const error = events.find((e) => e.type === "agent_error");
      const degraded = events.find((e) => e.type === "agent_degraded");
      expect(error || degraded).toBeDefined();
    });
  });

  describe("getSessions", () => {
    it("should return empty array when no sessions exist", async () => {
      const sessions = await service.getSessions("conv-agent");
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions).toHaveLength(0);
    });
  });

  describe("getSession", () => {
    it("should return null for non-existent session", async () => {
      const session = await service.getSession("nonexistent");
      expect(session).toBeNull();
    });
  });
});
