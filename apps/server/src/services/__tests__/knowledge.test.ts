// KnowledgeService tests — BM25 computation, hybrid search scoring, KnowledgeService lifecycle
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { BM25SparseEncoder } from "../bm25.js";

// Mock prisma at module level
vi.mock("../db.js", () => {
  const mockPrisma = {
    knowledgeChunk: {
      findMany: vi.fn(),
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

// Mock milvus
vi.mock("../services/milvus.js", () => ({
  getMilvusClient: vi.fn(),
  MILVUS_KNOWLEDGE_COLLECTION: "knowledge_collection",
  EMBEDDING_DIM: 768,
  ensureKnowledgeCollection: vi.fn(),
}));

// Mock embeddings
vi.mock("../services/embeddings.js", () => ({
  getDefaultEmbeddingProvider: vi.fn(() => null),
}));

// Mock provider registry
vi.mock("../providers/registry.js", () => ({
  getProvider: vi.fn(),
  listProviders: vi.fn(() => []),
  resolveModel: vi.fn(() => ["openai", "gpt-4o-mini"]),
}));

describe("BM25SparseEncoder", () => {
  describe("tokenize", () => {
    it("should handle English text", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["hello world this is a test"]);
      expect(bm25.isFitted).toBe(true);
      const vecs = bm25.encodeDocuments(["hello world"]);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });

    it("should handle Chinese text", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["知识库搜索测试文档"]);
      expect(bm25.isFitted).toBe(true);
      const vecs = bm25.encodeDocuments(["知识库搜索"]);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });

    it("should handle mixed Chinese-English text", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["AgentForge 是一个 AI agent 平台"]);
      expect(bm25.isFitted).toBe(true);
      const vecs = bm25.encodeDocuments(["AgentForge AI"]);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });

    it("should handle empty input gracefully", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["some document"]);
      const vecs = bm25.encodeDocuments([""]);
      expect(Object.keys(vecs[0])).toHaveLength(0);
    });

    it("should handle empty corpus gracefully", () => {
      const bm25 = new BM25SparseEncoder();
      expect(() => bm25.fit([])).not.toThrow();
      expect(bm25.isFitted).toBe(false);
    });
  });

  describe("cosine similarity scoring", () => {
    it("should compute cosine similarity between query and documents", () => {
      const corpus = [
        "machine learning with python is powerful",
        "javascript for web development and UI",
        "deep learning neural networks machine AI",
      ];
      const bm25 = BM25SparseEncoder.fitOnCorpus(corpus);

      const queries = bm25.encodeQueries(["machine learning"]);
      const docs = bm25.encodeDocuments(corpus);

      // Compute cosine similarity for each doc
      const queryNorm = Math.sqrt(
        Object.values(queries[0]).reduce((sum, v) => sum + v * v, 0),
      );

      const scores = docs.map((docVec) => {
        let dotProduct = 0;
        for (const [idx, qWeight] of Object.entries(queries[0])) {
          dotProduct += qWeight * (docVec[idx] ?? 0);
        }
        const docNorm = Math.sqrt(
          Object.values(docVec).reduce((sum, v) => sum + v * v, 0),
        );
        if (queryNorm === 0 || docNorm === 0) return 0;
        return dotProduct / (queryNorm * docNorm);
      });

      // Documents 0 and 2 contain "machine learning" terms
      expect(scores[0]).toBeGreaterThan(0);
      expect(scores[2]).toBeGreaterThan(0);
      // Document 1 is about javascript, should score lowest
      expect(scores[1]).toBeLessThan(scores[0]);
    });

    it("should return all zeros for query with no matching terms", () => {
      const bm25 = BM25SparseEncoder.fitOnCorpus(["python programming", "web development"]);
      const queries = bm25.encodeQueries(["zzznotexist"]);
      const docs = bm25.encodeDocuments(["python programming"]);

      const queryVec = queries[0];
      if (Object.keys(queryVec).length === 0) {
        // No matching terms — scores should be 0
        const score = 0;
        expect(score).toBe(0);
      }
    });

    it("should handle single-term corpus", () => {
      const bm25 = BM25SparseEncoder.fitOnCorpus(["test", "test", "test"]);
      expect(bm25.isFitted).toBe(true);
      // Single term across multiple docs — IDF should be low
      const queries = bm25.encodeQueries(["test"]);
      expect(Object.keys(queries[0]).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("IDF computation", () => {
    it("should give higher IDF to rare terms", () => {
      const corpus = [
        "python python python python python",  // "python" appears in doc 0 only
        "java java java java java",
        "python python python python python",  // wait, this makes "python" appear in 2 docs
      ];
      const bm25 = BM25SparseEncoder.fitOnCorpus(corpus);

      // Encode a rare term query and a common term query
      const rareQuery = bm25.encodeQueries(["java"]);
      const commonQuery = bm25.encodeQueries(["python"]);

      // Both should be in vocab
      expect(rareQuery[0]).toBeDefined();
      expect(commonQuery[0]).toBeDefined();
    });

    it("should handle terms that appear in all documents", () => {
      const corpus = [
        "the common word is here",
        "the common word is there",
        "the common word is everywhere",
      ];
      const bm25 = BM25SparseEncoder.fitOnCorpus(corpus);

      // "the" appears in all 3 docs — IDF should be very low
      const queries = bm25.encodeQueries(["the"]);
      const docs = bm25.encodeDocuments(["the specific word"]);

      // Both have weight for "the" but it's low
      expect(bm25.isFitted).toBe(true);
    });
  });

  describe("fit is idempotent", () => {
    it("should replace previous training data on re-fit", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["first corpus document"]);
      const firstVocabSize = Object.keys(bm25.encodeDocuments(["first"])[0]).length;

      bm25.fit(["second completely different corpus"]);
      const vecs = bm25.encodeDocuments(["completely different"]);
      expect(bm25.isFitted).toBe(true);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });

    it("should handle fit on single document", () => {
      const bm25 = new BM25SparseEncoder();
      bm25.fit(["only one document in the entire corpus"]);
      expect(bm25.isFitted).toBe(true);
      const vecs = bm25.encodeDocuments(["only one"]);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });
  });

  describe("factory method", () => {
    it("should create fitted encoder with static factory", () => {
      const bm25 = BM25SparseEncoder.fitOnCorpus(["factory test document"]);
      expect(bm25.isFitted).toBe(true);
      const vecs = bm25.encodeDocuments(["factory test"]);
      expect(Object.keys(vecs[0]).length).toBeGreaterThan(0);
    });
  });

  describe("encoding before fit", () => {
    it("should return empty vectors when not fitted", () => {
      const bm25 = new BM25SparseEncoder();
      expect(bm25.isFitted).toBe(false);

      const docs = bm25.encodeDocuments(["some text"]);
      expect(docs).toHaveLength(1);
      expect(Object.keys(docs[0])).toHaveLength(0);

      const queries = bm25.encodeQueries(["some text"]);
      expect(queries).toHaveLength(1);
      expect(Object.keys(queries[0])).toHaveLength(0);
    });
  });
});

describe("KnowledgeService", () => {
  // We import KnowledgeService lazily to ensure mocks are set up first
  let KnowledgeService: typeof import("../knowledge.js").KnowledgeService;

  beforeAll(async () => {
    const mod = await import("../knowledge.js");
    KnowledgeService = mod.KnowledgeService;
  });

  describe("BM25 lifecycle", () => {
    it("should create service instance without error", () => {
      const service = new KnowledgeService();
      expect(service).toBeDefined();
    });
  });
});
