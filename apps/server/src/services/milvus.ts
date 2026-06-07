import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import { settings } from "../config.js";

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
export const EMBEDDING_DIM = 1536;

export async function ensureMemoryCollection(): Promise<void> {
  const client = getMilvusClient();

  const hasCollection = await client.hasCollection({
    collection_name: MILVUS_MEMORY_COLLECTION,
  });

  if (!hasCollection.value) {
    await client.createCollection({
      collection_name: MILVUS_MEMORY_COLLECTION,
      fields: [
        { name: "id", data_type: "Int64", is_primary_key: true, autoID: true },
        { name: "memory_id", data_type: "VarChar", max_length: 64 },
        { name: "user_id", data_type: "VarChar", max_length: 64 },
        { name: "embedding", data_type: "FloatVector", dim: EMBEDDING_DIM },
        { name: "content", data_type: "VarChar", max_length: 4096 },
      ],
    });

    await client.createIndex({
      collection_name: MILVUS_MEMORY_COLLECTION,
      field_name: "embedding",
      index_name: "embedding_idx",
      index_type: "IVF_FLAT",
      metric_type: "COSINE",
      params: { nlist: 128 },
    });
  }

  await client.loadCollection({
    collection_name: MILVUS_MEMORY_COLLECTION,
  });
}

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
        { name: "chunk_id", data_type: "VarChar", max_length: 64 },
        { name: "kb_id", data_type: "VarChar", max_length: 64 },
        { name: "dense_vector", data_type: "FloatVector", dim: EMBEDDING_DIM },
        { name: "sparse_vector", data_type: "FloatVector", dim: EMBEDDING_DIM },
        { name: "content", data_type: "VarChar", max_length: 4096 },
      ],
    });

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
