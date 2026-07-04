import { describe, expect, it } from "vitest";
import {
  buildRegressionPromptSnapshot,
  evaluateRegressionCase,
  type RegressionCaseDTO,
  type RegressionResultSnapshot,
} from "../knowledge-regression.js";

function makeCase(overrides: Partial<RegressionCaseDTO> = {}): RegressionCaseDTO {
  return {
    id: "case-1",
    testSetId: "set-1",
    kbId: "kb-1",
    name: "Payment policy",
    query: "支持哪些支付方式？",
    expectedDocTitles: ["支付方式说明"],
    expectedDocIds: [],
    requiredText: ["微信支付"],
    forbiddenText: [],
    expectedTopK: 3,
    minScore: 0.5,
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

function makeResult(overrides: Partial<RegressionResultSnapshot> = {}): RegressionResultSnapshot {
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

describe("knowledge regression evaluation", () => {
  it("passes when expected document, text, score, and prompt context match", () => {
    const testCase = makeCase({ promptRequiredContextText: ["支付宝"] });
    const results = [makeResult()];
    const prompt = buildRegressionPromptSnapshot(testCase.query, results);

    const evaluation = evaluateRegressionCase(testCase, results, prompt);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.rank).toBe(1);
    expect(evaluation.failureReason).toBeNull();
  });

  it("fails when expected document is outside expected topK", () => {
    const testCase = makeCase({ expectedTopK: 1 });
    const results = [
      makeResult({ docId: "doc-other", docTitle: "退换货政策", content: "退货规则", score: 0.9 }),
      makeResult({ rank: 2 }),
    ];

    const evaluation = evaluateRegressionCase(
      testCase,
      results,
      buildRegressionPromptSnapshot(testCase.query, results),
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason ?? "").toContain("Expected document");
  });

  it("fails when required text is missing", () => {
    const testCase = makeCase({ requiredText: ["Apple Pay"] });
    const results = [makeResult({ content: "支持微信支付和支付宝。" })];

    const evaluation = evaluateRegressionCase(
      testCase,
      results,
      buildRegressionPromptSnapshot(testCase.query, results),
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason ?? "").toContain("Required text missing");
  });

  it("fails when forbidden text appears", () => {
    const testCase = makeCase({ forbiddenText: ["退货"] });
    const results = [makeResult({ content: "支持微信支付，但这里错误混入退货规则。" })];

    const evaluation = evaluateRegressionCase(
      testCase,
      results,
      buildRegressionPromptSnapshot(testCase.query, results),
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason ?? "").toContain("Forbidden text appeared");
  });

  it("fails when prompt context is missing required text", () => {
    const testCase = makeCase({ promptRequiredContextText: ["信用卡"] });
    const results = [makeResult()];

    const evaluation = evaluateRegressionCase(
      testCase,
      results,
      buildRegressionPromptSnapshot(testCase.query, results),
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason ?? "").toContain("Prompt context missing");
  });
});
