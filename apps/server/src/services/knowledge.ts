// 知识库检索服务 —— V3.0 混合搜索：PGVector 语义 + Elasticsearch 关键词 + RRF 融合 + Reranker 重排
//
// 搜索流程：
//   Route 1: Embedding(query) → PGVector COSINE → topK*5 dense candidates
//   Route 2: query → Elasticsearch BM25 → topK*5 sparse candidates
//   → RRF(dense, sparse, k=60) → topK*3 fused
//   → HTTP Reranker (可选) → topK final
//   → 降级: ES 不可用 → 纯 PGVector; Reranker 不可用 → RRF 分数
//
// 兼容性：
//   - search() 和 searchWithRerank() 保持对外 API 兼容，内部切换到新链路
//   - 新增 searchHybrid() 返回更丰富的源标识和融合分数
//   - 旧 search() 内部不再使用 Milvus，全部迁移到 PGVector + ES
//   - 旧 searchWithRerank() 的 LLM rerank 替换为 HTTP Reranker

import { prisma } from "../db.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { esKeywordSearch, isESAvailable } from "./elasticsearch.js";
import { getReranker, type RerankerDocument } from "./reranker.js";
import { getProvider } from "../providers/registry.js";
import { logger } from "@agentforge/logger";
import { milvusSearchDurationMs } from "../observability/metrics.js";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";
import { settings } from "../config.js";

// ── 类型定义 ──────────────────────────────────────────────

export interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  chunkIndex: number;
  docTitle: string;
}

// V3.0: 扩展的搜索结果，包含召回来源和融合/重排分数
export interface HybridSearchResult {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;                   // 最终分数
  fusionScore: number;             // RRF 融合分数
  rerankScore?: number;            // Reranker 精排分数（如有）
  recallSources: ("pgvector" | "elasticsearch")[];  // 召回来源
  chunkIndex: number;
  docTitle: string;
}

export interface HybridSearchParams {
  query: string;
  kbIds?: string[];
  topK?: number;                   // 最终返回数，默认 5
  useReranker?: boolean;           // 是否启用 Reranker，默认 true
}

// ── 常量 ──────────────────────────────────────────────────

const RRF_K = 60;                  // RRF 平滑常数
const RECALL_MULTIPLIER = 5;       // 每路召回 topK * 5 候选
const FUSED_MULTIPLIER = 3;        // 融合后取 topK * 3 进入 rerank

// ── RRF 融合辅助函数 ──────────────────────────────────────

export interface RawCandidate {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  docTitle: string;
  chunkIndex: number;
  sourceScore: number;
  source: "pgvector" | "elasticsearch";
}

/**
 * RRF (Reciprocal Rank Fusion) 融合多路召回结果。
 * RRF_score(d) = sum over each ranking list R: 1 / (k + rank_d_in_R)
 * 其中 rank 是 1-based（从 1 开始）。
 *
 * @param denseResults   - PGVector 向量召回结果（已按分数降序）
 * @param sparseResults  - Elasticsearch 关键词召回结果（已按分数降序）
 * @param topK           - 融合后保留的数量
 * @returns 按 RRF 分数降序排列的候选列表
 */
export function rrfFusion(
  denseResults: RawCandidate[],
  sparseResults: RawCandidate[],
  topK: number = 30,
): (RawCandidate & { fusionScore: number; recallSources: ("pgvector" | "elasticsearch")[] })[] {
  const chunkMap = new Map<
    string,
    {
      candidate: RawCandidate;
      rrfScore: number;
      sources: Set<"pgvector" | "elasticsearch">;
    }
  >();

  // 处理 dense 结果（rank 从 1 开始）
  for (let i = 0; i < denseResults.length; i++) {
    const rank = i + 1;
    const r = denseResults[i];
    const entry = chunkMap.get(r.chunkId);
    if (entry) {
      entry.rrfScore += 1 / (RRF_K + rank);
      entry.sources.add("pgvector");
    } else {
      chunkMap.set(r.chunkId, {
        candidate: r,
        rrfScore: 1 / (RRF_K + rank),
        sources: new Set(["pgvector"]),
      });
    }
  }

  // 处理 sparse 结果（rank 从 1 开始）
  for (let i = 0; i < sparseResults.length; i++) {
    const rank = i + 1;
    const r = sparseResults[i];
    const entry = chunkMap.get(r.chunkId);
    if (entry) {
      entry.rrfScore += 1 / (RRF_K + rank);
      entry.sources.add("elasticsearch");
    } else {
      chunkMap.set(r.chunkId, {
        candidate: r,
        rrfScore: 1 / (RRF_K + rank),
        sources: new Set(["elasticsearch"]),
      });
    }
  }

  // 按 RRF 分数降序排序，去重取 topK
  const fused = Array.from(chunkMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map((entry) => ({
      ...entry.candidate,
      fusionScore: Math.round(entry.rrfScore * 10000) / 10000,
      recallSources: Array.from(entry.sources) as ("pgvector" | "elasticsearch")[],
    }));

  return fused;
}

// ── 相邻 Chunk 去重辅助 ──────────────────────────────────

/**
 * 相邻 chunk 去重结果。
 */
interface DedupResult<T> {
  kept: T[];
  removed: T[];
}

/**
 * 相邻 chunk 去重。
 *
 * 在两阶段去重后保留高分候选：
 *   1. 邻接去重：同一 docId 且 chunkIndex 距离 ≤ neighborWindow 的，只保留分数高者。
 *   2. 文本重叠去重：token/Jaccard overlap > similarityThreshold 的，只保留分数高者。
 *
 * 保留顺序（高分在前），不改变相对排序。
 *
 * @param candidates - RRF 融合后的候选列表（已按分数降序排列）
 * @param neighborWindow - 视为"相邻"的 chunkIndex 最大距离（默认 1）
 * @param similarityThreshold - 文本重叠阈值（默认 0.82）
 * @returns 去重后的候选列表
 */
export function dedupeAdjacentChunks<T extends { docId: string; chunkIndex: number; content: string }>(
  candidates: T[],
  neighborWindow: number = 1,
  similarityThreshold: number = 0.82,
): DedupResult<T> {
  if (candidates.length <= 1) return { kept: candidates, removed: [] };

  const kept: T[] = [];
  const removed: T[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i];
    let shouldSkip = false;

    for (let j = 0; j < kept.length; j++) {
      const prev = kept[j];

      // 条件 1: 同一文档且 chunkIndex 相邻
      if (
        prev.docId === current.docId &&
        Math.abs(prev.chunkIndex - current.chunkIndex) <= neighborWindow
      ) {
        // 当前分数更低 → 丢弃；否则不应该出现（已排序），但保留以防万一
        shouldSkip = true;
        break;
      }

      // 条件 2: 文本重叠度超过阈值（Jaccard similarity on tokens）
      const overlap = computeTokenOverlap(prev.content, current.content);
      if (overlap > similarityThreshold) {
        shouldSkip = true;
        break;
      }
    }

    if (shouldSkip) {
      removed.push(current);
    } else {
      kept.push(current);
    }
  }

  return { kept, removed };
}

/**
 * 计算两段文本的 token 重叠度（简化 Jaccard）。
 *
 * 使用字符 bigram 快速估算文本相似度，避免完整 tokenization 开销。
 * 分数范围 [0, 1]，越高表示越相似。
 */
export function computeTokenOverlap(a: string, b: string): number {
  if (!a || !b) return 0;

  // 生成字符 bigram 集合
  const bigramsA = toBigramSet(a);
  const bigramsB = toBigramSet(b);

  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  // Jaccard similarity: |intersection| / |union|
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 生成文本的字符 bigram 集合。
 * 中英文统一处理，CJK 字符间也生成 bigram。
 */
function toBigramSet(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length < 2) {
    if (text.length === 1) set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

// ── KnowledgeService ──────────────────────────────────────

export class KnowledgeService {
  /**
   * V3.0 主搜索方法：PGVector 语义 + ES 关键词 → RRF 融合 → Reranker 重排
   * 所有降级路径内置，ES/Reranker 不可用时自动降级不阻塞。
   */
  async searchHybrid(params: HybridSearchParams): Promise<HybridSearchResult[]> {
    const { query, kbIds, topK = 5, useReranker = true } = params;
    if (!query.trim()) return [];

    const provider = getDefaultEmbeddingProvider();
    if (!provider) {
      logger.warn("No embedding provider configured");
      return [];
    }

    // 1. 生成查询向量
    const queryVec = await provider.embedSingle(query);
    if (!queryVec) return [];

    const recallSize = topK * RECALL_MULTIPLIER;
    const fusedSize = topK * FUSED_MULTIPLIER;

    // 2. 并行双路召回：PGVector + Elasticsearch
    const [denseResults, sparseResults] = await Promise.all([
      this.pgVectorSearch(queryVec, kbIds, recallSize),
      this.esKeywordRecall(query, kbIds, recallSize),
    ]);

    // 3. RRF 融合
    const fused = rrfFusion(denseResults, sparseResults, fusedSize);

    if (fused.length === 0) return [];

    // 4. 相邻 Chunk 去重（在 Reranker 之前）
    const deduped = dedupeAdjacentChunks(
      fused,
      settings.kbDedupeNeighborWindow,
      settings.kbDedupeSimilarityThreshold,
    );

    if (deduped.removed.length > 0) {
      logger.debug(
        { kept: deduped.kept.length, removed: deduped.removed.length },
        "Adjacent chunk dedup applied",
      );
    }

    const dedupedCandidates = deduped.kept;

    // 5. Reranker 重排（可选，可降级）
    const reranker = getReranker();
    if (useReranker && reranker.isConfigured()) {
      const rerankDocs: RerankerDocument[] = dedupedCandidates.map((f) => ({
        text: f.content.slice(0, 800),  // 截断控制 token
        id: f.chunkId,
      }));

      const rerankResults = await reranker.rerank(query, rerankDocs, topK);

      if (rerankResults.length > 0) {
        // 用 Reranker 分数重新排序
        const reranked: HybridSearchResult[] = [];
        for (const rr of rerankResults) {
          const original = dedupedCandidates[rr.index];
          if (!original) continue;
          reranked.push({
            ...original,
            score: Math.round(rr.score * 10000) / 10000,
            rerankScore: Math.round(rr.score * 10000) / 10000,
          });
        }
        reranked.sort((a, b) => b.score - a.score);
        return reranked.slice(0, topK);
      }
      // Reranker 失败 → 回退到 RRF 融合分数
    }

    // 6. 无 Reranker 或 Reranker 失败 → 用 RRF 分数作为最终分数
    return dedupedCandidates.slice(0, topK).map((f) => ({
      ...f,
      score: f.fusionScore,
    }));
  }

  /**
   * PGVector 语义搜索：向量余弦相似度检索
   * 使用 PostgreSQL `<->` 操作符（欧几里得距离）或 `<=>` (余弦距离)
   */
  private async pgVectorSearch(
    queryVec: number[],
    kbIds?: string[],
    topK: number = 20,
  ): Promise<RawCandidate[]> {
    try {
      // 格式化向量为 PGVector 字面量: '[0.1, 0.2, ...]'
      const vecLiteral = `[${queryVec.join(",")}]`;

      // 构建 kbId 过滤条件
      let kbFilter = "";
      const kbParams: string[] = [];
      if (kbIds && kbIds.length > 0) {
        kbFilter = `AND knowledge_base_id IN (${kbIds.map((_, i) => `$${i + 2}`).join(",")})`;
        kbParams.push(...kbIds);
      }

      // 使用余弦距离运算符 `<=>` 进行相似度搜索
      // 注意：Prisma 不支持 raw PGVector 查询，使用 $queryRawUnsafe
      const sql = `
        SELECT
          kc.id AS "chunkId",
          kc.document_id AS "docId",
          kc.knowledge_base_id AS "kbId",
          kc.content,
          kc.chunk_index AS "chunkIndex",
          COALESCE(kd.title, '') AS "docTitle",
          1 - (kc.embedding <=> $1::vector) AS "score"
        FROM knowledge_chunks kc
        JOIN knowledge_documents kd ON kc.document_id = kd.id
        WHERE kc.embedding IS NOT NULL
          AND kc.enabled = true
          ${kbFilter}
        ORDER BY kc.embedding <=> $1::vector
        LIMIT $${kbIds ? kbIds.length + 2 : 2}
      `;

      const params = [vecLiteral, ...kbParams, topK];

      const rows = await prisma.$queryRawUnsafe<Array<{
        chunkId: string;
        docId: string;
        kbId: string;
        content: string;
        chunkIndex: number;
        docTitle: string;
        score: number;
      }>>(sql, ...params);

      return rows.map((row) => ({
        chunkId: row.chunkId,
        docId: row.docId,
        kbId: row.kbId,
        content: row.content,
        docTitle: row.docTitle,
        chunkIndex: row.chunkIndex,
        sourceScore: typeof row.score === "number" ? row.score : 0,
        source: "pgvector" as const,
      }));
    } catch (e) {
      logger.warn(e, "PGVector search failed");
      return [];
    }
  }

  /**
   * ES 关键词召回（包装 elasticsearch.ts 的方法）
   * ES 不可用时回退到空结果（RRF 融合时仅依赖 PGVector 单路）
   */
  private async esKeywordRecall(
    query: string,
    kbIds?: string[],
    topK: number = 20,
  ): Promise<RawCandidate[]> {
    try {
      const esAvailable = await isESAvailable();
      if (!esAvailable) {
        logger.debug("ES unavailable, skipping keyword recall");
        return [];
      }

      const results = await esKeywordSearch(query, kbIds, topK);

      // 获取 chunk 的元数据（chunkIndex, docTitle）
      const chunkIds = results.map((r) => r.chunkId);
      const metaMap = await this.getChunkMetas(chunkIds);

      return results.map((r) => {
        const meta = metaMap[r.chunkId] || {};
        return {
          chunkId: r.chunkId,
          docId: r.docId,
          kbId: r.kbId,
          content: r.content,
          docTitle: r.title || meta.docTitle || "",
          chunkIndex: meta.chunkIndex || 0,
          sourceScore: r.score,
          source: "elasticsearch" as const,
        };
      });
    } catch (e) {
      logger.warn(e, "ES keyword recall failed");
      return [];
    }
  }

  // ── 向后兼容方法 ────────────────────────────────────────

  /**
   * 向后兼容的 search() 方法。
   * 内部切换到 searchHybrid 链路，保持对外 API 兼容。
   */
  async search(
    query: string,
    kbIds?: string[] | null,
    topK: number = 5,
  ): Promise<KnowledgeSearchResult[]> {
    const hybridResults = await this.searchHybrid({
      query,
      kbIds: kbIds ?? undefined,
      topK,
      useReranker: false,  // search() 不带 rerank，由 searchWithRerank() 负责
    });

    return hybridResults.map((r) => ({
      chunkId: r.chunkId,
      docId: r.docId,
      kbId: r.kbId,
      content: r.content,
      score: r.score,
      chunkIndex: r.chunkIndex,
      docTitle: r.docTitle,
    }));
  }

  /**
   * 向后兼容的 searchWithRerank() 方法。
   * 内部切换到 searchHybrid + HTTP Reranker 链路。
   * llmProviderName 参数保留但不再使用（原用于 LLM rerank）。
   */
  async searchWithRerank(
    query: string,
    kbIds?: string[] | null,
    topK: number = 5,
    _llmProviderName?: string | null,  // 废弃：保留兼容性
  ): Promise<KnowledgeSearchResult[]> {
    const hybridResults = await this.searchHybrid({
      query,
      kbIds: kbIds ?? undefined,
      topK,
      useReranker: true,
    });

    return hybridResults.map((r) => ({
      chunkId: r.chunkId,
      docId: r.docId,
      kbId: r.kbId,
      content: r.content,
      score: r.score,
      chunkIndex: r.chunkIndex,
      docTitle: r.docTitle,
    }));
  }

  // ── 工具方法 ────────────────────────────────────────────

  // 从 PG 批量查 chunk 的文档归属和序号
  private async getChunkMetas(
    chunkIds: string[],
  ): Promise<
    Record<string, { docId?: string; chunkIndex?: number; docTitle?: string }>
  > {
    if (chunkIds.length === 0) return {};

    const chunks = await prisma.knowledgeChunk.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, documentId: true, chunkIndex: true },
    });

    const docIds = [...new Set(chunks.map((c) => c.documentId))];
    const docs = await prisma.knowledgeDocument.findMany({
      where: { id: { in: docIds } },
      select: { id: true, title: true },
    });
    const docTitleMap = new Map(docs.map((d) => [d.id, d.title]));

    const result: Record<
      string,
      { docId?: string; chunkIndex?: number; docTitle?: string }
    > = {};
    for (const chunk of chunks) {
      result[chunk.id] = {
        docId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        docTitle: docTitleMap.get(chunk.documentId) || "",
      };
    }
    return result;
  }

  // 获取 Collection 统计信息（不再依赖 Milvus，返回 PGVector 统计）
  async getCollectionStats(): Promise<Record<string, unknown>> {
    try {
      const chunkCount = await prisma.knowledgeChunk.count({
        where: { enabled: true },
      });
      // PGVector embedding 数量用 raw SQL 查询（Prisma Unsupported 类型不支持 where 过滤）
      let withEmbedding = 0;
      try {
        const embResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT COUNT(*) as count FROM knowledge_chunks WHERE embedding IS NOT NULL AND enabled = true`,
        );
        withEmbedding = Number(embResult[0]?.count ?? 0);
      } catch {
        // PGVector 扩展未安装等情况
      }

      let esAvailable = false;
      let esIndexCount = 0;
      try {
        esAvailable = await isESAvailable();
        if (esAvailable) {
          const { Client } = await import("@elastic/elasticsearch");
          const es = new Client({ node: settings.elasticsearchUrl });
          const count = await es.count({ index: "knowledge_chunks" });
          esIndexCount = count.count;
        }
      } catch {
        // ES stats unavailable
      }

      return {
        totalChunks: chunkCount,
        chunksWithEmbedding: withEmbedding,
        pgvectorEnabled: settings.pgvectorEnabled,
        elasticsearchAvailable: esAvailable,
        elasticsearchIndexedChunks: esIndexCount,
      };
    } catch (e) {
      logger.warn(e, "Failed to get collection stats");
      return { totalChunks: 0 };
    }
  }
}
