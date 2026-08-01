// KnowledgeService tests — inverted index BM25, hybrid search scoring, adjacent chunk dedup
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Dedup tests don't need mocks — import directly
import { dedupeAdjacentChunks, computeTokenOverlap } from "../knowledge.js";

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
  };
  return { prisma: mockPrisma };
});

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

// ── 相邻 Chunk 去重测试 ────────────────────────────────────

interface DedupCandidate {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  chunkIndex: number;
  docTitle: string;
}

function makeCandidate(
  id: string,
  docId: string,
  chunkIndex: number,
  content: string,
  score: number,
): DedupCandidate {
  return {
    chunkId: id,
    docId,
    kbId: "kb-test",
    content,
    score,
    chunkIndex,
    docTitle: `Doc ${docId}`,
  };
}

describe("computeTokenOverlap", () => {
  it("should return 0 for empty strings", () => {
    expect(computeTokenOverlap("", "")).toBe(0);
    expect(computeTokenOverlap("a", "")).toBe(0);
    expect(computeTokenOverlap("", "b")).toBe(0);
  });

  it("should return 1 for identical strings", () => {
    expect(computeTokenOverlap("hello world", "hello world")).toBe(1);
    expect(computeTokenOverlap("测试文本", "测试文本")).toBe(1);
  });

  it("should return 0 for completely different strings", () => {
    const score = computeTokenOverlap("abcdefgh", "12345678");
    expect(score).toBeLessThan(0.1);
  });

  it("should detect partial overlap", () => {
    const score = computeTokenOverlap("hello world today", "hello world tomorrow");
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.9);
  });

  it("should handle Chinese text overlap", () => {
    const highScore = computeTokenOverlap(
      "这是关于知识库分片的测试文本",
      "这是关于知识库分片的测试文本——续",
    );
    expect(highScore).toBeGreaterThan(0.5);

    const lowScore = computeTokenOverlap(
      "这是关于知识库分片的测试文本",
      "完全不同的内容没有重叠",
    );
    expect(lowScore).toBeLessThan(0.2);
  });
});

describe("dedupeAdjacentChunks", () => {
  it("should return all candidates when no duplicates", () => {
    const candidates = [
      makeCandidate("c1", "doc-a", 0, "First chunk about cats.", 0.95),
      makeCandidate("c2", "doc-b", 0, "Second chunk about dogs.", 0.85),
      makeCandidate("c3", "doc-c", 0, "Third chunk about birds.", 0.75),
    ];

    const result = dedupeAdjacentChunks(candidates);
    expect(result.kept).toHaveLength(3);
    expect(result.removed).toHaveLength(0);
  });

  it("should remove adjacent chunks from same document (keep higher score)", () => {
    const candidates = [
      makeCandidate("c1", "doc-a", 0, "Chunk 0 about topic X.", 0.95),
      makeCandidate("c2", "doc-a", 1, "Chunk 1 about topic X continued.", 0.85),
      makeCandidate("c3", "doc-a", 5, "Chunk 5 about topic X far away.", 0.75),
    ];

    const result = dedupeAdjacentChunks(candidates);
    // c2 与 c1 相邻（距离 1），应被移除
    // c3 与 c1 距离 5 > neighborWindow(1)，应保留
    expect(result.kept).toHaveLength(2);
    expect(result.kept[0].chunkId).toBe("c1"); // 高分保留
    expect(result.kept[1].chunkId).toBe("c3"); // 距离远，保留
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].chunkId).toBe("c2");
  });

  it("should respect custom neighborWindow", () => {
    const candidates = [
      makeCandidate("c1", "doc-a", 0, "Chunk 0.", 0.95),
      makeCandidate("c2", "doc-a", 2, "Chunk 2.", 0.85),
      makeCandidate("c3", "doc-a", 4, "Chunk 4.", 0.75),
    ];

    // neighborWindow = 2: c2 与 c1 距离=2 → 移除; c3 与 c1 距离=4 → 保留
    const result = dedupeAdjacentChunks(candidates, 2);
    expect(result.kept).toHaveLength(2);
    expect(result.kept[0].chunkId).toBe("c1");
    expect(result.kept[1].chunkId).toBe("c3");
    expect(result.removed).toHaveLength(1);
  });

  it("should remove chunks with high text overlap", () => {
    const text = "这是关于自然语言处理技术的一个很长很详细的描述文本包含了大量的重复内容";
    const candidates = [
      makeCandidate("c1", "doc-a", 0, text, 0.95),
      makeCandidate("c2", "doc-b", 3, text, 0.85), // 不同文档但文字几乎相同
    ];

    const result = dedupeAdjacentChunks(candidates, 1, 0.5);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].chunkId).toBe("c1"); // 高分保留
    expect(result.removed).toHaveLength(1);
  });

  it("should keep non-adjacent chunks from same document", () => {
    const candidates = [
      makeCandidate("c1", "doc-a", 0, "Introduction to the topic.", 0.95),
      makeCandidate("c2", "doc-a", 10, "Conclusion and summary.", 0.85),
      makeCandidate("c3", "doc-a", 20, "Appendix with references.", 0.75),
    ];

    const result = dedupeAdjacentChunks(candidates);
    // 所有 chunk 互不相邻（最小距离 10 > window 1）
    expect(result.kept).toHaveLength(3);
    expect(result.removed).toHaveLength(0);
  });

  it("should handle empty input", () => {
    const result = dedupeAdjacentChunks([]);
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("should handle single candidate", () => {
    const candidates = [makeCandidate("c1", "doc-a", 0, "Only one.", 0.9)];
    const result = dedupeAdjacentChunks(candidates);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
  });

  it("should keep higher score when both adjacency and text overlap apply", () => {
    const candidates = [
      makeCandidate("c1", "doc-a", 0, "Very similar text content here.", 0.95),
      makeCandidate("c2", "doc-a", 1, "Very similar text content here.", 0.88),
      makeCandidate("c3", "doc-a", 2, "Very similar text content here.", 0.72),
    ];

    const result = dedupeAdjacentChunks(candidates, 1, 0.5);
    // c2 邻接 c1 → 移除；c3 邻接 c1? 距离为 2 > window 1 → 不邻接
    // 但 c3 与 c1 文本高度重叠 → 移除
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].chunkId).toBe("c1");
    expect(result.removed).toHaveLength(2);
  });
});
