// KnowledgeService tests — inverted index BM25, hybrid search scoring
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Mock prisma with knowledgeInvertedIndex
vi.mock("../../db.js", () => {
  const mockPrisma = {
    knowledgeChunk: {
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    knowledgeBase: {
      findMany: vi.fn(),
    },
    knowledgeDocument: {
      findMany: vi.fn(),
    },
    knowledgeInvertedIndex: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
  return { prisma: mockPrisma };
});

// Mock milvus
vi.mock("../milvus.js", () => ({
  getMilvusClient: vi.fn(),
  MILVUS_KNOWLEDGE_COLLECTION: "knowledge_collection",
  EMBEDDING_DIM: 768,
  ensureKnowledgeCollection: vi.fn(),
}));

// Mock embeddings
vi.mock("../embeddings.js", () => ({
  getDefaultEmbeddingProvider: vi.fn(() => null),
}));

// Mock provider registry
vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(),
  listProviders: vi.fn(() => []),
  resolveModel: vi.fn(() => ["openai", "gpt-4o-mini"]),
}));

describe("KnowledgeService", () => {
  let KnowledgeService: typeof import("../knowledge.js").KnowledgeService;

  beforeAll(async () => {
    const mod = await import("../knowledge.js");
    KnowledgeService = mod.KnowledgeService;
  });

  describe("lifecycle", () => {
    it("should create service instance without error", () => {
      const service = new KnowledgeService();
      expect(service).toBeDefined();
    });
  });

  describe("search", () => {
    it("should return empty results for empty query", async () => {
      const service = new KnowledgeService();
      const results = await service.search("");
      expect(results).toEqual([]);
    });

    it("should return empty results when no embedding provider is configured", async () => {
      const service = new KnowledgeService();
      const results = await service.search("test query");
      expect(results).toEqual([]);
    });
  });
});
