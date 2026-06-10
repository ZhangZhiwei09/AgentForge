// 知识库检索服务 —— 混合搜索（dense + sparse） + LLM Rerank
// 搜索流程：用户查询 → embedding → Milvus dense 搜索 → 合并 BM25 稀疏向量分数 → 可选 LLM 重排序
import { prisma } from "../db.js";
import { getMilvusClient, MILVUS_KNOWLEDGE_COLLECTION, EMBEDDING_DIM, ensureKnowledgeCollection } from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { BM25SparseEncoder } from "./bm25.js";
import { getProvider } from "../providers/registry.js";
import { logger } from "@agentforge/logger";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";

const DENSE_WEIGHT = 0.6;  // 语义向量权重
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
  docTitle: string;  // 文档标题（从 PG 关联查询）
}

export class KnowledgeService {
  private collectionLoaded = false;
  private bm25Encoder: BM25SparseEncoder | null = null;
  private bm25FittedKbIds = new Set<string>(); // 记录已训练 BM25 的知识库

  // 惰性加载 Milvus Collection
  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureKnowledgeCollection();
      this.collectionLoaded = true;
    }
  }

  private getBM25(): BM25SparseEncoder {
    if (!this.bm25Encoder) {
      this.bm25Encoder = new BM25SparseEncoder();
    }
    return this.bm25Encoder;
  }

  // 确保 BM25 已在知识库语料上训练（惰性，只训练一次）
  async ensureBM25Fitted(kbId?: string): Promise<void> {
    const bm25 = this.getBM25();
    const targetKbId = kbId || "__all__";

    if (this.bm25FittedKbIds.has(targetKbId)) return;

    try {
      const where: any = { enabled: true };
      if (kbId) where.knowledgeBaseId = kbId;

      const chunks = await prisma.knowledgeChunk.findMany({
        where,
        select: { content: true },
        take: 5000, // 最多训练 5000 个 chunk
      });

      if (chunks.length > 0) {
        const corpus = chunks.map((c) => c.content);
        bm25.fit(corpus);
        this.bm25FittedKbIds.add(targetKbId);
        logger.info({ kbId: targetKbId, corpus: corpus.length }, "BM25 fitted");
      }
    } catch (e) {
      logger.warn(e, "BM25 fit failed");
    }
  }

  // 使 BM25 缓存失效（文档增删后调用，触发下次搜索时重新训练）
  async invalidateBM25Cache(kbId?: string): Promise<void> {
    const targetKbId = kbId || "__all__";
    this.bm25FittedKbIds.delete(targetKbId);
    logger.info({ kbId: targetKbId }, "BM25 cache invalidated");
  }

  // 计算查询与候选文本之间的 BM25 关键词相似度分数
  // 使用稀疏向量点积作为相似度度量
  private computeBM25Scores(query: string, candidates: string[]): number[] {
    const bm25 = this.getBM25();
    const queryVecs = bm25.encodeQueries([query]);
    const queryVec = queryVecs[0] ?? {};

    if (Object.keys(queryVec).length === 0) {
      return candidates.map(() => 0); // 无词汇匹配，全返回 0
    }

    const docVecs = bm25.encodeDocuments(candidates);
    return docVecs.map((docVec) => {
      let dotProduct = 0;
      for (const [idx, qWeight] of Object.entries(queryVec)) {
        const dWeight = docVec[idx] ?? 0;
        dotProduct += qWeight * dWeight;
      }
      // 归一化：除以 sqrt(查询L2 * 文档L2) 得到余弦相似度
      const queryNorm = Math.sqrt(
        Object.values(queryVec).reduce((sum, v) => sum + v * v, 0),
      );
      const docNorm = Math.sqrt(
        Object.values(docVec).reduce((sum, v) => sum + v * v, 0),
      );
      if (queryNorm === 0 || docNorm === 0) return 0;
      return dotProduct / (queryNorm * docNorm);
    });
  }

  // 基础搜索：dense embedding → Milvus 向量搜索 → 返回结果
  async search(
    query: string,
    kbIds?: string[] | null,    // 可选：限定在指定知识库中搜索
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

    // 3. 确保 BM25 已在知识库语料上训练
    const targetKbId = kbIds && kbIds.length === 1 ? kbIds[0] : undefined;
    await this.ensureBM25Fitted(targetKbId);

    // 4. 构建过滤表达式：限定知识库范围
    let filter = "";
    if (kbIds && kbIds.length > 0) {
      const kbFilter = kbIds.map((id) => `kb_id == "${id}"`).join(" || ");
      filter = kbFilter;
    }

    try {
      const client = getMilvusClient();

      // 5. 在 Milvus 中执行向量相似度搜索（只搜索 dense_vector 字段）
      const results = await client.search({
        collection_name: MILVUS_KNOWLEDGE_COLLECTION,
        vector: denseVec,
        anns_field: "dense_vector", // 指定搜索字段（避免搜 sparse_vector 无索引报错）
        limit: topK,
        filter,
        output_fields: ["chunk_id", "kb_id", "content"], // 返回这些字段的值
        params: { nprobe: 16 }, // 搜索的聚类数，值越大越精确但越慢
      });

      if (!results.results || results.results.length === 0) {
        return [];
      }

      // 6. 组装结果：从 Milvus hit 中提取数据，再从 PG 查 chunk 元信息
      const chunkIds = results.results.map((h) => h.chunk_id as string);
      const chunkMetaMap = await this.getChunkMetas(chunkIds);

      // 7. 计算 BM25 关键词匹配分数（混合搜索）
      const contents = results.results.map((h) => (h.content as string) || "");
      const bm25Scores = this.computeBM25Scores(query, contents);

      const searchResults: KnowledgeSearchResult[] = [];
      for (let i = 0; i < results.results.length; i++) {
        const hit = results.results[i];
        const chunkId = hit.chunk_id as string;
        const kbId = hit.kb_id as string;
        const content = contents[i] || "";
        const denseScore = hit.score ?? 0;
        const sparseScore = bm25Scores[i] || 0;

        // 混合打分：dense 权重 0.6 + sparse 权重 0.4
        const hybridScore = DENSE_WEIGHT * denseScore + SPARSE_WEIGHT * sparseScore;

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
      const reranked = await this.llmRerank(query, candidates, topK, llmProviderName);
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
  private async getChunkMetas(chunkIds: string[]): Promise<Record<string, { docId?: string; chunkIndex?: number; docTitle?: string }>> {
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

    const result: Record<string, { docId?: string; chunkIndex?: number; docTitle?: string }> = {};
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
