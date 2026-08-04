import type {
  KnowledgeRegressionAverageMetricsDTO,
  KnowledgeRegressionCaseDTO,
  KnowledgeRegressionMetricsSummaryDTO,
  KnowledgeRegressionQueryMetricDTO,
  KnowledgeRegressionResultSnapshotDTO,
  KnowledgeRegressionRunDTO,
  KnowledgeRegressionRunItemDTO,
  KnowledgeRegressionRunMetricsDTO,
} from "@agentforge/shared-types";

/**
 * 回归评测指标纯函数。
 *
 * 输入均为类型化 DTO（来自 knowledge-regression 服务的 run / run item / case），
 * 输出标准 IR 指标（MRR / Recall@K / Precision@K / NDCG@K）。
 *
 * 指标语义：
 * - K = case.expectedTopK（case 缺失时默认 5），截断用 expectedTopK 而非 retrievalConfig.topK
 * - Recall@K = 二元：top-K 内至少一个期望文档命中（与现有 passed / hitRate 语义对齐）
 * - Precision@K = top-K 内期望命中数 / K
 * - MRR = 各 item `1/首个期望命中排名` 的均值；RR 使用首个期望文档在整个快照中的排名（与
 *   evaluateRegressionCase 计算 item.rank 的逻辑一致），未命中记 0
 * - NDCG@K = 二元增益：DCG = Σ gain_i / log2(i+2)，IDCG 为理想排序（相关结果置顶），IDCG=0 时返回 0
 */

export interface RelevanceExpectation {
  expectedDocIds: string[];
  expectedDocTitles: string[];
  expectedTopK: number;
}

/** 单个 run item 的 top-K 指标（内部聚合用） */
export interface RunItemMetrics {
  reciprocalRank: number;
  rankAtK: number | null;
  relevant: boolean;
  precisionAtK: number;
  ndcgAtK: number;
}

/** 单次 run 的聚合指标（结构对齐 KnowledgeRegressionRunMetricsDTO） */
export type RunMetrics = KnowledgeRegressionRunMetricsDTO;

/** 多次 run 的汇总（结构对齐 KnowledgeRegressionMetricsSummaryDTO） */
export type MetricsSummary = KnowledgeRegressionMetricsSummaryDTO;

/** 单条查询的召回明细（结构对齐 KnowledgeRegressionQueryMetricDTO） */
export type QueryMetric = KnowledgeRegressionQueryMetricDTO;

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/** 1/rank，rank 为 null 或 <=0 时返回 0 */
export function reciprocalRank(rank: number | null): number {
  return rank != null && rank > 0 ? 1 / rank : 0;
}

/** 召回结果是否命中期望文档（docId 或 docTitle 匹配，不区分大小写；无期望时恒为 false） */
export function isRelevantResult(
  result: Pick<KnowledgeRegressionResultSnapshotDTO, "docId" | "docTitle">,
  expectedDocIds: string[],
  expectedDocTitles: string[],
): boolean {
  const ids = new Set(expectedDocIds.map(lower));
  const titles = new Set(expectedDocTitles.map(lower));
  if (ids.size === 0 && titles.size === 0) return false;
  return ids.has(lower(result.docId)) || titles.has(lower(result.docTitle));
}

/** 二元增益 NDCG@K；入参是 1-based 排名的相关布尔列表，索引 i 对应排名 i+1 */
export function ndcgAtK(relevantAtRanks: boolean[]): number {
  const dcg = relevantAtRanks.reduce(
    (sum, relevant, i) => (relevant ? sum + 1 / Math.log2(i + 2) : sum),
    0,
  );
  const relevantCount = relevantAtRanks.filter(Boolean).length;
  let idcg = 0;
  for (let i = 0; i < relevantCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

/** 单个 run item 的 top-K 指标。expectation 为 null（case 已删除）时除排名 RR 外全部归零 */
export function evaluateRunItem(
  item: Pick<KnowledgeRegressionRunItemDTO, "rank" | "resultsSnapshot">,
  expectation: RelevanceExpectation | null,
): RunItemMetrics {
  const topK = expectation?.expectedTopK ?? 5;
  const topResults = item.resultsSnapshot.slice(0, topK);
  const relevantFlags = topResults.map((result) =>
    expectation
      ? isRelevantResult(result, expectation.expectedDocIds, expectation.expectedDocTitles)
      : false,
  );
  const relevantCount = relevantFlags.filter(Boolean).length;
  const firstRelevantIndex = relevantFlags.findIndex(Boolean);

  return {
    reciprocalRank: reciprocalRank(item.rank),
    rankAtK: firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : null,
    relevant: relevantCount > 0,
    precisionAtK: topK > 0 ? relevantCount / topK : 0,
    ndcgAtK: ndcgAtK(relevantFlags),
  };
}

/** 聚合单次 run 的全部 item 指标 */
export function evaluateRun(
  run: KnowledgeRegressionRunDTO,
  casesById: ReadonlyMap<string, KnowledgeRegressionCaseDTO>,
): RunMetrics {
  const itemMetrics = run.items.map((item) =>
    evaluateRunItem(item, casesById.get(item.caseId) ?? null),
  );
  const n = run.items.length;
  const average = (values: number[]): number =>
    n > 0 ? values.reduce((sum, value) => sum + value, 0) / n : 0;

  const ranked = run.items
    .map((item) => item.rank)
    .filter((value): value is number => value != null);
  const averageRank =
    ranked.length > 0
      ? ranked.reduce((sum, value) => sum + value, 0) / ranked.length
      : null;
  const averageElapsedMs =
    n > 0
      ? run.items.reduce((sum, item) => sum + item.elapsedMs, 0) / n
      : null;

  return {
    runId: run.id,
    testSetId: run.testSetId,
    createdAt: run.createdAt,
    totalCases: run.totalCases,
    hitRate: n > 0 ? run.items.filter((item) => item.passed).length / n : 0,
    mrr: average(itemMetrics.map((metric) => metric.reciprocalRank)),
    recallAtK: average(itemMetrics.map((metric) => (metric.relevant ? 1 : 0))),
    precisionAtK: average(itemMetrics.map((metric) => metric.precisionAtK)),
    ndcgAtK: average(itemMetrics.map((metric) => metric.ndcgAtK)),
    averageRank,
    averageElapsedMs,
  };
}

/** 单条查询的完整召回明细（供 UI 展开展示，含命中所处排名以便高亮） */
export function evaluateQueryMetric(
  item: KnowledgeRegressionRunItemDTO,
  expectation: RelevanceExpectation | null,
): QueryMetric {
  const topK = expectation?.expectedTopK ?? 5;
  const topResults = item.resultsSnapshot.slice(0, topK);
  const relevantFlags = topResults.map((result) =>
    expectation
      ? isRelevantResult(result, expectation.expectedDocIds, expectation.expectedDocTitles)
      : false,
  );
  const relevantRanks = item.resultsSnapshot
    .map((result, index) => ({ result, index }))
    .filter(({ result }) =>
      expectation
        ? isRelevantResult(result, expectation.expectedDocIds, expectation.expectedDocTitles)
        : false,
    )
    .map(({ index }) => index + 1);

  return {
    caseId: item.caseId,
    caseName: item.caseName,
    query: item.query,
    passed: item.passed,
    rank: item.rank,
    reciprocalRank: reciprocalRank(item.rank),
    relevant: relevantFlags.some(Boolean),
    precisionAtK: topK > 0 ? relevantFlags.filter(Boolean).length / topK : 0,
    ndcgAtK: ndcgAtK(relevantFlags),
    matchedDocId: item.matchedDocId,
    failureReason: item.failureReason,
    elapsedMs: item.elapsedMs,
    relevantRanks,
    resultsSnapshot: item.resultsSnapshot,
  };
}

/** 汇总多次 run。runs 需为时间正序（旧→新），latest 取最后一条 */
export function computeMetricsSummary(runs: RunMetrics[]): MetricsSummary {
  if (runs.length === 0) {
    return { runCount: 0, totalCases: 0, latest: null, average: null };
  }

  const totalCases = runs.reduce((sum, run) => sum + run.totalCases, 0);
  const averageOf = (
    key: "hitRate" | "mrr" | "recallAtK" | "precisionAtK" | "ndcgAtK",
  ): number => runs.reduce((sum, run) => sum + run[key], 0) / runs.length;

  const averageRankValues = runs
    .map((run) => run.averageRank)
    .filter((value): value is number => value != null);
  const elapsedValues = runs
    .map((run) => run.averageElapsedMs)
    .filter((value): value is number => value != null);

  const average: KnowledgeRegressionAverageMetricsDTO = {
    hitRate: averageOf("hitRate"),
    mrr: averageOf("mrr"),
    recallAtK: averageOf("recallAtK"),
    precisionAtK: averageOf("precisionAtK"),
    ndcgAtK: averageOf("ndcgAtK"),
    averageRank:
      averageRankValues.length > 0
        ? averageRankValues.reduce((sum, value) => sum + value, 0) / averageRankValues.length
        : null,
    averageElapsedMs:
      elapsedValues.length > 0
        ? elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length
        : null,
  };

  return {
    runCount: runs.length,
    totalCases,
    latest: runs[runs.length - 1],
    average,
  };
}
