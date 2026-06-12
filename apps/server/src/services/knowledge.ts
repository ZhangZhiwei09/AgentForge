// 知识库检索服务 —— 混合搜索（dense + sparse） + LLM Rerank
// 搜索流程：用户查询 → embedding → Milvus dense 搜索 → 合并 BM25 稀疏向量分数 → 可选 LLM 重排序
import { prisma } from "../db.js";
import {
  getMilvusClient,
  MILVUS_KNOWLEDGE_COLLECTION,
  EMBEDDING_DIM,
  ensureKnowledgeCollection,
} from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { tokenize } from "./tokenizer.js";
import { getProvider } from "../providers/registry.js";
import { logger } from "@agentforge/logger";
import { milvusSearchDurationMs } from "../observability/metrics.js";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";

const DENSE_WEIGHT = 0.6; // 语义向量权重
const SPARSE_WEIGHT = 0.4; // 关键词匹配权重

// LLM Rerank 的 system prompt：让 LLM 对候选文档打分排序
const RERANK_SYSTEM_PROMPT = `你是一个搜索相关性评估助手。根据用户的查询，对给定的候选文档片段进行相关性打分。

返回一个 JSON 数组，每个元素包含：
- "index": 候选文档的索引（对应输入中的编号）
- "score": 0.0 到 1.0 之间的相关性分数（1.0 = 完全相关，0.0 = 完全不相关）
- "reason": 简短说明打分的理由

只返回分数最高的前 3 个结果。不相关的文档可以不返回。`;

export interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  chunkIndex: number;
  docTitle: string; // 文档标题（从 PG 关联查询）
}

export class KnowledgeService {
  private collectionLoaded = false;

  // BM25 参数
  private static readonly BM25_K1 = 1.2;
  private static readonly BM25_B = 0.75;

  // 惰性加载 Milvus Collection
  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureKnowledgeCollection();
      this.collectionLoaded = true;
    }
  }

  // 从 PostgreSQL 倒排索引表计算 BM25 关键词匹配分数
  // 查询分词 → 查倒排索引 → 计算 IDF/TF → Okapi BM25 → 归一化到 [0,1]
  private async computeBM25FromIndex(
    query: string,
    candidateChunks: { chunkId: string; content: string }[],
    kbId?: string,
  ): Promise<number[]> {
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0 || candidateChunks.length === 0) {
      return candidateChunks.map(() => 0);
    }

    // 1. 查询倒排索引：获取所有 query term 对应的 chunk 条目
    const indexEntries = await prisma.knowledgeInvertedIndex.findMany({
      where: {
        term: { in: queryTokens },
        ...(kbId ? { kbId } : {}),
      },
      select: { term: true, chunkId: true, termFreq: true },
    });

    // 2. 构建内存 lookup: term → { df, chunks: Map<chunkId, tf> }
    const termInfo = new Map<
      string,
      { df: number; chunks: Map<string, number> }
    >();
    for (const entry of indexEntries) {
      let info = termInfo.get(entry.term);
      if (!info) {
        info = { df: 0, chunks: new Map() };
        termInfo.set(entry.term, info);
      }
      info.chunks.set(
        entry.chunkId,
        (info.chunks.get(entry.chunkId) ?? 0) + entry.termFreq,
      );
      info.df = info.chunks.size; // 包含该 term 的 chunk 数量
    }

    if (termInfo.size === 0) {
      return candidateChunks.map(() => 0);
    }

    // 3. 获取候选 chunk 的文档长度（用于 BM25 归一化）
    const candidateIds = candidateChunks.map((c) => c.chunkId);
    const candidateMetas = await prisma.knowledgeChunk.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, tokenCount: true },
    });
    const docLenMap = new Map(candidateMetas.map((c) => [c.id, c.tokenCount]));

    // 获取 corpus 统计量：总文档数 N 和平均文档长度
    const chunkWhere: any = { enabled: true };
    if (kbId) chunkWhere.knowledgeBaseId = kbId;

    const N = await prisma.knowledgeChunk.count({ where: chunkWhere });
    if (N === 0) return candidateChunks.map(() => 0);

    const aggResult = await prisma.knowledgeChunk.aggregate({
      where: chunkWhere,
      _avg: { tokenCount: true },
    });
    const avgdl = aggResult._avg.tokenCount ?? 1;

    // 4. 对每个候选 chunk 计算 BM25 分数
    const k1 = KnowledgeService.BM25_K1;
    const b = KnowledgeService.BM25_B;
    const scores: number[] = [];

    for (const candidate of candidateChunks) {
      let score = 0;
      const docLen = docLenMap.get(candidate.chunkId) ?? avgdl;

      for (const term of queryTokens) {
        const info = termInfo.get(term);
        if (!info || !info.chunks.has(candidate.chunkId)) continue;

        const tf = info.chunks.get(candidate.chunkId)!;
        const df = info.df;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }

      scores.push(score);
    }

    // 5. 归一化到 [0, 1] 区间（与 dense COSINE 分数兼容）
    const maxScore = Math.max(...scores, 0.0001);
    return scores.map((s) => s / maxScore);
  }

  // 基础搜索：dense embedding → Milvus 向量搜索 → 返回结果
  async search(
    query: string,
    kbIds?: string[] | null, // 可选：限定在指定知识库中搜索
    topK: number = 5,
  ): Promise<KnowledgeSearchResult[]> {
    if (!query.trim()) return [];

    await this.ensureCollection();

    // 1. 获取 embedding provider
    const provider = getDefaultEmbeddingProvider();
    if (!provider) {
      logger.warn("No embedding provider configured");
      return [];
    }

    // 2. 将查询文本转为 dense 向量
    const denseVec = await provider.embedSingle(query);
    if (!denseVec) return [];

    // 3. 记录目标知识库（用于倒排索引查询优化）
    const targetKbId = kbIds && kbIds.length === 1 ? kbIds[0] : undefined;

    // 4. 构建过滤表达式：限定知识库范围
    let filter = "";
    if (kbIds && kbIds.length > 0) {
      const kbFilter = kbIds.map((id) => `kb_id == "${id}"`).join(" || ");
      filter = kbFilter;
    }

    try {
      const client = getMilvusClient();

      // 5. 在 Milvus 中执行向量相似度搜索（只搜索 dense_vector 字段）
      const milvusSearchStart = Date.now();
      const results = await client.search({
        collection_name: MILVUS_KNOWLEDGE_COLLECTION,
        vector: denseVec,
        anns_field: "dense_vector", // 指定搜索字段（避免搜 sparse_vector 无索引报错）
        limit: topK,
        filter,
        output_fields: ["chunk_id", "kb_id", "content"], // 返回这些字段的值
        params: { nprobe: 16 }, // 搜索的聚类数，值越大越精确但越慢
      });
      milvusSearchDurationMs.observe(
        { operation: "knowledge" },
        Date.now() - milvusSearchStart,
      );

      if (!results.results || results.results.length === 0) {
        return [];
      }

      // 6. 组装结果：从 Milvus hit 中提取数据，再从 PG 查 chunk 元信息
      const chunkIds = results.results.map((h) => h.chunk_id as string);
      const chunkMetaMap = await this.getChunkMetas(chunkIds);

      // 7. 从倒排索引计算 BM25 关键词匹配分数（混合搜索）
      const contents = results.results.map((h) => (h.content as string) || "");
      const candidateChunks = results.results.map((h, i) => ({
        chunkId: h.chunk_id as string,
        content: contents[i] || "",
      }));
      const bm25Scores = await this.computeBM25FromIndex(
        query,
        candidateChunks,
        targetKbId,
      );

      const searchResults: KnowledgeSearchResult[] = [];
      for (let i = 0; i < results.results.length; i++) {
        const hit = results.results[i];
        const chunkId = hit.chunk_id as string;
        const kbId = hit.kb_id as string;
        const content = contents[i] || "";
        const denseScore = hit.score ?? 0;
        const sparseScore = bm25Scores[i] || 0;

        // 混合打分：dense 权重 0.6 + sparse 权重 0.4
        const hybridScore =
          DENSE_WEIGHT * denseScore + SPARSE_WEIGHT * sparseScore;

        const meta = chunkMetaMap[chunkId] || {};

        searchResults.push({
          chunkId,
          docId: meta.docId || "",
          kbId,
          content,
          score: Math.round(hybridScore * 10000) / 10000,
          chunkIndex: meta.chunkIndex || 0,
          docTitle: meta.docTitle || "",
        });
      }

      // 按混合分数重新排序
      searchResults.sort((a, b) => b.score - a.score);

      return searchResults;
    } catch (e) {
      logger.warn(e, "Knowledge search failed");
      return [];
    }
  }

  // 带 Rerank 的搜索：先召回 3×topK 候选，再用 LLM 精选 topK
  async searchWithRerank(
    query: string,
    kbIds?: string[] | null,
    topK: number = 5,
    llmProviderName?: string | null,
  ): Promise<KnowledgeSearchResult[]> {
    // 召回阶段：多拿一些候选
    const candidates = await this.search(query, kbIds, topK * 3);

    if (!candidates.length || candidates.length <= topK) {
      return candidates; // 候选数已经足够少，无需 rerank
    }

    if (!llmProviderName) {
      return candidates.slice(0, topK); // 未指定 LLM provider，直接截断
    }

    // Rerank 阶段：让 LLM 对候选文档重新打分
    try {
      const reranked = await this.llmRerank(
        query,
        candidates,
        topK,
        llmProviderName,
      );
      if (reranked) return reranked;
    } catch (e) {
      logger.warn(e, "LLM rerank failed");
    }

    return candidates.slice(0, topK); // Rerank 失败则回退到截断
  }

  // LLM Rerank：将候选文档列表发给 LLM，让它判断相关性并排序
  private async llmRerank(
    query: string,
    candidates: KnowledgeSearchResult[],
    topK: number,
    providerName: string,
  ): Promise<KnowledgeSearchResult[] | null> {
    const provider = getProvider(providerName);

    // 格式化候选文档为编号列表（每篇截断 800 字符，控制 token）
    const candidateTexts = candidates.map(
      (c, i) => `[${i}] ${c.content.slice(0, 800)}`,
    );

    const userMessage = `查询：${query}\n\n候选文档：\n${candidateTexts.join("\n\n")}`;

    // 通过provider抽象层调用，不直接依赖具体厂商SDK
    const model = providerName === "openai" ? "gpt-4o-mini" : "deepseek-chat";

    const result = await provider.chatSync(
      [{ role: "user", content: userMessage }],
      model,
      RERANK_SYSTEM_PROMPT,
      0.1, // 低温度保证打分稳定
      500,
      true, // jsonMode — rerank结果必须是JSON
    );

    // 解析 LLM 返回的 JSON（可能被 markdown 代码块包裹）
    const scores = parseJSONFromLLMResponse(result.content);
    if (!Array.isArray(scores)) return null;

    // 按 LLM 打分重新构造结果
    const reranked: KnowledgeSearchResult[] = [];
    for (const item of scores) {
      const idx = item.index;
      const newScore = item.score || 0;
      if (idx !== undefined && idx >= 0 && idx < candidates.length) {
        const c = candidates[idx];
        reranked.push({
          ...c,
          score: Math.round(parseFloat(newScore) * 10000) / 10000,
        });
      }
    }

    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, topK);
  }

  // 从 PG 批量查 chunk 的文档归属、序号和文档标题
  private async getChunkMetas(
    chunkIds: string[],
  ): Promise<
    Record<string, { docId?: string; chunkIndex?: number; docTitle?: string }>
  > {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, documentId: true, chunkIndex: true },
    });

    // 提取所有唯一的 docId
    const docIds = [...new Set(chunks.map((c) => c.documentId))];

    // 批量查询文档标题
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

  // 获取 Milvus Collection 统计信息（向量总数等）
  async getCollectionStats(): Promise<Record<string, unknown>> {
    try {
      await this.ensureCollection();
      const client = getMilvusClient();
      const stats = await client.getCollectionStatistics({
        collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      });
      return {
        collection: MILVUS_KNOWLEDGE_COLLECTION,
        total_vectors: stats.data?.row_count || 0,
      };
    } catch (e) {
      logger.warn(e, "Failed to get collection stats");
      return { collection: MILVUS_KNOWLEDGE_COLLECTION, total_vectors: 0 };
    }
  }
}
