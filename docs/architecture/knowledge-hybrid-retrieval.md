# Knowledge Base Hybrid Retrieval — 数据流转全链路

本文档描述 AgentForge 知识库从**文档摄入→索引构建→混合检索→结果精排**的完整数据流转架构。

## 一、系统架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INGESTION PIPELINE                           │
│                                                                      │
│  File Upload / API ─→ Parser ─→ Normalizer ─→ Quality Gate          │
│       │                                        │                    │
│       ▼                                        ▼                    │
│  Text Splitter ◄────────────────────── proceed / flag_low / reject  │
│       │                                                              │
│       ▼                                                              │
│  Embedding Provider (Ollama / OpenAI)                                │
│       │                                                              │
│       ├──→ PostgreSQL (chunk metadata + PGVector embedding)          │
│       └──→ Elasticsearch (BM25 keyword index)                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        RETRIEVAL PIPELINE                            │
│                                                                      │
│  User Query                                                          │
│       │                                                              │
│       ├──→ Embedding(query) ──→ PGVector COSINE ──→ Dense topK×5   │
│       │                                                              │
│       ├──→ ES BM25 + Fuzzy ──→ Keyword Match ──→ Sparse topK×5     │
│       │                                                              │
│       └──→ [Parallel, Promise.all]                                   │
│                    │                                                  │
│                    ▼                                                  │
│              RRF Fusion (k=60) ──→ Fused topK×3                     │
│                    │                                                  │
│                    ▼                                                  │
│           Adjacent Chunk Dedup (bigram Jaccard)                      │
│                    │                                                  │
│                    ▼                                                  │
│         HTTP Reranker (optional) ──→ Reranked topK                   │
│                    │                                                  │
│                    ▼                                                  │
│              Enrich Parent Chunks → Final Results                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、摄入管线 (Ingestion Pipeline)

### 2.1 完整状态机

```
PENDING → DOWNLOADING → PARSING → NORMALIZING → (Quality Gate)
    │                                                    │
    │  ┌─────────────────────────────────────────────────┘
    ▼  ▼                    rejected → FAILED
  CHUNKING → EMBEDDING → WRITING_DB → COMPLETED
    │                                      │
    └── (hierarchical) ────────────────────┘
```

### 2.2 阶段详解

#### Phase 0: 文档创建

用户通过 API 或 UI 上传文档/粘贴文本，系统在 PostgreSQL 创建 `KnowledgeDocument` 记录，状态初始为 `pending`。

```
POST /api/knowledge/documents
  → prisma.knowledgeDocument.create({ status: "pending" })
  → BullMQ Job 入队 → Worker 消费
```

#### Phase 1: PARSING（解析）

根据文件类型选择解析器：

| 文件类型 | 解析器 | 说明 |
|---------|--------|------|
| `.txt` / 手动输入 | 直接使用原始文本 | 无解析开销 |
| `.pdf` | PDFParser (pdf-parse) | 提取文本 + 元数据 |
| `.docx` | DocxParser (mammoth) | 提取文本 + 内嵌图片 |
| `.md` | MarkdownParser | 保留 Markdown 结构 |

多模态文档（如 Word 含图片）解析时，额外上传资产到 MinIO 并替换 Markdown 占位符：

```
{{ASSET:img-001}} → ![图片](https://minio/agentforge-docs/doc-xxx/img-001.png)
```

#### Phase 2: NORMALIZING（文本清洗）

`NormalizerService` 对解析后的文本做规则化处理：

```
原始文本 → removeExtraSpaces (重复空白→单个空格)
        → removeUrlsEmails (可选：移除 URL/Email)
        → 统一换行符 → Unicode 规范化
```

#### Phase 3: Quality Gate（质量门禁）

基于文本指标判断是否继续：

```
evaluateQuality(metrics):
  charCount == 0                    → "reject_scan"  (扫描件/图片型PDF)
  textDensity < 0.05 && chars < 100 → "reject_scan"
  textDensity < 0.1                 → "flag_low"     (低质量但继续)
  以上都不满足                       → "proceed"
```

- `reject_scan`: 标记 FAILED，不触发 BullMQ 重试
- `flag_low`: 继续处理但标记 `qualityLabel = "low"`
- `proceed`: 正常继续

#### Phase 4: CHUNKING（分块）

支持两种分块模式：

**标准模式 (paragraph)**:
```
RecursiveTokenTextSplitter
  chunkSize: 800 tokens (可配置)
  overlap: 120 tokens
  分隔符优先级: \n\n → \n → 。→ . → 空格 → 字符
```

**层次模式 (hierarchical)**:
```
Parent Chunk (800 tokens, overlap 120)
  └── Child Chunk 1 (400 tokens, overlap 60)
  └── Child Chunk 2 (400 tokens, overlap 60)
  └── Child Chunk 3 (400 tokens, overlap 60)
```

- Parent chunks: 仅存 PostgreSQL，**不向量化**，用于提供上下文
- Child chunks: 向量化 + 写入 PGVector + ES，`parentChunkId` 关联父块

#### Phase 5: EMBEDDING（向量化）

调用 Embedding Provider 将文本转为稠密向量：

```
chunkTexts[] → embed() → denseVecs[][]
```

支持的 Provider:

| Provider | 模型 | 维度 | 说明 |
|----------|------|------|------|
| Ollama | bge-m3 | 1024 | 本地免费，BAAI 多语言 |
| Ollama | nomic-embed-text | 768 | 英文优化 |
| OpenAI | text-embedding-3-large | 3072 | 最高精度 |
| OpenAI | text-embedding-3-small | 1536 | 性价比 |
| DashScope | text-embedding-v3/v4 | 1024 | 阿里云 |

#### Phase 6: WRITING_DB（双路写入 V3.5）

每个 chunk 写入 **两个存储**（V3.5 已移除 Milvus Knowledge Collection 和 PG inverted_index 写入）：

```
chunk text + vec ───┬──→ PostgreSQL knowledge_chunks (元数据 + embedding vector)
                    └──→ Elasticsearch knowledge_chunks (BM25 倒排索引)
```

**PostgreSQL (knowledge_chunks)**:
```sql
INSERT INTO knowledge_chunks (id, document_id, content, chunk_index, token_count, ...);
UPDATE knowledge_chunks SET embedding = '[0.1, 0.2, ...]'::vector WHERE id = $1;
```

**Elasticsearch (knowledge_chunks index)**:
```json
{
  "chunkId": "uuid",
  "kbId": "kb-xxx",
  "docId": "doc-xxx",
  "title": "退换货政策",
  "content": "自收到商品之日起7天内...",
  "sourceType": "pdf",
  "qualityLabel": "good",
  "createdAt": "2026-06-30T..."
}
```

**PostgreSQL Inverted Index (knowledge_inverted_index)** — 已完全移除:
此表在 V3.5 之前用于 PG 端关键词回退检索。V3.5 已停止写入，后续阶段已清理 Schema 和 `rebuildInvertedIndex()` 方法。

**写入策略（V3.5）**:
- PGVector embedding 写入失败 → 抛出异常，触发 BullMQ 重试
- Elasticsearch 索引失败 → 仅 warn 日志，不阻塞主流程

---

## 三、检索管线 (Retrieval Pipeline)

### 3.1 完整检索流程

```
searchHybrid(query, kbIds, topK=5, useReranker=true)
  │
  ├─ 1. embedSingle(query) → queryVec[]
  │
  ├─ 2. Promise.all([
  │      searchByVector(queryVec, kbIds, topK*5),    // PGVector COSINE
  │      searchByKeyword(query, kbIds, topK*5),       // ES BM25
  │    ])
  │
  ├─ 3. rrfFusion(dense, sparse, topK*3)
  │      → RRF_score(d) = Σ 1/(k + rank_d_in_R)  where k=60
  │      → 按 RRF 分数降序，取 topK*3
  │
  ├─ 4. dedupeAdjacentChunks(fused)
  │      → 同一文档 chunkIndex 相邻 → 保留高分
  │      → bigram Jaccard 重叠 > 0.82 → 保留高分
  │
  ├─ 5a. [if Reranker configured]
  │      POST /rerank { query, documents: topK*3 } → reranked topK
  │      → 用 Reranker 分数替换为最终 score
  │
  ├─ 5b. [if no Reranker]
  │      → 直接用 RRF fusionScore 作为最终 score
  │
  └─ 6. enrichWithParentChunks(results)
         → 批量查询 child chunks 的 parent 信息
         → 附加 parentChunk: { id, content } 到结果
```

### 3.2 Route 1: PGVector 语义召回

```sql
SELECT kc.id, kc.content,
       1 - (kc.embedding <=> '[0.1,0.2,...]'::vector) AS score
FROM knowledge_chunks kc
JOIN knowledge_documents kd ON kc.document_id = kd.id
WHERE kc.embedding IS NOT NULL
  AND kc.enabled = true
  AND kc.knowledge_base_id IN ($kbIds)
ORDER BY kc.embedding <=> $1::vector
LIMIT topK * 5
```

- `<=>` 是 pgvector 余弦距离运算符，值域 `[0, 2]`
- `1 - 距离` 转换为余弦相似度 `[-1, 1]`，越接近 1 越相似
- 召回 `topK × 5` 候选（默认 25 条）

### 3.3 Route 2: Elasticsearch 关键词召回

```json
{
  "query": {
    "bool": {
      "must": [{
        "match": {
          "content": {
            "query": "退换货政策",
            "operator": "or",
            "fuzziness": "AUTO"
          }
        }
      }],
      "filter": [{ "terms": { "kbId": ["kb-xxx"] } }]
    }
  },
  "size": 25
}
```

- BM25 概率检索模型（TF-IDF 的进化版）
- `fuzziness: "AUTO"` 自动拼写纠错
- `operator: "or"` 宽松匹配，最大化召回

### 3.4 RRF 融合算法

**RRF (Reciprocal Rank Fusion)** 无监督融合两路结果：

```
RRF_score(chunk) = Σ 1 / (k + rank_in_list)

k = 60 (平滑常数)
rank = 1-based 排名（从 1 开始）
```

**为什么不用分数直接加和？**

| 问题 | RRF 解决方案 |
|------|-------------|
| PGVector 余弦分数 [0,1] 和 BM25 分数 [0,∞) 量纲不同 | 只看**排名**，量纲无关 |
| 两边分布差异大（一个偏正态，一个偏长尾） | 彻底归一化 |
| 零训练成本 | 纯数学公式 |

**被两路同时命中的 chunk 获得加分**（两路共识信号）。

### 3.5 相邻 Chunk 去重

在 Reranker 之前做两阶段去重（减少无效计算）：

```
1. 邻接去重: same docId + |chunkIndex_a - chunkIndex_b| ≤ window → 保留高分
2. 文本去重: bigram Jaccard(a, b) > threshold → 保留高分
```

使用字符 bigram + Jaccard 相似度（中英文通用，无需 tokenizer）：

```
toBigramSet("退换货政策"):
  → {"退换", "换货", "货政", "政策"}

Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

### 3.6 Reranker 精排

将去重后的 `topK × 3` 候选送入独立 Reranker 模型做 Cross-Encoder 精排：

```
POST {rerankerBaseUrl}/rerank
{
  "model": "bge-reranker-v2-m3",
  "query": "用户原始查询",
  "documents": [
    { "text": "自收到商品之日起7天内...(截断800字)", "id": "chunk-uuid-1" },
    { "text": "物流配送说明...(截断800字)", "id": "chunk-uuid-2" },
    ...
  ],
  "topK": 5
}
```

**为什么 Reranker 放最后？**
- Cross-Encoder 是对每对 (query, document) 做完整 transformer 推理，计算成本高
- 不能对全库做 → 先用 RRF 从数百候选中缩到 15 条（粗排），再精排
- 这是经典的 **粗排→精排 两阶段策略**

**兼容的 Reranker 服务**: Cohere Rerank v2 / BAAI bge-reranker / Jina Reranker API

---

## 四、降级策略

系统在任何组件故障时自动降级，保证核心检索可用：

```
ES 不可用？
  ├─ 是 → searchByKeyword 返回 [] → RRF 仅用 PGVector 单路
  └─ 否 → 双路融合

Reranker 不可用？
  ├─ 是 → 用 RRF fusionScore 作为最终分数
  └─ 否 → Reranker relevance_score 作为最终分数

PGVector 查询失败？
  └─ 返回 []，两路都空 → searchHybrid 返回 []
```

所有降级路径均通过 `logger.warn/debug` 记录，不抛异常阻塞。

---

## 五、数据删除

删除文档时同步清理所有存储：

```
deleteDocument(docId):
  1. 查询所有 chunk IDs
  2. Elasticsearch: DELETE BY QUERY terms: { docId: [...] }
  3. PostgreSQL: DELETE knowledge_chunks WHERE documentId = docId
  4. PostgreSQL: DELETE knowledge_document WHERE id = docId
```

ES 删除失败时仅 warn 日志，不阻塞（后续可通过 rebuild 修复）。

---

## 六、索引重建

### 重建 ES 索引（从 PG 全量）
```
KnowledgeIngestionService.rebuildESIndex(kbId?):
  1. 从 PostgreSQL 读取所有 chunk
  2. 分批 500 条写入 Elasticsearch
```

---

## 七、配置参考

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PGVECTOR_ENABLED` | `true` | 启用 PGVector 语义搜索 |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | ES 集群地址 |
| `RERANKER_BASE_URL` | `""` | Reranker 服务地址（空=禁用） |
| `RERANKER_MODEL` | `""` | Reranker 模型名 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 本地服务 |
| `OLLAMA_EMBEDDING_MODEL` | `bge-m3` | Ollama embedding 模型 |
| `EMBEDDING_MODEL` | `text-embedding-v2` | OpenAI 兼容 embedding 模型 |
| `KB_CHUNK_SIZE_TOKENS` | `800` | 默认分块 token 数 |
| `KB_CHUNK_OVERLAP_TOKENS` | `120` | 默认重叠 token 数 |
| `KB_CHILD_CHUNK_SIZE_TOKENS` | `400` | 子分块 token 数（层次模式） |
| `KB_CHILD_CHUNK_OVERLAP_TOKENS` | `60` | 子分块重叠 token 数（层次模式） |
| `KB_DEDUPE_NEIGHBOR_WINDOW` | `1` | 相邻去重窗口 |
| `KB_DEDUPE_SIMILARITY_THRESHOLD` | `0.82` | 文本重叠去重阈值 |

### 算法常量（代码内）

| 常量 | 值 | 说明 |
|------|---|------|
| `RRF_K` | 60 | RRF 平滑常数 |
| `RECALL_MULTIPLIER` | 5 | 每路召回 topK×5 |
| `FUSED_MULTIPLIER` | 3 | 融合后取 topK×3 |
| Reranker timeout | 5s | HTTP 请求超时 |

---

## 八、存储职责总结

| 存储 | 职责 | 不可用时影响 |
|------|------|-------------|
| **PostgreSQL** | chunk 元数据 + PGVector embedding（语义搜索主引擎） | **致命**，系统不可用 |
| **Elasticsearch** | BM25 关键词倒排索引 | 降级为纯向量搜索，召回率下降 |
| **Reranker** | Cross-Encoder 精排 | 降级为 RRF 融合分数排序，精度略降 |
| **Milvus** | 已从项目中完全移除 | 所有向量存储已迁移到 PGVector |
| **MinIO** | 原始文件存储（PDF/Word 等） | 仅影响文件解析入口，不影响已索引数据的检索 |

---

**相关文件**:
- `apps/server/src/services/knowledge.ts` — 混合检索主服务（RRF 融合 + 搜索协调）
- `apps/server/src/services/knowledge-ingestion.ts` — 文档摄入管线（解析→清洗→分块→多路写入）
- `apps/server/src/services/elasticsearch.ts` — ES 客户端（索引管理 + BM25 搜索）
- `apps/server/src/services/reranker.ts` — HTTP Reranker 客户端
- `apps/server/src/services/embeddings.ts` — Embedding Provider 注册表
- `apps/server/src/services/text-splitter.ts` — 文本分块器（标准 + 层次模式）
- `apps/server/src/config.ts` — 所有配置项定义
