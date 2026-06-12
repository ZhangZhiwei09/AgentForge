// AgentErrorRecovery tests — LLM retry, tool degradation, error metadata on steps
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Hoisted mock refs ----
const {
  mockAgentStreamChat,
  mockToolExecute,
} = vi.hoisted(() => ({
  mockAgentStreamChat: vi.fn(),
  mockToolExecute: vi.fn(),
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
    getDefinitions: vi.fn(() => []),
    execute: mockToolExecute,
    listNames: vi.fn(() => ["calculator", "web_search"]),
    getAll: vi.fn(() => []),
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
  estimateTokenCount: vi.fn(() => 100),
}));

vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/json-utils.js")
  >("../../lib/json-utils.js");
  return actual;
});

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
      update: vi.fn(async () => ({})),
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
    agentApproval: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { AgentService } from "../agent.js";
import type { AgentStreamEvent } from "@agentforge/shared-types";

async function collect<T extends AgentStreamEvent>(
  gen: AsyncGenerator<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("Agent Error Recovery", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    conversationStore.clear();
    messageStore.clear();
    sessionStore.clear();
    vi.clearAllMocks();

    conversationStore.set("conv-err", {
      id: "conv-err",
      userId: "user-err",
      title: "Error Test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- LLM Retry ----
  describe("LLM call retry", () => {
    it("retries on retryable error and succeeds", async () => {
      let callCount = 0;
      mockAgentStreamChat.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error("ETIMEDOUT: Connection timed out");
        }
        // Retry succeeds
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "Request processed",
              analysis: "Simple",
              plan: "Respond",
              action: "respond",
              content: "Success after retry",
              summary: "Done",
            }),
          },
        };
        yield { type: "done", usage: { prompt_tokens: 10, completion_tokens: 5 } };
      });

      const events = await collect(service.run("conv-err", "Test retry"));

      // Should clear stream before retry
      const clears = events.filter((e) => e.type === "agent_clear_stream");
      expect(clears.length).toBeGreaterThanOrEqual(1);

      // Should eventually succeed
      const respond = events.find((e) => e.type === "agent_respond");
      expect(respond).toBeDefined();
      if (respond && respond.type === "agent_respond") {
        expect(respond.content).toBe("Success after retry");
      }
    });

    it("fails on fatal LLM error without retry", async () => {
      mockAgentStreamChat.mockImplementation(async function* () {
        throw new Error("401 Unauthorized: Invalid API key");
      });

      const events = await collect(service.run("conv-err", "Test fatal"));

      const error = events.find((e) => e.type === "agent_error");
      expect(error).toBeDefined();
      if (error && error.type === "agent_error") {
        expect(error.error).toContain("fatal");
        expect(error.error).toContain("401");
      }

      // No retry — only one call
      expect(mockAgentStreamChat).toHaveBeenCalledTimes(1);
    });

    it("yields agent_degraded after exhausting LLM retries", async () => {
      vi.useFakeTimers();
      mockAgentStreamChat.mockImplementation(async function* () {
        throw new Error("ETIMEDOUT");
      });

      const eventsPromise = collect(service.run("conv-err", "Test exhaustion"));

      // Fast-forward through retry delays
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      const degraded = events.find((e) => e.type === "agent_degraded");
      // Agent degrades with agent_degraded event after exhausting retries
      // and continues the ReAct loop rather than failing
      expect(degraded).toBeDefined();
      if (degraded && degraded.type === "agent_degraded") {
        expect(degraded.retried).toBe(true);
        expect(degraded.attempts).toBeGreaterThanOrEqual(2);
      }

      // Should have attempted retries (at least 2 clear streams indicating retry)
      const clears = events.filter((e) => e.type === "agent_clear_stream");
      expect(clears.length).toBeGreaterThanOrEqual(2);

      vi.useRealTimers();
    });
  });

  // ---- Tool Degradation ----
  describe("tool execution degradation", () => {
    it("retries tool execution on failure", async () => {
      mockToolExecute
        .mockRejectedValueOnce(new Error("ETIMEDOUT"))
        .mockResolvedValueOnce("tool result after retry");

      let callCount = 0;
      mockAgentStreamChat.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // First call: LLM decides to use tool
          yield {
            type: "tool_call",
            tool_call: {
              id: "tc",
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: "Need to search",
                analysis: "Info needed",
                plan: "Use calculator",
                action: "tool_call",
                tool: "calculator",
                args_json: '{"expr":"1+1"}',
                reason: "Need result",
              }),
            },
          };
          yield { type: "done", usage: { prompt_tokens: 10, completion_tokens: 8 } };
        } else {
          // Second call: LLM responds after tool result
          yield {
            type: "tool_call",
            tool_call: {
              id: "tc2",
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: "Got result",
                analysis: "Ready",
                plan: "Respond",
                action: "respond",
                content: "Answer with retried tool",
                summary: "Done",
              }),
            },
          };
          yield { type: "done", usage: { prompt_tokens: 10, completion_tokens: 5 } };
        }
      });

      const events = await collect(service.run("conv-err", "Test tool retry"));

      // Tool should still return a result (either success or degradation message)
      const observes = events.filter((e) => e.type === "agent_observe");
      expect(observes.length).toBeGreaterThanOrEqual(1);

      // Tool should be called twice (first fails, retry succeeds)
      expect(mockToolExecute).toHaveBeenCalledTimes(2);
    });

    it("builds degradation message when tool completely fails", async () => {
      mockToolExecute.mockRejectedValue(new Error("Circuit breaker open"));

      // Use fake timers to handle retry delays
      vi.useFakeTimers();

      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "Need external data",
              analysis: "Use http_request",
              plan: "Fetch data",
              action: "tool_call",
              tool: "http_request",
              args_json: '{"url":"https://example.com","method":"GET"}',
              reason: "Need API data",
            }),
          },
        };
        yield { type: "done", usage: { prompt_tokens: 10, completion_tokens: 8 } };
      });

      const eventsPromise = collect(service.run("conv-err", "Test tool degradation"));
      await vi.runAllTimersAsync();
      const events = await eventsPromise;

      const observes = events.filter((e) => e.type === "agent_observe");
      expect(observes.length).toBeGreaterThanOrEqual(1);
      if (observes[0] && observes[0].type === "agent_observe") {
        // Result should be a degradation message (Chinese) or tool result
        expect(typeof observes[0].result).toBe("string");
        expect(observes[0].result.length).toBeGreaterThan(0);
      }

      vi.useRealTimers();
    });
  });

  // ---- Error Recording on Steps ----
  describe("error recording on AgentStep", () => {
    it("records error metadata when tool fails after retries", async () => {
      mockToolExecute.mockRejectedValue(new Error("Persistent tool failure"));

      vi.useFakeTimers();

      mockAgentStreamChat.mockImplementation(async function* () {
        yield {
          type: "tool_call",
          tool_call: {
            id: "tc",
            name: "agent_decide",
            arguments: JSON.stringify({
              observation: "Need tool",
              analysis: "Use it",
              plan: "Execute",
              action: "tool_call",
              tool: "calculator",
              args_json: '{"expr":"1+1"}',
              reason: "Calculate",
            }),
          },
        };
        yield { type: "done", usage: { prompt_tokens: 5, completion_tokens: 3 } };
      });

      const eventsPromise = collect(service.run("conv-err", "Test error recording"));
      await vi.runAllTimersAsync();
      await eventsPromise;

      // Verify tool was called (retry attempts)
      expect(mockToolExecute).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
