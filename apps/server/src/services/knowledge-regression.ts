import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { KnowledgeService, type HybridSearchResult } from "./knowledge.js";

export type RegressionSearchMethod = "hybrid" | "semantic" | "keyword";

export interface RegressionRetrievalConfig {
  searchMethod: RegressionSearchMethod;
  topK: number;
  rerankingEnable: boolean;
  scoreThreshold: number;
}

export interface RegressionCaseInput {
  testSetId?: string;
  name: string;
  query: string;
  expectedDocTitles?: string[];
  expectedDocIds?: string[];
  requiredText?: string[];
  forbiddenText?: string[];
  expectedTopK?: number;
  minScore?: number | null;
  retrievalConfig?: Partial<RegressionRetrievalConfig>;
  promptRequiredContextText?: string[];
}

export interface RegressionCaseDTO {
  id: string;
  testSetId: string;
  kbId: string;
  name: string;
  query: string;
  expectedDocTitles: string[];
  expectedDocIds: string[];
  requiredText: string[];
  forbiddenText: string[];
  expectedTopK: number;
  minScore: number | null;
  retrievalConfig: RegressionRetrievalConfig;
  promptRequiredContextText: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RegressionTestSetDTO {
  id: string;
  kbId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  cases: RegressionCaseDTO[];
}

export interface RegressionRunItemDTO {
  id: string;
  runId: string;
  caseId: string;
  caseName: string;
  query: string;
  passed: boolean;
  rank: number | null;
  score: number | null;
  matchedDocId: string | null;
  failureReason: string | null;
  resultsSnapshot: RegressionResultSnapshot[];
  promptSnapshot: string | null;
  elapsedMs: number;
  createdAt: string;
}

export interface RegressionRunDTO {
  id: string;
  testSetId: string;
  kbId: string;
  status: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  hitRate: number;
  averageRank: number | null;
  averageElapsedMs: number | null;
  createdAt: string;
  completedAt: string | null;
  items: RegressionRunItemDTO[];
}

export interface RegressionResultSnapshot {
  rank: number;
  chunkId: string;
  docId: string;
  docTitle: string;
  chunkIndex: number;
  score: number;
  content: string;
  recallSources: string[];
  fusionScore?: number;
  rerankScore?: number;
}

interface RegressionCaseRow {
  id: string;
  testSetId: string;
  kbId: string;
  name: string;
  query: string;
  expectedTopK: number;
  minScore: number | null;
  searchMethod: RegressionSearchMethod;
  topK: number;
  rerankingEnable: boolean;
  scoreThreshold: number;
  expectedDocTitles: unknown;
  expectedDocIds: unknown;
  requiredText: unknown;
  forbiddenText: unknown;
  promptRequiredContextText: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface RegressionTestSetRow {
  id: string;
  kbId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeConfig(
  config?: Partial<RegressionRetrievalConfig>,
): RegressionRetrievalConfig {
  return {
    searchMethod: config?.searchMethod ?? "hybrid",
    topK: config?.topK ?? 10,
    rerankingEnable: config?.rerankingEnable ?? true,
    scoreThreshold: config?.scoreThreshold ?? 0,
  };
}

function mapCase(row: RegressionCaseRow): RegressionCaseDTO {
  return {
    id: row.id,
    testSetId: row.testSetId,
    kbId: row.kbId,
    name: row.name,
    query: row.query,
    expectedDocTitles: asStringArray(row.expectedDocTitles),
    expectedDocIds: asStringArray(row.expectedDocIds),
    requiredText: asStringArray(row.requiredText),
    forbiddenText: asStringArray(row.forbiddenText),
    expectedTopK: row.expectedTopK,
    minScore: row.minScore,
    retrievalConfig: {
      searchMethod: row.searchMethod,
      topK: row.topK,
      rerankingEnable: row.rerankingEnable,
      scoreThreshold: row.scoreThreshold,
    },
    promptRequiredContextText: asStringArray(row.promptRequiredContextText),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildRegressionPromptSnapshot(
  query: string,
  results: RegressionResultSnapshot[],
): string {
  const context = results
    .map(
      (result) =>
        `[${result.rank}] ${result.docTitle} #${result.chunkIndex} score=${result.score.toFixed(4)}\n${result.content}`,
    )
    .join("\n\n");

  return [
    "Use the retrieved knowledge context to answer the user question.",
    "",
    `Question: ${query}`,
    "",
    "Retrieved context:",
    context || "(no context)",
  ].join("\n");
}

export function evaluateRegressionCase(
  testCase: RegressionCaseDTO,
  results: RegressionResultSnapshot[],
  promptSnapshot: string,
): {
  passed: boolean;
  rank: number | null;
  score: number | null;
  matchedDocId: string | null;
  failureReason: string | null;
} {
  const reasons: string[] = [];
  const topLimit = Math.max(1, testCase.expectedTopK);
  const topResults = results.slice(0, topLimit);
  const expectedDocIds = new Set(testCase.expectedDocIds.map(lower));
  const expectedDocTitles = new Set(testCase.expectedDocTitles.map(lower));

  let matched = topResults.find((result) => {
    const docId = lower(result.docId);
    const title = lower(result.docTitle);
    return expectedDocIds.has(docId) || expectedDocTitles.has(title);
  });

  if (expectedDocIds.size > 0 || expectedDocTitles.size > 0) {
    if (!matched) {
      reasons.push(`Expected document was not retrieved in top ${topLimit}`);
    }
  } else if (topResults.length > 0) {
    matched = topResults[0];
  }

  const combinedContent = topResults.map((result) => result.content).join("\n").toLowerCase();

  for (const text of testCase.requiredText) {
    if (!combinedContent.includes(lower(text))) {
      reasons.push(`Required text missing: ${text}`);
    }
  }

  for (const text of testCase.forbiddenText) {
    if (combinedContent.includes(lower(text))) {
      reasons.push(`Forbidden text appeared: ${text}`);
    }
  }

  for (const text of testCase.promptRequiredContextText) {
    if (!promptSnapshot.toLowerCase().includes(lower(text))) {
      reasons.push(`Prompt context missing: ${text}`);
    }
  }

  if (testCase.minScore != null) {
    const score = matched?.score ?? topResults[0]?.score;
    if (score == null || score < testCase.minScore) {
      reasons.push(`Score below threshold: expected >= ${testCase.minScore}`);
    }
  }

  return {
    passed: reasons.length === 0,
    rank: matched?.rank ?? null,
    score: matched?.score ?? null,
    matchedDocId: matched?.docId ?? null,
    failureReason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

export class KnowledgeRegressionService {
  async getOrCreateDefaultTestSet(kbId: string): Promise<RegressionTestSetDTO> {
    const existing = await prisma.$queryRawUnsafe<RegressionTestSetRow[]>(
      `
        SELECT id, kb_id AS "kbId", name, description, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM knowledge_regression_test_sets
        WHERE kb_id = $1
        ORDER BY created_at ASC
        LIMIT 1
      `,
      kbId,
    );

    if (existing[0]) {
      const sets = await this.listTestSets(kbId);
      const found = sets.find((set) => set.id === existing[0].id);
      if (found) return found;
    }

    return this.createTestSet(kbId, {
      name: "Default regression set",
      description: "Knowledge retrieval and prompt regression cases",
    });
  }

  async createTestSet(
    kbId: string,
    input: { name: string; description?: string | null },
  ): Promise<RegressionTestSetDTO> {
    const id = randomUUID();
    const rows = await prisma.$queryRawUnsafe<RegressionTestSetRow[]>(
      `
        INSERT INTO knowledge_regression_test_sets (id, kb_id, name, description)
        VALUES ($1, $2, $3, $4)
        RETURNING id, kb_id AS "kbId", name, description, created_at AS "createdAt", updated_at AS "updatedAt"
      `,
      id,
      kbId,
      input.name,
      input.description ?? null,
    );

    return { ...this.mapTestSet(rows[0]), cases: [] };
  }

  async listTestSets(kbId: string): Promise<RegressionTestSetDTO[]> {
    const [sets, cases] = await Promise.all([
      prisma.$queryRawUnsafe<RegressionTestSetRow[]>(
        `
          SELECT id, kb_id AS "kbId", name, description, created_at AS "createdAt", updated_at AS "updatedAt"
          FROM knowledge_regression_test_sets
          WHERE kb_id = $1
          ORDER BY created_at ASC
        `,
        kbId,
      ),
      this.listCases(kbId),
    ]);

    return sets.map((set) => ({
      ...this.mapTestSet(set),
      cases: cases.filter((testCase) => testCase.testSetId === set.id),
    }));
  }

  async listCases(kbId: string, testSetId?: string): Promise<RegressionCaseDTO[]> {
    const rows = await prisma.$queryRawUnsafe<RegressionCaseRow[]>(
      `
        SELECT
          id,
          test_set_id AS "testSetId",
          kb_id AS "kbId",
          name,
          query,
          expected_top_k AS "expectedTopK",
          min_score AS "minScore",
          search_method AS "searchMethod",
          top_k AS "topK",
          reranking_enable AS "rerankingEnable",
          score_threshold AS "scoreThreshold",
          expected_doc_titles AS "expectedDocTitles",
          expected_doc_ids AS "expectedDocIds",
          required_text AS "requiredText",
          forbidden_text AS "forbiddenText",
          prompt_required_context_text AS "promptRequiredContextText",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM knowledge_regression_cases
        WHERE kb_id = $1
          AND ($2::varchar IS NULL OR test_set_id = $2::varchar)
        ORDER BY created_at ASC
      `,
      kbId,
      testSetId ?? null,
    );

    return rows.map(mapCase);
  }

  async createCase(kbId: string, input: RegressionCaseInput): Promise<RegressionCaseDTO> {
    const testSetId = input.testSetId ?? (await this.getOrCreateDefaultTestSet(kbId)).id;
    const config = normalizeConfig(input.retrievalConfig);
    const id = randomUUID();

    const rows = await prisma.$queryRawUnsafe<RegressionCaseRow[]>(
      `
        INSERT INTO knowledge_regression_cases (
          id, test_set_id, kb_id, name, query, expected_top_k, min_score,
          search_method, top_k, reranking_enable, score_threshold,
          expected_doc_titles, expected_doc_ids, required_text, forbidden_text,
          prompt_required_context_text
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb
        )
        RETURNING
          id, test_set_id AS "testSetId", kb_id AS "kbId", name, query,
          expected_top_k AS "expectedTopK", min_score AS "minScore",
          search_method AS "searchMethod", top_k AS "topK",
          reranking_enable AS "rerankingEnable", score_threshold AS "scoreThreshold",
          expected_doc_titles AS "expectedDocTitles", expected_doc_ids AS "expectedDocIds",
          required_text AS "requiredText", forbidden_text AS "forbiddenText",
          prompt_required_context_text AS "promptRequiredContextText",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `,
      id,
      testSetId,
      kbId,
      input.name,
      input.query,
      input.expectedTopK ?? 5,
      input.minScore ?? null,
      config.searchMethod,
      config.topK,
      config.rerankingEnable,
      config.scoreThreshold,
      JSON.stringify(input.expectedDocTitles ?? []),
      JSON.stringify(input.expectedDocIds ?? []),
      JSON.stringify(input.requiredText ?? []),
      JSON.stringify(input.forbiddenText ?? []),
      JSON.stringify(input.promptRequiredContextText ?? []),
    );

    return mapCase(rows[0]);
  }

  async updateCase(caseId: string, input: RegressionCaseInput): Promise<RegressionCaseDTO | null> {
    const config = normalizeConfig(input.retrievalConfig);
    const rows = await prisma.$queryRawUnsafe<RegressionCaseRow[]>(
      `
        UPDATE knowledge_regression_cases
        SET
          name = $2,
          query = $3,
          expected_top_k = $4,
          min_score = $5,
          search_method = $6,
          top_k = $7,
          reranking_enable = $8,
          score_threshold = $9,
          expected_doc_titles = $10::jsonb,
          expected_doc_ids = $11::jsonb,
          required_text = $12::jsonb,
          forbidden_text = $13::jsonb,
          prompt_required_context_text = $14::jsonb,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING
          id, test_set_id AS "testSetId", kb_id AS "kbId", name, query,
          expected_top_k AS "expectedTopK", min_score AS "minScore",
          search_method AS "searchMethod", top_k AS "topK",
          reranking_enable AS "rerankingEnable", score_threshold AS "scoreThreshold",
          expected_doc_titles AS "expectedDocTitles", expected_doc_ids AS "expectedDocIds",
          required_text AS "requiredText", forbidden_text AS "forbiddenText",
          prompt_required_context_text AS "promptRequiredContextText",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `,
      caseId,
      input.name,
      input.query,
      input.expectedTopK ?? 5,
      input.minScore ?? null,
      config.searchMethod,
      config.topK,
      config.rerankingEnable,
      config.scoreThreshold,
      JSON.stringify(input.expectedDocTitles ?? []),
      JSON.stringify(input.expectedDocIds ?? []),
      JSON.stringify(input.requiredText ?? []),
      JSON.stringify(input.forbiddenText ?? []),
      JSON.stringify(input.promptRequiredContextText ?? []),
    );

    return rows[0] ? mapCase(rows[0]) : null;
  }

  async deleteCase(caseId: string): Promise<boolean> {
    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM knowledge_regression_cases WHERE id = $1`,
      caseId,
    );
    return result > 0;
  }

  async runTestSet(kbId: string, testSetId?: string): Promise<RegressionRunDTO> {
    const testSet = testSetId
      ? (await this.listTestSets(kbId)).find((set) => set.id === testSetId)
      : await this.getOrCreateDefaultTestSet(kbId);
    if (!testSet) throw new Error("Regression test set not found");

    const cases = await this.listCases(kbId, testSet.id);
    const runId = randomUUID();

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO knowledge_regression_runs (id, test_set_id, kb_id, status, total_cases)
        VALUES ($1, $2, $3, 'running', $4)
      `,
      runId,
      testSet.id,
      kbId,
      cases.length,
    );

    const items: RegressionRunItemDTO[] = [];
    for (const testCase of cases) {
      const startedAt = Date.now();
      const retrievalResults = await this.runRetrieval(kbId, testCase);
      const elapsedMs = Date.now() - startedAt;
      const snapshot = this.toSnapshot(retrievalResults);
      const promptSnapshot = buildRegressionPromptSnapshot(testCase.query, snapshot);
      const evaluation = evaluateRegressionCase(testCase, snapshot, promptSnapshot);
      const itemId = randomUUID();

      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        createdAt: Date;
      }>>(
        `
          INSERT INTO knowledge_regression_run_items (
            id, run_id, case_id, passed, rank, score, matched_doc_id,
            failure_reason, results_snapshot, prompt_snapshot, elapsed_ms
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
          RETURNING id, created_at AS "createdAt"
        `,
        itemId,
        runId,
        testCase.id,
        evaluation.passed,
        evaluation.rank,
        evaluation.score,
        evaluation.matchedDocId,
        evaluation.failureReason,
        JSON.stringify(snapshot),
        promptSnapshot,
        elapsedMs,
      );

      items.push({
        id: rows[0].id,
        runId,
        caseId: testCase.id,
        caseName: testCase.name,
        query: testCase.query,
        passed: evaluation.passed,
        rank: evaluation.rank,
        score: evaluation.score,
        matchedDocId: evaluation.matchedDocId,
        failureReason: evaluation.failureReason,
        resultsSnapshot: snapshot,
        promptSnapshot,
        elapsedMs,
        createdAt: rows[0].createdAt.toISOString(),
      });
    }

    const passedCases = items.filter((item) => item.passed).length;
    const failedCases = cases.length - passedCases;
    const ranked = items.filter((item) => item.rank != null) as Array<RegressionRunItemDTO & { rank: number }>;
    const averageRank =
      ranked.length > 0
        ? ranked.reduce((sum, item) => sum + item.rank, 0) / ranked.length
        : null;
    const averageElapsedMs =
      items.length > 0
        ? items.reduce((sum, item) => sum + item.elapsedMs, 0) / items.length
        : null;
    const hitRate = cases.length > 0 ? passedCases / cases.length : 0;

    const runRows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      testSetId: string;
      kbId: string;
      status: string;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      hitRate: number;
      averageRank: number | null;
      averageElapsedMs: number | null;
      createdAt: Date;
      completedAt: Date | null;
    }>>(
      `
        UPDATE knowledge_regression_runs
        SET
          status = 'completed',
          passed_cases = $2,
          failed_cases = $3,
          hit_rate = $4,
          average_rank = $5,
          average_elapsed_ms = $6,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING
          id, test_set_id AS "testSetId", kb_id AS "kbId", status,
          total_cases AS "totalCases", passed_cases AS "passedCases",
          failed_cases AS "failedCases", hit_rate AS "hitRate",
          average_rank AS "averageRank", average_elapsed_ms AS "averageElapsedMs",
          created_at AS "createdAt", completed_at AS "completedAt"
      `,
      runId,
      passedCases,
      failedCases,
      hitRate,
      averageRank,
      averageElapsedMs,
    );

    return this.mapRun(runRows[0], items);
  }

  async listRuns(kbId: string, testSetId?: string): Promise<RegressionRunDTO[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      testSetId: string;
      kbId: string;
      status: string;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      hitRate: number;
      averageRank: number | null;
      averageElapsedMs: number | null;
      createdAt: Date;
      completedAt: Date | null;
    }>>(
      `
        SELECT
          id, test_set_id AS "testSetId", kb_id AS "kbId", status,
          total_cases AS "totalCases", passed_cases AS "passedCases",
          failed_cases AS "failedCases", hit_rate AS "hitRate",
          average_rank AS "averageRank", average_elapsed_ms AS "averageElapsedMs",
          created_at AS "createdAt", completed_at AS "completedAt"
        FROM knowledge_regression_runs
        WHERE kb_id = $1
          AND ($2::varchar IS NULL OR test_set_id = $2::varchar)
        ORDER BY created_at DESC
        LIMIT 20
      `,
      kbId,
      testSetId ?? null,
    );

    if (rows.length === 0) return [];
    const runIds = rows.map((row) => row.id);
    const items = await this.listRunItems(runIds);
    return rows.map((row) => this.mapRun(row, items.filter((item) => item.runId === row.id)));
  }

  private async listRunItems(runIds: string[]): Promise<RegressionRunItemDTO[]> {
    if (runIds.length === 0) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      runId: string;
      caseId: string;
      caseName: string;
      query: string;
      passed: boolean;
      rank: number | null;
      score: number | null;
      matchedDocId: string | null;
      failureReason: string | null;
      resultsSnapshot: unknown;
      promptSnapshot: string | null;
      elapsedMs: number;
      createdAt: Date;
    }>>(
      `
        SELECT
          i.id, i.run_id AS "runId", i.case_id AS "caseId",
          c.name AS "caseName", c.query,
          i.passed, i.rank, i.score, i.matched_doc_id AS "matchedDocId",
          i.failure_reason AS "failureReason",
          i.results_snapshot AS "resultsSnapshot",
          i.prompt_snapshot AS "promptSnapshot",
          i.elapsed_ms AS "elapsedMs",
          i.created_at AS "createdAt"
        FROM knowledge_regression_run_items i
        JOIN knowledge_regression_cases c ON c.id = i.case_id
        WHERE i.run_id = ANY($1::varchar[])
        ORDER BY i.created_at ASC
      `,
      runIds,
    );

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      caseId: row.caseId,
      caseName: row.caseName,
      query: row.query,
      passed: row.passed,
      rank: row.rank,
      score: row.score,
      matchedDocId: row.matchedDocId,
      failureReason: row.failureReason,
      resultsSnapshot: Array.isArray(row.resultsSnapshot)
        ? row.resultsSnapshot as RegressionResultSnapshot[]
        : [],
      promptSnapshot: row.promptSnapshot,
      elapsedMs: row.elapsedMs,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async runRetrieval(
    kbId: string,
    testCase: RegressionCaseDTO,
  ): Promise<HybridSearchResult[]> {
    const service = new KnowledgeService();
    const config = testCase.retrievalConfig;

    if (config.searchMethod === "hybrid") {
      const results = await service.searchHybrid({
        query: testCase.query,
        kbIds: [kbId],
        topK: config.topK,
        useReranker: config.rerankingEnable,
      });
      return this.applyScoreThreshold(results, config.scoreThreshold);
    }

    if (config.searchMethod === "semantic") {
      const provider = getDefaultEmbeddingProvider();
      const queryVec = provider ? await provider.embedSingle(testCase.query) : null;
      if (!queryVec) return [];
      const dense = await service.searchByVector(queryVec, [kbId], config.topK);
      const results = dense.map((result) => ({
        ...result,
        score: result.sourceScore,
        fusionScore: result.sourceScore,
        recallSources: ["pgvector" as const],
      }));
      return this.applyScoreThreshold(results, config.scoreThreshold);
    }

    const sparse = await service.searchByKeyword(testCase.query, [kbId], config.topK);
    const results = sparse.map((result) => ({
      ...result,
      score: result.sourceScore,
      fusionScore: result.sourceScore,
      recallSources: ["elasticsearch" as const],
    }));
    return this.applyScoreThreshold(results, config.scoreThreshold);
  }

  private applyScoreThreshold<T extends { score: number }>(
    results: T[],
    threshold: number,
  ): T[] {
    return threshold > 0 ? results.filter((result) => result.score >= threshold) : results;
  }

  private toSnapshot(results: HybridSearchResult[]): RegressionResultSnapshot[] {
    return results.map((result, index) => ({
      rank: index + 1,
      chunkId: result.chunkId,
      docId: result.docId,
      docTitle: result.docTitle,
      chunkIndex: result.chunkIndex,
      score: result.score,
      content: result.content,
      recallSources: result.recallSources,
      fusionScore: result.fusionScore,
      rerankScore: result.rerankScore,
    }));
  }

  private mapTestSet(row: RegressionTestSetRow): Omit<RegressionTestSetDTO, "cases"> {
    return {
      id: row.id,
      kbId: row.kbId,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapRun(
    row: {
      id: string;
      testSetId: string;
      kbId: string;
      status: string;
      totalCases: number;
      passedCases: number;
      failedCases: number;
      hitRate: number;
      averageRank: number | null;
      averageElapsedMs: number | null;
      createdAt: Date;
      completedAt: Date | null;
    },
    items: RegressionRunItemDTO[],
  ): RegressionRunDTO {
    return {
      id: row.id,
      testSetId: row.testSetId,
      kbId: row.kbId,
      status: row.status,
      totalCases: row.totalCases,
      passedCases: row.passedCases,
      failedCases: row.failedCases,
      hitRate: row.hitRate,
      averageRank: row.averageRank,
      averageElapsedMs: row.averageElapsedMs,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      items,
    };
  }
}
