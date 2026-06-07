import { prisma } from "../db.js";
import { getMilvusClient, MILVUS_KNOWLEDGE_COLLECTION, EMBEDDING_DIM, ensureKnowledgeCollection } from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { BM25SparseEncoder } from "./bm25.js";
import { settings } from "../config.js";
import { getProvider } from "../providers/registry.js";
import OpenAI from "openai";

const DENSE_WEIGHT = 0.6;
const SPARSE_WEIGHT = 0.4;

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
}

export class KnowledgeService {
  private collectionLoaded = false;
  private bm25Encoder: BM25SparseEncoder | null = null;

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

  async search(
    query: string,
    kbIds?: string[] | null,
    topK: number = 5,
  ): Promise<KnowledgeSearchResult[]> {
    if (!query.trim()) return [];

    await this.ensureCollection();

    // Get embedding
    const provider = getDefaultEmbeddingProvider();
    if (!provider) {
      console.warn("[knowledge] No embedding provider configured");
      return [];
    }

    const denseVec = await provider.embedSingle(query);
    if (!denseVec) return [];

    // Get sparse vector from BM25
    const bm25 = this.getBM25();
    const sparseVecs = bm25.encodeQueries([query]);
    const sparseVec = sparseVecs[0] ?? {};

    // Build filter expression
    let filter = "";
    if (kbIds && kbIds.length > 0) {
      const kbFilter = kbIds.map((id) => `kb_id == "${id}"`).join(" || ");
      filter = kbFilter;
    }

    try {
      const client = getMilvusClient();

      const results = await client.search({
        collection_name: MILVUS_KNOWLEDGE_COLLECTION,
        vector: denseVec,
        limit: topK,
        filter,
        output_fields: ["chunk_id", "kb_id", "content"],
        params: { nprobe: 16 },
      });

      if (!results.results || results.results.length === 0) {
        return [];
      }

      const searchResults: KnowledgeSearchResult[] = [];
      for (const hit of results.results) {
        const chunkId = hit.chunk_id as string;
        const kbId = hit.kb_id as string;
        const content = (hit.content as string) || "";
        const score = hit.score ?? 0;

        // Get chunk meta from PG
        const meta = await this.getChunkMeta(chunkId);

        searchResults.push({
          chunkId,
          docId: meta.docId || "",
          kbId,
          content,
          score: Math.round(score * 10000) / 10000,
          chunkIndex: meta.chunkIndex || 0,
        });
      }

      return searchResults;
    } catch (e) {
      console.warn(`[knowledge] Search failed:`, e);
      return [];
    }
  }

  async searchWithRerank(
    query: string,
    kbIds?: string[] | null,
    topK: number = 5,
    llmProviderName?: string | null,
  ): Promise<KnowledgeSearchResult[]> {
    // Recall phase
    const candidates = await this.search(query, kbIds, topK * 3);

    if (!candidates.length || candidates.length <= topK) {
      return candidates;
    }

    if (!llmProviderName) {
      return candidates.slice(0, topK);
    }

    // Rerank phase
    try {
      const reranked = await this.llmRerank(query, candidates, topK, llmProviderName);
      if (reranked) return reranked;
    } catch (e) {
      console.warn(`[knowledge] LLM rerank failed:`, e);
    }

    return candidates.slice(0, topK);
  }

  private async llmRerank(
    query: string,
    candidates: KnowledgeSearchResult[],
    topK: number,
    providerName: string,
  ): Promise<KnowledgeSearchResult[] | null> {
    const provider = getProvider(providerName);

    const candidateTexts = candidates.map(
      (c, i) => `[${i}] ${c.content.slice(0, 800)}`,
    );

    const userMessage = `查询：${query}\n\n候选文档：\n${candidateTexts.join("\n\n")}`;

    // Use direct OpenAI call for reranking
    let client: OpenAI;
    let model: string;

    if (providerName === "openai" && settings.openaiApiKey) {
      client = new OpenAI({
        apiKey: settings.openaiApiKey,
        baseURL: settings.openaiBaseUrl,
      });
      model = "gpt-4o-mini";
    } else {
      client = new OpenAI({
        apiKey: settings.deepseekApiKey,
        baseURL: settings.deepseekBaseUrl,
      });
      model = "deepseek-chat";
    }

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: RERANK_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    let raw = response.choices[0].message.content?.trim() || "";
    if (raw.startsWith("```")) {
      raw = raw.split("```")[1];
      if (raw.startsWith("json")) raw = raw.slice(4);
      raw = raw.trim();
    }

    const scores = JSON.parse(raw);
    if (!Array.isArray(scores)) return null;

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

  private async getChunkMeta(chunkId: string): Promise<{ docId?: string; chunkIndex?: number }> {
    const chunk = await prisma.knowledgeChunk.findUnique({
      where: { id: chunkId },
      select: { documentId: true, chunkIndex: true },
    });
    if (chunk) {
      return { docId: chunk.documentId, chunkIndex: chunk.chunkIndex };
    }
    return {};
  }

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
      console.warn(`[knowledge] Failed to get collection stats:`, e);
      return { collection: MILVUS_KNOWLEDGE_COLLECTION, total_vectors: 0 };
    }
  }
}
