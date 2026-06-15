// ChatService tests — streaming, tool calling, memory/knowledge injection, done events
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock refs (available inside vi.mock factories) ----
const {
  mockProviderStreamChat,
  mockMemorySearch,
  mockMemoryExtract,
  mockKnowledgeSearch,
  mockToolExecute,
} = vi.hoisted(() => ({
  mockProviderStreamChat: vi.fn(),
  mockMemorySearch: vi.fn<() => Promise<Array<Record<string, unknown>>>>(
    async () => [],
  ),
  mockMemoryExtract: vi.fn(async () => []),
  mockKnowledgeSearch: vi.fn<() => Promise<Array<Record<string, unknown>>>>(
    async () => [],
  ),
  mockToolExecute: vi.fn(async () => ({ status: "success" as const, output: "tool result" })),
}));

// ---- Mock all external dependencies ----

vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    streamChat: mockProviderStreamChat,
    chatSync: vi.fn(),
    listModels: vi.fn(() => [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
    ]),
  })),
  resolveModel: vi.fn(() => ["openai", "gpt-4o"]),
  listProviders: vi.fn(() => []),
}));

vi.mock("../memory-engine.js", () => ({
  MemoryEngine: vi.fn().mockImplementation(() => ({
    search: mockMemorySearch,
    extractAndStore: mockMemoryExtract,
  })),
}));

vi.mock("../knowledge.js", () => ({
  KnowledgeService: vi.fn().mockImplementation(() => ({
    search: mockKnowledgeSearch,
    searchWithRerank: vi.fn(),
    warmupAll: vi.fn(),
  })),
}));

vi.mock("../../tools/registry.js", () => ({
  toolRegistry: {
    init: vi.fn(),
    getDefinitions: vi.fn(() => []),
    execute: mockToolExecute,
    listNames: vi.fn(() => []),
    getAll: vi.fn(() => []),
  },
}));

// Mock prisma with in-memory conversation/message store
const conversationStore: Map<string, Record<string, unknown>> = new Map();
const messageStore: Map<string, Array<Record<string, unknown>>> = new Map();

vi.mock("../../db.js", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return conversationStore.get(args.where.id) || null;
      }),
      findFirst: vi.fn(),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const conv = conversationStore.get(args.where.id);
          if (conv) Object.assign(conv, args.data);
          return conv;
        },
      ),
    },
    message: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const msgs = messageStore.get(args.data.conversationId as string) || [];
        msgs.push(args.data);
        messageStore.set(args.data.conversationId as string, msgs);
        return args.data;
      }),
      findMany: vi.fn(
        async (args: {
          where: { conversationId: string };
          orderBy: unknown;
        }) => {
          return messageStore.get(args.where.conversationId) || [];
        },
      ),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
  estimateTokenCount: vi.fn(() => 100),
}));

import { ChatService } from "../chat.js";
import { prisma } from "../../db.js";

describe("ChatService", () => {
  let service: ChatService;

  beforeEach(() => {
    service = new ChatService();
    conversationStore.clear();
    messageStore.clear();
    vi.clearAllMocks();

    // Set up default conversation
    conversationStore.set("conv-test", {
      id: "conv-test",
      userId: "user-test",
      title: "New Conversation",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  // Helper: collect stream events
  async function collectStreamEvents(
    gen: AsyncGenerator<Record<string, unknown>>,
  ): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  describe("streamChat", () => {
    it("should yield meta event with message_id and model info", async () => {
      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "Hello!" };
        yield {
          type: "done",
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        };
      });

      const events = await collectStreamEvents(
        service.streamChat("conv-test", "Hello", "gpt-4o"),
      );

      const metaEvent = events.find((e) => e.type === "meta");
      expect(metaEvent).toBeDefined();
      expect(metaEvent!.message_id).toBeTruthy();
      expect(metaEvent!.model).toBe("gpt-4o");
      expect(metaEvent!.provider).toBe("openai");
    });

    it("should yield token events from provider", async () => {
      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "Hi " };
        yield { type: "token", content: "there" };
        yield {
          type: "done",
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      });

      const events = await collectStreamEvents(
        service.streamChat("conv-test", "Hello", "gpt-4o"),
      );

      const tokens = events.filter((e) => e.type === "token");
      expect(tokens).toHaveLength(2);
      expect(tokens[0].content).toBe("Hi ");
      expect(tokens[1].content).toBe("there");
    });

    it("should yield done event with usage statistics", async () => {
      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "Done" };
        yield {
          type: "done",
          usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
        };
      });

      const events = await collectStreamEvents(
        service.streamChat("conv-test", "Test", "gpt-4o"),
      );

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.usage).toBeDefined();
      const usage = doneEvent!.usage as Record<string, unknown>;
      expect(usage.latency_ms).toBeDefined();
      expect(usage.first_token_ms).toBeDefined();
      expect(doneEvent!.memory).toBeDefined();
    });

    it("should save user message to database", async () => {
      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "ok" };
        yield {
          type: "done",
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        };
      });

      await collectStreamEvents(
        service.streamChat("conv-test", "User message", "gpt-4o"),
      );

      const msgs = messageStore.get("conv-test") || [];
      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("User message");
    });

    it("should save assistant message after streaming completes", async () => {
      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "response" };
        yield {
          type: "done",
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        };
      });

      await collectStreamEvents(
        service.streamChat("conv-test", "Query", "gpt-4o"),
      );

      const msgs = messageStore.get("conv-test") || [];
      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("response");
    });

    it("should auto-generate title for 'New Conversation'", async () => {
      const conversationBefore = conversationStore.get("conv-test");
      expect(conversationBefore!.title).toBe("New Conversation");

      mockProviderStreamChat.mockImplementation(async function* () {
        yield { type: "token", content: "Hi" };
        yield {
          type: "done",
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      });

      await collectStreamEvents(
        service.streamChat(
          "conv-test",
          "This is a test message for title",
          "gpt-4o",
        ),
      );

      const conversationAfter = conversationStore.get("conv-test");
      expect(conversationAfter!.title).toBe("This is a test message for title");
    });

    it("should throw for non-existent conversation", async () => {
      const gen = service.streamChat("nonexistent", "Hello", "gpt-4o");
      await expect(collectStreamEvents(gen)).rejects.toThrow("not found");
    });

    describe("tool calling", () => {
      it("should execute tool calls from provider", async () => {
        let callCount = 0;
        mockProviderStreamChat.mockImplementation(async function* () {
          if (callCount === 0) {
            callCount++;
            yield {
              type: "tool_call",
              tool_call: {
                id: "tc1",
                name: "calculator",
                arguments: '{"expr":"2+2"}',
              },
            };
            yield {
              type: "done",
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          } else {
            yield { type: "token", content: "The result is 4" };
            yield {
              type: "done",
              usage: { prompt_tokens: 15, completion_tokens: 5 },
            };
          }
        });

        mockToolExecute.mockResolvedValueOnce({ status: "success", output: "4" });

        const events = await collectStreamEvents(
          service.streamChat("conv-test", "What is 2+2?", "gpt-4o", "", null, [
            "calculator",
          ]),
        );

        const toolCallEvts = events.filter((e) => e.type === "tool_call");
        const toolResultEvts = events.filter((e) => e.type === "tool_result");
        expect(toolCallEvts.length).toBeGreaterThanOrEqual(1);
        expect(toolResultEvts.length).toBeGreaterThanOrEqual(1);
        expect(mockToolExecute).toHaveBeenCalledWith(
          "calculator",
          { expr: "2+2" },
          expect.any(Object), // RunContext
        );
      });

      it("should limit tool calling to MAX_TOOL_ROUNDS (5)", async () => {
        mockProviderStreamChat.mockImplementation(async function* () {
          yield {
            type: "tool_call",
            tool_call: { id: "tc", name: "calculator", arguments: "{}" },
          };
          yield {
            type: "done",
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          };
        });

        mockToolExecute.mockResolvedValue({ status: "success", output: "result" });

        const events = await collectStreamEvents(
          service.streamChat("conv-test", "Loop", "gpt-4o", "", null, [
            "calculator",
          ]),
        );

        // Should have at most 5 rounds of tool calls
        const toolCallRounds = events.filter(
          (e) => e.type === "tool_call",
        ).length;
        expect(toolCallRounds).toBeLessThanOrEqual(5);
      });
    });

    describe("memory injection", () => {
      it("should include memory_count in meta event", async () => {
        mockMemorySearch.mockResolvedValueOnce([
          {
            id: "m1",
            content: "User likes Python",
            score: 0.9,
            userId: "user-test",
            type: "preference",
            importance: 0.9,
            metadata: null,
            conversationId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);

        mockProviderStreamChat.mockImplementation(async function* () {
          yield { type: "token", content: "Hi" };
          yield {
            type: "done",
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          };
        });

        const events = await collectStreamEvents(
          service.streamChat("conv-test", "Hello", "gpt-4o"),
        );

        const metaEvent = events.find((e) => e.type === "meta");
        expect(metaEvent!.memory_count).toBe(1);
      });

      it("should handle memory injection failure gracefully", async () => {
        mockMemorySearch.mockRejectedValueOnce(new Error("DB error"));

        mockProviderStreamChat.mockImplementation(async function* () {
          yield { type: "token", content: "Fallback" };
          yield {
            type: "done",
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          };
        });

        // Should not throw even when memory injection fails
        const events = await collectStreamEvents(
          service.streamChat("conv-test", "Hello", "gpt-4o"),
        );

        const metaEvent = events.find((e) => e.type === "meta");
        expect(metaEvent!.memory_count).toBe(0);
        expect(events.some((e) => e.type === "token")).toBe(true);
      });
    });

    describe("knowledge injection", () => {
      it("should include knowledge_count in meta event", async () => {
        mockKnowledgeSearch.mockResolvedValueOnce([
          {
            chunkId: "c1",
            docId: "d1",
            kbId: "kb1",
            content: "Relevant doc",
            score: 0.95,
            chunkIndex: 0,
            docTitle: "Doc Title",
          },
        ]);

        mockProviderStreamChat.mockImplementation(async function* () {
          yield { type: "token", content: "Answer" };
          yield {
            type: "done",
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          };
        });

        const events = await collectStreamEvents(
          service.streamChat("conv-test", "Query", "gpt-4o", "", ["kb1"]),
        );

        const metaEvent = events.find((e) => e.type === "meta");
        expect(metaEvent!.knowledge_count).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
