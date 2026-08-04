import { describe, expect, it } from "vitest";
import type {
  KnowledgeRegressionCaseDTO,
  KnowledgeRegressionResultSnapshotDTO,
  KnowledgeRegressionRunDTO,
  KnowledgeRegressionRunItemDTO,
} from "@agentforge/shared-types";
import {
  computeMetricsSummary,
  evaluateQueryMetric,
  evaluateRun,
  evaluateRunItem,
  isRelevantResult,
  ndcgAtK,
  reciprocalRank,
} from "../knowledge-eval-metrics.js";

function makeCase(overrides: Partial<KnowledgeRegressionCaseDTO> = {}): KnowledgeRegressionCaseDTO {
  return {
    id: "case-1",
    testSetId: "set-1",
    kbId: "kb-1",
    name: "支付方式说明",
    query: "支持哪些支付方式？",
    expectedDocTitles: ["支付方式说明"],
    expectedDocIds: [],
    requiredText: [],
    forbiddenText: [],
    expectedTopK: 3,
    minScore: null,
    retrievalConfig: {
      searchMethod: "hybrid",
      topK: 5,
      rerankingEnable: true,
      scoreThreshold: 0,
    },
    promptRequiredContextText: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeResult(overrides: Partial<KnowledgeRegressionResultSnapshotDTO> = {}): KnowledgeRegressionResultSnapshotDTO {
  return {
    rank: 1,
    chunkId: "chunk-1",
    docId: "doc-1",
    docTitle: "支付方式说明",
    chunkIndex: 0,
    score: 0.82,
    content: "支持微信支付、支付宝、银行卡和 Apple Pay。",
    recallSources: ["pgvector", "elasticsearch"],
    ...overrides,
  };
}

function makeItem(overrides: Partial<KnowledgeRegressionRunItemDTO> = {}): KnowledgeRegressionRunItemDTO {
  return {
    id: "item-1",
    runId: "run-1",
    caseId: "case-1",
    caseName: "支付方式说明",
    query: "支持哪些支付方式？",
    passed: true,
    rank: 1,
    score: 0.82,
    matchedDocId: "doc-1",
    failureReason: null,
    resultsSnapshot: [makeResult()],
    promptSnapshot: null,
    elapsedMs: 120,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<KnowledgeRegressionRunDTO> = {}): KnowledgeRegressionRunDTO {
  return {
    id: "run-1",
    testSetId: "set-1",
    kbId: "kb-1",
    status: "completed",
    totalCases: 1,
    passedCases: 1,
    failedCases: 0,
    hitRate: 1,
    averageRank: 1,
    averageElapsedMs: 120,
    createdAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    items: [makeItem()],
    ...overrides,
  };
}

describe("reciprocalRank", () => {
  it("returns 1/rank for a positive rank", () => {
    expect(reciprocalRank(1)).toBe(1);
    expect(reciprocalRank(3)).toBeCloseTo(1 / 3);
  });

  it("returns 0 for null or non-positive rank", () => {
    expect(reciprocalRank(null)).toBe(0);
    expect(reciprocalRank(0)).toBe(0);
  });
});

describe("isRelevantResult", () => {
  it("matches by docId or docTitle case-insensitively", () => {
    expect(isRelevantResult(makeResult(), ["DOC-1"], [])).toBe(true);
    expect(isRelevantResult(makeResult(), [], ["支付方式说明"])).toBe(true);
    expect(isRelevantResult(makeResult({ docId: "doc-x" }), ["doc-1"], [])).toBe(false);
  });

  it("returns false when there are no expectations", () => {
    expect(isRelevantResult(makeResult(), [], [])).toBe(false);
  });
});

describe("ndcgAtK", () => {
  it("returns 1.0 for an ideal ordering", () => {
    expect(ndcgAtK([true, true])).toBeCloseTo(1);
  });

  it("penalizes relevant results ranked lower", () => {
    const gainAtRank2 = ndcgAtK([false, true]);
    expect(gainAtRank2).toBeCloseTo(1 / Math.log2(3));
    expect(gainAtRank2).toBeLessThan(ndcgAtK([true, false]));
  });

  it("returns 0 when nothing is relevant", () => {
    expect(ndcgAtK([])).toBe(0);
    expect(ndcgAtK([false, false])).toBe(0);
  });
});

describe("evaluateRunItem", () => {
  const expectation = { expectedDocIds: [] as string[], expectedDocTitles: ["支付方式说明"], expectedTopK: 3 };

  it("computes top-K metrics when the expected doc is within K", () => {
    const item = makeItem({
      rank: 2,
      resultsSnapshot: [
        makeResult({ rank: 1, docId: "doc-other", docTitle: "退换货政策" }),
        makeResult({ rank: 2 }),
      ],
    });

    const metrics = evaluateRunItem(item, expectation);

    expect(metrics.reciprocalRank).toBeCloseTo(1 / 2);
    expect(metrics.rankAtK).toBe(2);
    expect(metrics.relevant).toBe(true);
    expect(metrics.precisionAtK).toBeCloseTo(1 / 3);
    expect(metrics.ndcgAtK).toBeCloseTo(ndcgAtK([false, true, false]));
  });

  it("marks expected doc outside K as not relevant at K", () => {
    const item = makeItem({
      rank: 4,
      resultsSnapshot: [
        makeResult({ rank: 1, docId: "doc-a", docTitle: "甲" }),
        makeResult({ rank: 2, docId: "doc-b", docTitle: "乙" }),
        makeResult({ rank: 3, docId: "doc-c", docTitle: "丙" }),
        makeResult({ rank: 4 }),
      ],
    });

    const metrics = evaluateRunItem(item, expectation);

    expect(metrics.relevant).toBe(false);
    expect(metrics.rankAtK).toBeNull();
    expect(metrics.precisionAtK).toBe(0);
    expect(metrics.ndcgAtK).toBe(0);
  });

  it("zeros top-K metrics when expectations are missing but keeps rank-based RR", () => {
    const metrics = evaluateRunItem(makeItem({ rank: 2 }), null);

    expect(metrics.reciprocalRank).toBeCloseTo(1 / 2);
    expect(metrics.rankAtK).toBeNull();
    expect(metrics.relevant).toBe(false);
    expect(metrics.precisionAtK).toBe(0);
    expect(metrics.ndcgAtK).toBe(0);
  });
});

describe("evaluateRun", () => {
  it("aggregates item metrics into run averages", () => {
    const cases = new Map([["case-1", makeCase()], ["case-2", makeCase({ id: "case-2", expectedDocIds: ["doc-9"] })]]);
    const run = makeRun({
      id: "run-1",
      items: [
        makeItem({
          caseId: "case-1",
          passed: true,
          rank: 2,
          resultsSnapshot: [
            makeResult({ rank: 1, docId: "doc-x", docTitle: "无关" }),
            makeResult({ rank: 2 }),
          ],
        }),
        makeItem({
          caseId: "case-2",
          passed: false,
          rank: null,
          resultsSnapshot: [makeResult({ rank: 1, docId: "doc-other", docTitle: "其他" })],
        }),
      ],
    });

    const metrics = evaluateRun(run, cases);

    expect(metrics.hitRate).toBeCloseTo(0.5);
    expect(metrics.mrr).toBeCloseTo(0.25); // (1/2 + 0) / 2
    expect(metrics.recallAtK).toBeCloseTo(0.5); // (1 + 0) / 2
    expect(metrics.precisionAtK).toBeCloseTo((1 / 3 + 0) / 2);
    expect(metrics.averageRank).toBeCloseTo(2);
    expect(metrics.averageElapsedMs).toBeCloseTo(120);
  });

  it("returns null averageRank when no item is ranked", () => {
    const run = makeRun({
      items: [makeItem({ passed: false, rank: null, resultsSnapshot: [] })],
    });
    const metrics = evaluateRun(run, new Map());

    expect(metrics.averageRank).toBeNull();
    expect(metrics.hitRate).toBeCloseTo(0);
  });
});

describe("evaluateQueryMetric", () => {
  it("exposes relevant ranks across the whole snapshot for UI highlighting", () => {
    const expectation = { expectedDocIds: [] as string[], expectedDocTitles: ["支付方式说明"], expectedTopK: 3 };
    const item = makeItem({
      rank: 3,
      resultsSnapshot: [
        makeResult({ rank: 1, docId: "doc-a", docTitle: "甲" }),
        makeResult({ rank: 2, docId: "doc-b", docTitle: "乙" }),
        makeResult({ rank: 3 }),
      ],
    });

    const metric = evaluateQueryMetric(item, expectation);

    expect(metric.relevantRanks).toEqual([3]);
    expect(metric.relevant).toBe(true);
    expect(metric.reciprocalRank).toBeCloseTo(1 / 3);
    expect(metric.resultsSnapshot).toHaveLength(3);
  });
});

describe("computeMetricsSummary", () => {
  it("summarizes chronological runs with latest as the last one", () => {
    const earlier = evaluateRun(makeRun({ id: "run-old", totalCases: 2 }), new Map());
    const later = evaluateRun(makeRun({ id: "run-new", totalCases: 3 }), new Map());

    const summary = computeMetricsSummary([earlier, later]);

    expect(summary.runCount).toBe(2);
    expect(summary.totalCases).toBe(5);
    expect(summary.latest?.runId).toBe("run-new");
    expect(summary.average?.hitRate).toBeCloseTo(1);
  });

  it("returns null latest/average for empty input", () => {
    const summary = computeMetricsSummary([]);

    expect(summary.runCount).toBe(0);
    expect(summary.totalCases).toBe(0);
    expect(summary.latest).toBeNull();
    expect(summary.average).toBeNull();
  });
});
