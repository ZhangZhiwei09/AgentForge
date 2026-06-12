// Milvus 向量数据库客户端模块 —— 管理 Milvus 连接和 Collection 生命周期
// 项目中有两个 Collection：agentforge_memories（长期记忆）和 agentforge_knowledge（知识库）
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import { settings } from "../config.js";

// 单例客户端，惰性初始化
let milvusClient: MilvusClient | null = null;

export function getMilvusClient(): MilvusClient {
  if (!milvusClient) {
    milvusClient = new MilvusClient({
      address: `${settings.milvusHost}:${settings.milvusPort}`,
    });
  }
  return milvusClient;
}

export const MILVUS_MEMORY_COLLECTION = "agentforge_memories";
export const MILVUS_KNOWLEDGE_COLLECTION = "agentforge_knowledge";
export const EMBEDDING_DIM = 1536; // OpenAI text-embedding-ada-002 输出维度

// 确保记忆 Collection 存在且已加载到内存
export async function ensureMemoryCollection(): Promise<void> {
  const client = getMilvusClient();

  const hasCollection = await client.hasCollection({
    collection_name: MILVUS_MEMORY_COLLECTION,
  });

  if (!hasCollection.value) {
    // 创建 Collection 并定义字段结构
    await client.createCollection({
      collection_name: MILVUS_MEMORY_COLLECTION,
      fields: [
        { name: "id", data_type: "Int64", is_primary_key: true, autoID: true },
        { name: "memory_id", data_type: "VarChar", max_length: 64 }, // 对应 PG memories 表的 ID
        { name: "user_id", data_type: "VarChar", max_length: 64 }, // 用于搜索时过滤用户
        { name: "embedding", data_type: "FloatVector", dim: EMBEDDING_DIM }, // 文本语义向量
        { name: "content", data_type: "VarChar", max_length: 4096 }, // 原始文本（截断 4096 字符）
      ],
    });

    // 为 embedding 字段建 IVF_FLAT 索引，加速向量相似度搜索
    await client.createIndex({
      collection_name: MILVUS_MEMORY_COLLECTION,
      field_name: "embedding",
      index_name: "embedding_idx",
      index_type: "IVF_FLAT",
      metric_type: "COSINE", // 余弦相似度
      params: { nlist: 128 },
    });
  }

  // 将 Collection 加载到内存（必须加载后才能搜索）
  await client.loadCollection({
    collection_name: MILVUS_MEMORY_COLLECTION,
  });
}

// 确保知识库 Collection 存在且已加载
// 单向量字段 dense_vector（语义搜索），BM25 关键词匹配在应用层处理
export async function ensureKnowledgeCollection(): Promise<void> {
  const client = getMilvusClient();

  const hasCollection = await client.hasCollection({
    collection_name: MILVUS_KNOWLEDGE_COLLECTION,
  });

  if (!hasCollection.value) {
    await client.createCollection({
      collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      fields: [
        { name: "id", data_type: "Int64", is_primary_key: true, autoID: true },
        { name: "chunk_id", data_type: "VarChar", max_length: 64 }, // 对应 PG knowledge_chunks 表的 ID
        { name: "kb_id", data_type: "VarChar", max_length: 64 }, // 所属知识库 ID
        { name: "dense_vector", data_type: "FloatVector", dim: EMBEDDING_DIM }, // 语义向量（embedding）
        { name: "content", data_type: "VarChar", max_length: 4096 },
      ],
    });

    // dense_vector: IVF_FLAT 索引用于语义搜索
    await client.createIndex({
      collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      field_name: "dense_vector",
      index_name: "dense_idx",
      index_type: "IVF_FLAT",
      metric_type: "COSINE",
      params: { nlist: 128 },
    });
  }

  await client.loadCollection({
    collection_name: MILVUS_KNOWLEDGE_COLLECTION,
  });
}
