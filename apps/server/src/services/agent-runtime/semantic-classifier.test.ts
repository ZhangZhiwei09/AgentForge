// SemanticClassifier — 单元测试
//
// 测试 k-NN 加权投票算法（纯逻辑，无需 DB/Embedding）。
//
// Run: pnpm --filter @agentforge/server test -- --run src/services/agent-runtime/semantic-classifier.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import { SemanticClassifier, type SemanticMatch } from "./semantic-classifier.js";

// ── Test Helpers ──

function makeMatch(overrides: Partial<SemanticMatch> = {}): SemanticMatch {
  return {
    sampleId: "test-1",
    route: "DIAGNOSIS",
    text: "刷脸一直转圈",
    similarity: 0.85,
    ...overrides,
  };
}

// ── 直接测试 weightedVote（通过反射访问 private 方法）──
// 我们通过创建实例并调用 classify 来间接测试，但如果需要直接测试
// 投票逻辑，可以在测试中访问 (classifier as any).weightedVote

describe("SemanticClassifier.k-NN Weighted Vote", () => {
  let classifier: SemanticClassifier;

  beforeEach(() => {
    classifier = new SemanticClassifier(5);
  });

  // Access private weightedVote for testing
  function callWeightedVote(matches: SemanticMatch[]) {
    return (classifier as unknown as {
      weightedVote: (
        m: SemanticMatch[],
      ) => { route: string; confidence: number };
    }).weightedVote(matches);
  }

  it("returns DIAGNOSIS when all top matches are DIAGNOSIS", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.9 }),
      makeMatch({ route: "DIAGNOSIS", similarity: 0.85, sampleId: "test-2" }),
      makeMatch({ route: "DIAGNOSIS", similarity: 0.8, sampleId: "test-3" }),
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("DIAGNOSIS");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("returns the route with highest weighted score", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.9 }),
      makeMatch({ route: "DIAGNOSIS", similarity: 0.8, sampleId: "test-2" }),
      makeMatch({ route: "TASK", similarity: 0.7, sampleId: "test-3" }),
      makeMatch({ route: "TASK", similarity: 0.6, sampleId: "test-4" }),
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("DIAGNOSIS");
  });

  it("handles single match correctly", () => {
    const matches = [makeMatch({ route: "CHAT", similarity: 0.6 })];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("CHAT");
    expect(result.confidence).toBe(1.0);
  });

  it("returns TASK with confidence 0 when no matches", () => {
    const result = callWeightedVote([]);
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0);
  });

  it("filters out matches below MIN_SIMILARITY threshold (0.5)", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.9 }),
      makeMatch({ route: "TASK", similarity: 0.3, sampleId: "test-2" }), // < 0.5, should be filtered
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("DIAGNOSIS");
    // Only DIAGNOSIS vote counts → confidence should be 1.0
    expect(result.confidence).toBe(1.0);
  });

  it("applies ambiguity penalty when top-1 and top-2 are close", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.7 }),
      makeMatch({ route: "TASK", similarity: 0.68, sampleId: "test-2" }),
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("DIAGNOSIS");
    // Gap = (0.7-0.68)/1.38 ≈ 0.014 → < 0.15 → penalty applied
    // Base confidence = 0.7/1.38 ≈ 0.507, * 0.8 ≈ 0.406
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("no ambiguity penalty when top-1 clearly leads", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.9 }),
      makeMatch({ route: "TASK", similarity: 0.55, sampleId: "test-2" }),
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("DIAGNOSIS");
    // Gap = (0.9-0.55)/1.45 ≈ 0.24 → >= 0.15 → no penalty
    const expectedConf = 0.9 / 1.45;
    expect(result.confidence).toBeCloseTo(expectedConf, 2);
  });

  it("all samples below threshold return TASK with 0 confidence", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.4 }),
      makeMatch({ route: "TASK", similarity: 0.3, sampleId: "test-2" }),
    ];

    const result = callWeightedVote(matches);
    expect(result.route).toBe("TASK");
    expect(result.confidence).toBe(0);
  });

  it("handles tiebreaker: when two routes have equal scores, picks the first seen", () => {
    const matches = [
      makeMatch({ route: "DIAGNOSIS", similarity: 0.8 }),
      makeMatch({ route: "HUMAN", similarity: 0.8, sampleId: "test-2" }),
    ];

    const result = callWeightedVote(matches);
    // Both equal, takes first (DIAGNOSIS) due to stable sort
    expect(result.route).toBe("DIAGNOSIS");
  });
});

describe("SemanticClassifier.isAvailable", () => {
  it("returns false when embedding provider is unavailable", async () => {
    // Without embedding provider, isAvailable should return false
    // (unless pgvector is also unavailable, which it would be in unit test env)
    const classifier = new SemanticClassifier(5);
    // No embedding provider configured in test → should return false
    const available = await classifier.isAvailable();
    expect(available).toBe(false);
  });
});
