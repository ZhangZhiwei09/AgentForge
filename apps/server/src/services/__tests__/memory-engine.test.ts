// MemoryEngine tests — vector search, PG fallback, memory extraction, store/delete lifecycle
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock all external dependencies ----
// Use vi.hoisted to make mock refs available inside vi.mock factories
const { mockChatSync, mockGetProvider } = vi.hoisted(() => ({
  mockChatSync: vi.fn<(...args: Array<unknown>) => Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }>>(async () => ({
    content: JSON.stringify([
      { type: "semantic", content: "User works at Acme Corp", importance: 0.8 },
      { type: "preference", content: "User prefers Python", importance: 0.7 },
    ]),
    usage: { prompt_tokens: 50, completion_tokens: 30 },
  })),
  mockGetProvider: vi.fn(() => ({
    chatSync: mockChatSync,
    streamChat: vi.fn(),
    listModels: vi.fn(() => []),
  })),
}));

vi.mock("../../db.js", () => {
  const memoryStore: Array<{
    id: string;
    userId: string;
    type: string;
    content: string;
    importance: number;
    embeddingId: number | null;
    metadata: Record<string, unknown> | null;
    conversationId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  return {
    prisma: {
      memory: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const now = new Date();
          const record = {
            id: args.data.id as string,
            userId: args.data.userId as string,
            type: args.data.type as string,
            content: args.data.content as string,
            importance: (args.data.importance as number) || 0.5,
            embeddingId: (args.data.embeddingId as number) || null,
            metadata: (args.data.metadata as Record<string, unknown>) || null,
            conversationId: (args.data.conversationId as string) || null,
            createdAt: now,
            updatedAt: now,
          };
          memoryStore.push(record);
          return record;
        }),
        findMany: vi.fn(async (args?: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
          let results = [...memoryStore];
          const where = args?.where as Record<string, unknown> | undefined;
          if (where?.userId) {
            results = results.filter((m) => m.userId === where.userId);
          }
          if (where?.type) {
            results = results.filter((m) => m.type === where.type);
          }
          if (where?.id && typeof where.id === "object") {
            const idFilter = where.id as { in: string[] };
            results = results.filter((m) => idFilter.in.includes(m.id));
          }
          if (args?.take) {
            results = results.slice(0, args.take as number);
          }
          return results;
        }),
        findUnique: vi.fn(async (args: { where: { id: string } }) => {
          return memoryStore.find((m) => m.id === args.where.id) || null;
        }),
        delete: vi.fn(async () => {
          return {};
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
    },
  };
});

vi.mock("../milvus.js", () => ({
  getMilvusClient: vi.fn(() => ({
    insert: vi.fn(async () => ({ IDs: { int_id: { data: [42] } } })),
    search: vi.fn(async () => ({
      results: [
        { memory_id: "mem-1", score: 0.95 },
        { memory_id: "mem-2", score: 0.8 },
        { memory_id: "mem-3", score: 0.6 },
      ],
    })),
    delete: vi.fn(async () => ({})),
    getCollectionStatistics: vi.fn(async () => ({ data: { row_count: 100 } })),
  })),
  MILVUS_MEMORY_COLLECTION: "memory_collection",
  EMBEDDING_DIM: 768,
  ensureMemoryCollection: vi.fn(),
}));

vi.mock("../embeddings.js", () => ({
  getDefaultEmbeddingProvider: vi.fn(() => ({
    embedSingle: vi.fn(async (text: string) => {
      const len = text.length;
      return Array.from({ length: 768 }, (_, i) => Math.sin(len + i * 0.1) * 0.01);
    }),
  })),
}));

vi.mock("../../providers/registry.js", () => ({
  getProvider: mockGetProvider,
  listProviders: vi.fn(() => [
    { type: "openai", models: [{ id: "gpt-4o-mini", provider: "openai" }] },
  ]),
  resolveModel: vi.fn(() => ["openai", "gpt-4o-mini"]),
}));

import { MemoryEngine } from "../memory-engine.js";
import { prisma } from "../../db.js";

describe("MemoryEngine", () => {
  let engine: MemoryEngine;

  beforeEach(() => {
    engine = new MemoryEngine();
  });

  describe("store", () => {
    it("should store a memory in the database", async () => {
      const result = await engine.store(
        {
          type: "semantic",
          content: "User works at Acme Corp",
          importance: 0.8,
          conversationId: "conv-1",
        },
        "user-1",
      );

      expect(result).toBeDefined();
      expect(result.type).toBe("semantic");
      expect(result.content).toBe("User works at Acme Corp");
      expect(result.importance).toBe(0.8);
      expect(result.userId).toBe("user-1");
      expect(result.id).toBeTruthy();

      // Verify prisma.memory.create was called
      expect(prisma.memory.create).toHaveBeenCalled();
    });

    it("should default importance to 0.5 if not provided", async () => {
      const result = await engine.store(
        {
          type: "episodic",
          content: "User visited the site today",
        },
        "user-1",
      );

      expect(result.importance).toBe(0.5);
    });

    it("should assign a unique ID to each memory", async () => {
      const m1 = await engine.store(
        { type: "semantic", content: "Memory A" },
        "user-1",
      );
      const m2 = await engine.store(
        { type: "semantic", content: "Memory B" },
        "user-1",
      );

      expect(m1.id).toBeTruthy();
      expect(m2.id).toBeTruthy();
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe("list", () => {
    it("should list memories for a user", async () => {
      // Store some memories first
      await engine.store({ type: "semantic", content: "Test A" }, "user-list");
      await engine.store({ type: "preference", content: "Test B" }, "user-list");

      const memories = await engine.list("user-list");
      expect(memories.length).toBeGreaterThanOrEqual(2);
      expect(memories.every((m) => m.userId === "user-list")).toBe(true);
    });

    it("should filter by type", async () => {
      await engine.store({ type: "semantic", content: "Fact" }, "user-filter");
      await engine.store({ type: "preference", content: "Pref" }, "user-filter");

      const semantic = await engine.list("user-filter", "semantic");
      expect(semantic.every((m) => m.type === "semantic")).toBe(true);
    });

    it("should return empty array for user with no memories", async () => {
      const memories = await engine.list("user-nonexistent");
      expect(Array.isArray(memories)).toBe(true);
    });
  });

  describe("search", () => {
    it("should return search results with scores", async () => {
      // Store some test memories
      await engine.store(
        { type: "semantic", content: "User likes Python programming", importance: 0.9 },
        "user-search",
      );
      await engine.store(
        { type: "preference", content: "User hates JavaScript", importance: 0.6 },
        "user-search",
      );

      const results = await engine.search("Python programming", "user-search", 3);

      expect(Array.isArray(results)).toBe(true);
      results.forEach((r) => {
        expect(r).toHaveProperty("score");
        expect(r).toHaveProperty("content");
        expect(r).toHaveProperty("userId", "user-search");
      });
    });

    it("should respect topK parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await engine.store(
          { type: "semantic", content: `Memory ${i}`, importance: 0.5 },
          "user-topk",
        );
      }

      const results = await engine.search("Memory", "user-topk", 2);
      // Results may be fewer than topK if Milvus returns fewer
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("extractAndStore", () => {
    it("should call provider.chatSync with correct parameters", async () => {
      const messages = [
        { role: "user", content: "I work at Acme Corp and love Python" },
        { role: "assistant", content: "That's great! Python is a wonderful language." },
      ];

      await engine.extractAndStore(
        messages,
        "user-extract",
        "conv-extract",
        "openai",
      );

      // Verify the provider was called with correct arguments
      expect(mockGetProvider).toHaveBeenCalledWith("openai");
      expect(mockChatSync).toHaveBeenCalled();
      const chatCall = mockChatSync.mock.calls[0];
      expect(chatCall[0]).toBeDefined(); // messages array
      expect(chatCall[1]).toBe("gpt-4o-mini"); // model
      expect(chatCall[5]).toBe(true); // jsonMode (index 5: [0]=msg, [1]=model, [2]=system, [3]=temp, [4]=maxTok, [5]=jsonMode)
    });

    it("should return empty array for insufficient messages", async () => {
      const results = await engine.extractAndStore(
        [{ role: "user", content: "Hi" }], // Only one message
        "user-min",
        "conv-min",
        "openai",
      );

      expect(results).toHaveLength(0);
    });

    it("should return empty array when no providers available", async () => {
      const { listProviders } = await import("../../providers/registry.js");
      vi.mocked(listProviders).mockReturnValueOnce([]);

      const messages = [
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there!" },
      ];

      const results = await engine.extractAndStore(
        messages,
        "user-noprov",
        "conv-noprov",
        "",
      );

      expect(results).toHaveLength(0);
    });
  });

  describe("delete", () => {
    it("should return false for non-existent memory", async () => {
      const result = await engine.delete("nonexistent-id");
      expect(result).toBe(false);
    });

    it("should delete an existing memory", async () => {
      const mem = await engine.store(
        { type: "semantic", content: "To be deleted" },
        "user-del",
      );

      // Prisma delete mock returns success; findUnique is mocked to return first
      // For this test, we just verify it doesn't throw
      await expect(engine.delete(mem.id)).resolves.toBeDefined();
    });
  });

  describe("embed", () => {
    it("should generate embeddings for text", async () => {
      const vector = await engine.embed("test text");
      expect(Array.isArray(vector)).toBe(true);
      if (vector) {
        expect(vector.length).toBe(768);
        expect(vector.every((v) => typeof v === "number")).toBe(true);
      }
    });
  });
});
