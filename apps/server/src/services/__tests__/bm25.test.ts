import { describe, it, expect } from "vitest";
import { BM25SparseEncoder } from "../bm25.js";

describe("BM25SparseEncoder", () => {
  const corpus = [
    "the quick brown fox jumps over the lazy dog",
    "never gonna give you up never gonna let you down",
    "hello world this is a test document",
    "machine learning is fascinating and powerful",
  ];

  it("should fit on a corpus without error", () => {
    const bm25 = new BM25SparseEncoder();
    expect(() => bm25.fit(corpus)).not.toThrow();
    expect(bm25.isFitted).toBe(true);
  });

  it("should encode documents as sparse vectors", () => {
    const bm25 = new BM25SparseEncoder();
    bm25.fit(corpus);
    const vectors = bm25.encodeDocuments(corpus);
    expect(vectors).toHaveLength(corpus.length);
    vectors.forEach((vec) => {
      expect(typeof vec).toBe("object");
      // Each document should have at least some non-zero weights
      expect(Object.keys(vec).length).toBeGreaterThan(0);
    });
  });

  it("should encode queries as sparse vectors", () => {
    const bm25 = new BM25SparseEncoder();
    bm25.fit(corpus);
    const queries = ["quick brown fox", "machine learning"];
    const queryVecs = bm25.encodeQueries(queries);
    expect(queryVecs).toHaveLength(2);
    queryVecs.forEach((vec) => {
      expect(typeof vec).toBe("object");
    });
  });

  it("should return empty vectors for query with unknown terms", () => {
    const bm25 = new BM25SparseEncoder();
    bm25.fit(corpus);
    const queryVecs = bm25.encodeQueries(["xyznonexistent123"]);
    expect(queryVecs).toHaveLength(1);
    expect(Object.keys(queryVecs[0]).length).toBe(0);
  });

  it("should give higher scores to more relevant documents", () => {
    const bm25 = new BM25SparseEncoder();
    const smallCorpus = [
      "python programming language",
      "javascript web development",
      "python machine learning AI",
    ];
    bm25.fit(smallCorpus);

    const documents = bm25.encodeDocuments(smallCorpus);
    const queries = bm25.encodeQueries(["python"]);

    // Doc 0 and Doc 2 should match "python" better than Doc 1
    const queryVec = queries[0];
    const scores = documents.map((docVec) => {
      let dot = 0;
      for (const [idx, qw] of Object.entries(queryVec)) {
        dot += qw * (docVec[idx] ?? 0);
      }
      return dot;
    });

    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[2]).toBeGreaterThan(0);
    // Doc 1 doesn't contain "python"
    expect(scores[1]).toBe(0);
  });
});
