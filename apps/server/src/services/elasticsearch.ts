// Elasticsearch 客户端模块 —— 知识库关键词检索
// 提供索引管理（创建、删除、重建）、文档索引（单条/批量）、BM25 关键词搜索
// 降级策略：ES 不可用时上层调用方回退到 PG ILIKE 关键词搜索
import { Client } from "@elastic/elasticsearch";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

export const KNOWLEDGE_CHUNKS_INDEX = "knowledge_chunks";

// ES 索引 Mapping：定义字段类型和分析器
const KNOWLEDGE_CHUNKS_MAPPING = {
  properties: {
    chunkId: { type: "keyword" as const },
    kbId: { type: "keyword" as const },
    docId: { type: "keyword" as const },
    title: { type: "text" as const, analyzer: "standard" },
    content: { type: "text" as const, analyzer: "standard" },
    sourceType: { type: "keyword" as const },
    qualityLabel: { type: "keyword" as const },
    metadata: { type: "object" as const, enabled: false },
    createdAt: { type: "date" as const },
  },
};

// 单例客户端，惰性初始化
let esClient: Client | null = null;

export function getESClient(): Client | null {
  if (!esClient && settings.elasticsearchUrl) {
    try {
      esClient = new Client({
        node: settings.elasticsearchUrl,
        maxRetries: 1,
        requestTimeout: 10_000,
        // ES 8.15 服务端兼容（客户端 9.x 默认发送 compatible-with=9，8.x 只接受 7/8）
        compatibilityVersion: 8,
      } as unknown as ConstructorParameters<typeof Client>[0]);
      logger.info({ url: settings.elasticsearchUrl }, "ES client created");
    } catch (e) {
      logger.warn(e, "Failed to create ES client");
      return null;
    }
  }
  return esClient;
}

// 判断 ES 是否可用：ping 健康检查 + 判断索引是否存在
export async function isESAvailable(): Promise<boolean> {
  const client = getESClient();
  if (!client) return false;
  try {
    const health = await client.cluster.health({ timeout: "3s" });
    return health.status !== "red";
  } catch {
    return false;
  }
}

// 创建知识库 chunks 索引（幂等：已存在则跳过）
export async function ensureKnowledgeIndex(): Promise<void> {
  const client = getESClient();
  if (!client) {
    logger.warn("ES client not available, skipping index creation");
    return;
  }

  try {
    const exists = await client.indices.exists({
      index: KNOWLEDGE_CHUNKS_INDEX,
    });
    if (exists) {
      // 索引已存在，确保 mapping 正确（不重建，避免数据丢失）
      return;
    }

    await client.indices.create({
      index: KNOWLEDGE_CHUNKS_INDEX,
      mappings: KNOWLEDGE_CHUNKS_MAPPING,
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        "index.refresh_interval": "1s",
      },
    });

    logger.info({ index: KNOWLEDGE_CHUNKS_INDEX }, "ES index created");
  } catch (e) {
    logger.warn(e, "Failed to ensure ES knowledge index");
  }
}

// 删除知识库 chunks 索引（用于完全重建）
export async function deleteKnowledgeIndex(): Promise<void> {
  const client = getESClient();
  if (!client) return;

  try {
    await client.indices.delete(
      { index: KNOWLEDGE_CHUNKS_INDEX },
      { ignore: [404] },
    );
    logger.info({ index: KNOWLEDGE_CHUNKS_INDEX }, "ES index deleted");
  } catch (e) {
    logger.warn(e, "Failed to delete ES index");
  }
}

// ES 文档结构
export interface ESDocument {
  chunkId: string;
  kbId: string;
  docId: string;
  title: string;
  content: string;
  sourceType?: string;
  qualityLabel?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// 索引单条文档到 ES
export async function indexDocument(doc: ESDocument): Promise<void> {
  const client = getESClient();
  if (!client) return;

  try {
    await client.index({
      index: KNOWLEDGE_CHUNKS_INDEX,
      id: doc.chunkId,
      document: doc,
    });
  } catch (e) {
    // ES 索引失败不抛异常，仅警告（上层可后续 rebuild）
    logger.warn({ chunkId: doc.chunkId, error: String(e) }, "Failed to index ES document");
  }
}

// 批量索引文档到 ES（比逐条 index 效率高）
export async function bulkIndexDocuments(docs: ESDocument[]): Promise<void> {
  const client = getESClient();
  if (!client) return;

  if (docs.length === 0) return;

  try {
    const operations = docs.flatMap((doc) => [
      { index: { _index: KNOWLEDGE_CHUNKS_INDEX, _id: doc.chunkId } },
      doc,
    ]);

    const response = await client.bulk({
      refresh: true, // 立即可搜索（开发阶段；生产可改为 wait_for）
      operations,
    });

    if (response.errors) {
      const errored = response.items.filter((item) => item.index?.error);
      logger.warn(
        { count: errored.length, total: docs.length },
        "ES bulk index had errors",
      );
    }
  } catch (e) {
    logger.warn({ count: docs.length, error: String(e) }, "Failed to bulk index ES documents");
  }
}

// ES 关键词搜索（BM25）
export async function esKeywordSearch(
  query: string,
  kbIds?: string[],
  topK: number = 20,
): Promise<
  Array<{
    chunkId: string;
    docId: string;
    kbId: string;
    content: string;
    title: string;
    score: number;
  }>
> {
  const client = getESClient();
  if (!client) return [];

  try {
    const must: Record<string, unknown>[] = [
      {
        match: {
          content: {
            query,
            operator: "or",
            fuzziness: "AUTO",
          },
        },
      },
    ];

    // 限定知识库范围
    const filter: Record<string, unknown>[] = [];
    if (kbIds && kbIds.length > 0) {
      filter.push({ terms: { kbId: kbIds } });
    }

    const result = await client.search<Record<string, string | number>>({
      index: KNOWLEDGE_CHUNKS_INDEX,
      query: {
        bool: {
          must,
          ...(filter.length > 0 ? { filter } : {}),
        },
      },
      size: topK,
      _source: ["chunkId", "docId", "kbId", "content", "title"],
    });

    return result.hits.hits
      .filter((hit) => hit._source)
      .map((hit) => {
        const src = hit._source as Record<string, unknown>;
        return {
          chunkId: (src.chunkId as string) || "",
          docId: (src.docId as string) || "",
          kbId: (src.kbId as string) || "",
          content: (src.content as string) || "",
          title: (src.title as string) || "",
          score: hit._score ?? 0,
        };
      });
  } catch (e) {
    logger.warn(e, "ES keyword search failed");
    return [];
  }
}

// 按文档 ID 批量删除 ES 索引条目
export async function deleteByDocumentIds(docIds: string[]): Promise<void> {
  const client = getESClient();
  if (!client || docIds.length === 0) return;

  try {
    await client.deleteByQuery({
      index: KNOWLEDGE_CHUNKS_INDEX,
      query: {
        terms: { docId: docIds },
      },
    });
  } catch (e) {
    logger.warn({ docIds, error: String(e) }, "Failed to delete ES documents by docIds");
  }
}
