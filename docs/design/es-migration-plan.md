# ES 迁移方案：PostgreSQL BM25 → Elasticsearch

> 版本: v3.0 Final | 日期: 2026-06-25 | 作者: Architect
> 状态: ✅ 已通过 Architecture Review

## 修订历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-06-25 | 初版设计方案 |
| v2.0 | 2026-06-25 | 修复 Review v1 的 2 P0 + 6 P1：写入顺序、IK 前置、RRF 参数、Zod 校验、安全配置、删除流程、迁移策略 |
| v3.0 | 2026-06-25 | 修复 Review v2 的 1 P0 + 2 P1：Metrics 注册表、doc_id 必填、删除顺序对称化；补充 P2：IK stop words、批处理大小、ES_SEARCH_ENABLED、prod compose |

---

## 1. 背景与动机

### 1.1 当前架构

```
用户查询 → embedding API → Milvus ANN(topK) → [仅对 topK 候选计算 PG BM25] → 手工加权融合 → 可选 LLM Rerank
                                                    ↑
                                           BM25 不是全库检索！
```

**核心问题**：BM25 只在 Milvus dense 召回的 top-K 候选项上计算，精确关键词匹配可能被 Milvus 语义搜索漏掉。

### 1.2 为什么选 Elasticsearch

| 对比维度 | 当前 PG 倒排索引 | Elasticsearch |
|---------|----------------|---------------|
| BM25 检索范围 | 仅 Milvus top-K（非全库） | 全库 BM25 |
| 中文分词 | jieba（应用层） | analysis-ik（Lucene 内核） |
| 高级检索 | 无 | 同义词、模糊匹配、短语查询、高亮 |
| 索引维护 | 手工（应用层一致性保证） | 自动（Lucene 引擎） |
| 运维复杂度 | 低（仅一张 PG 表） | 中（独立服务） |

---

## 2. 架构设计

### 2.1 新搜索流程

```
用户查询 ──┬── embedding API ──→ Milvus ANN (全库 dense, topK×2) ──────┐
           │                                                              │
           └── analysis-ik 分词 ──→ Elasticsearch (全库 BM25, topK×2) ──┤
                                                                          ↓
                                                                RRF 融合 (k=60)
                                                                          ↓
                                                                取 topK 截断
                                                                          ↓
                                                                从 PG 补充元数据
                                                                          ↓
                                                                可选 LLM Rerank
                                                                          ↓
                                                              返回 KnowledgeSearchResult[]
```

**关键改进**：dense 和 sparse 各自独立做全库检索（各取 `topK × 2` 候选），然后通过 RRF (Reciprocal Rank Fusion) 融合。

### 2.2 RRF 融合设计

**公式**：
```
RRF_score(d) = Σ_{r ∈ retrievers} 1 / (k + rank_r(d))
```

**参数**：
- `k = 60`（经典常数，对排名敏感度适中）
- 每侧检索 `topK × 2` 个候选（默认 topK=5 → 每侧 10 个）
- 融合后按 RRF 分数降序，截断到 `topK`

**为什么选 RRF 而不是当前的手工加权求和**：
- RRF 不依赖分数的绝对尺度（COSINE 和 BM25 的分数分布完全不同）
- 对异常高分不敏感
- 业界标准做法（Elasticsearch 8.x 内置、Cohere/Weaviate 默认采用）

### 2.3 ES Index Mapping

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "1s",
    "analysis": {
      "analyzer": {
        "ik_max_word_analyzer": {
          "type": "custom",
          "tokenizer": "ik_max_word",
          "filter": ["stop", "cjk_width", "lowercase"]
        },
        "ik_smart_analyzer": {
          "type": "custom",
          "tokenizer": "ik_smart",
          "filter": ["stop", "cjk_width", "lowercase"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "chunk_id":      { "type": "keyword" },
      "kb_id":         { "type": "keyword" },
      "doc_id":        { "type": "keyword" },
      "doc_title":     { "type": "text", "analyzer": "ik_max_word_analyzer", "search_analyzer": "ik_smart_analyzer" },
      "content":       { "type": "text", "analyzer": "ik_max_word_analyzer", "search_analyzer": "ik_smart_analyzer" },
      "chunk_index":   { "type": "integer" },
      "token_count":   { "type": "integer" },
      "source_type":   { "type": "keyword" },
      "quality_label": { "type": "keyword" },
      "created_at":    { "type": "date" }
    }
  }
}
```

**分词策略**：`analysis-ik` 插件直接安装。
- 索引端：`ik_max_word` — 最细粒度切分，最大化召回（"退换货政策" → `[退换货, 退换, 换货, 政策]`）
- 搜索端：`ik_smart` — 最粗粒度切分，提高精度（"退换货政策" → `[退换货, 政策]`）

这等价于当前 jieba 的分词粒度，确保搜索切换时质量不退化。

**`source_type` / `quality_label` 字段**：保留在 mapping 中，Phase 2 可用于 boosting（如 `quality_label:good` 的文档加权），Phase 1 暂不使用。

**IK Stop Words**：通过 `filter: ["stop"]` 启用 ES 内置中文停用词过滤，与当前 jieba `tokenizer.ts` 中 ~180 个 `STOP_WORDS` 行为对齐。如发现停用词差异影响搜索质量，可通过 IK 自定义词典进一步微调。

**refresh_interval**：dev 环境 `1s`（快速可搜索），prod 环境建议 `5s`（降低写入时 CPU 负载）。

### 2.4 数据一致性策略（P0 修复）

**核心原则：PG 是主数据源，ES 和 Milvus 是二级索引。**

写入顺序（`ingestChunks`）：

```
1. PG knowledgeChunk INSERT  ← 先决条件（主数据源）
2. [ES bulk index, Milvus insert] 并行或串行
3. ES 或 Milvus 任一失败 → 记录 warn + metric counter
   PG 已成功，数据不丢失；后续可通过 rebuild 修复
```

**失败处理矩阵**：

| 场景 | PG | ES | Milvus | 处理 |
|------|:--:|:--:|:------:|------|
| 全部成功 | ✅ | ✅ | ✅ | 正常 |
| PG 失败 | ❌ | - | - | 整体回滚，BullMQ 重试 |
| ES 失败 | ✅ | ❌ | ✅ | warn + `esIndexErrorsTotal`++；数据可从 PG 重建 |
| Milvus 失败 | ✅ | ✅ | ❌ | warn + 已有 `milvusSearchDurationMs` error label |
| ES+Milvus 失败 | ✅ | ❌ | ❌ | warn + 两个 counter++；数据可从 PG 重建 |

**删除流程**（`deleteDocument`）：

```
1. PG document delete (CASCADE → 自动删 chunks + inverted_index)
   失败 → 整体停止，不清理 ES/Milvus
2. Milvus delete by chunk_id     ← 按 chunk_id 过滤删除，不依赖 milvusId 字段
   失败 → warn + metric，不阻塞
3. ES deleteByChunkId            ← 幂等、快速
   失败 → warn + metric，不阻塞
```

删除顺序与写入对称：**PG 先删（主数据源），ES/Milvus 后删（二级索引）**。PG 删除失败则整体回滚；ES/Milvus 删除失败仅记录 warn（PG 已删除是决定性事实）。

**Milvus 删除方式变更**：从当前按内部 Int64 ID 删除改为按 `chunk_id` 字符串过滤删除，与 ES 的 `deleteByChunkId` 模式一致，消除对 `milvusId` 字段的依赖。

**孤儿索引清理**：定期任务（每周）双向检查 —
- 扫描 ES 中 `chunk_id` 不在 PG `knowledgeChunk` 表的文档并清理
- 扫描 Milvus 中 `chunk_id` 不在 PG 的向量并清理

### 2.5 数据迁移策略（P1 修复）

采用 **先双写、后重建、增量补写** 策略，处理迁移期间的并发摄入：

```
Phase A.1: 部署 ES → 创建 Index → 启用 dual-write
           (所有新摄入文档同时写 ES + PG inverted_index)

Phase A.2: 等待双写稳定运行（覆盖最老未处理文档的生命周期，建议 1 天）

Phase A.3: 执行全量迁移
           1. 记录重建开始时间 T_start
           2. 从 PG knowledge_chunks 分批读取（每批 500 条，基于 createdAt 游标分页）
           3. 每批 ES bulk index（避免单次请求过大触发 100MB 限制）
           4. 全量完成后，查询 WHERE created_at > T_start 做增量补写
           5. 验证 ES doc count == PG chunk count
           6. 不一致则重复步骤 4-5（幂等）
```

### 2.6 降级策略

| ES 状态 | 行为 |
|---------|------|
| ES 正常 | dense(Milvus) + sparse(ES) → RRF 融合 |
| ES 搜索失败 | 降级 → 仅 Milvus dense（COSINE 分数直接作为最终分数） |
| ES 服务中断 | 同搜索失败，记录 `searchDegradationTotal` Counter |
| ES 索引为空 | 同搜索失败（dense-only 降级） |

降级时记录 `logger.warn` + `searchDegradationTotal.inc({reason: "es_unavailable"})`。

### 2.7 ES 返回值的类型校验（P1 修复）

遵循 CLAUDE.md"外部数据先校验"原则，对 ES `_source` 做 Type Guard：

```typescript
// elasticsearch.ts
import { z } from "zod";

const ESChunkSchema = z.object({
  chunk_id: z.string(),
  kb_id: z.string(),
  doc_id: z.string(),           // 必填 — PG knowledgeChunk.documentId 非 nullable
  doc_title: z.string().optional(),
  content: z.string(),
  chunk_index: z.number().int().optional(),
  token_count: z.number().int().optional(),
  source_type: z.string().optional(),
  quality_label: z.string().optional(),
});

type ESChunkDocument = z.infer<typeof ESChunkSchema>;

export interface ESSearchResult {
  chunkId: string;
  kbId: string;
  docId: string;                // 必填 — 与 KnowledgeSearchResult 接口一致
  docTitle?: string;
  content: string;
  bm25Score: number;
}

// search() 方法内：
async search(...): Promise<ESSearchResult[]> {
  const response = await this.client.search({...});
  const results: ESSearchResult[] = [];
  for (const hit of response.hits.hits) {
    const parsed = ESChunkSchema.safeParse(hit._source);
    if (!parsed.success) {
      logger.warn({ id: hit._id, error: parsed.error }, "ES hit validation failed");
      continue;  // 跳过格式不正确的文档
    }
    results.push({
      chunkId: parsed.data.chunk_id,
      kbId: parsed.data.kb_id,
      docId: parsed.data.doc_id,
      docTitle: parsed.data.doc_title,
      content: parsed.data.content,
      bm25Score: hit._score ?? 0,
    });
  }
  return results;
}
```

---

## 3. 可观测性设计（P1 修复）

在 `apps/server/src/observability/metrics.ts` 新增：

```typescript
import { registry } from "./metrics.js";  // 项目已有自定义 Registry

// ES 搜索延迟
export const esSearchDurationMs = new Histogram({
  name: "agentforge_es_search_duration_ms",
  help: "ES search latency in milliseconds",
  labelNames: ["operation"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});

// ES 索引错误计数
export const esIndexErrorsTotal = new Counter({
  name: "agentforge_es_index_errors_total",
  help: "Total ES index (write) errors",
  labelNames: ["operation"] as const,
  registers: [registry],
});

// ES 搜索错误计数
export const esSearchErrorsTotal = new Counter({
  name: "agentforge_es_search_errors_total",
  help: "Total ES search errors",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// 搜索降级计数
export const searchDegradationTotal = new Counter({
  name: "agentforge_search_degradation_total",
  help: "Total search degradation events (dense-only fallback)",
  labelNames: ["reason"] as const,
  registers: [registry],
});
```

---

## 4. 安全设计（P1 修复）

### 4.1 Dev 环境

```yaml
elasticsearch:
  environment:
    discovery.type: single-node
    xpack.security.enabled: "false"
```

### 4.2 Prod 环境

```yaml
elasticsearch:
  environment:
    discovery.type: single-node
    xpack.security.enabled: "true"
    ELASTIC_PASSWORD: ${ES_PASSWORD:?err}    # 通过 .env 注入，不硬编码
    ES_JAVA_OPTS: "-Xms1g -Xmx1g"
```

Server 端连接配置：

```typescript
// elasticsearch.ts prod 模式
const client = new Client({
  node: settings.elasticsearchUrl,
  auth: settings.elasticsearchPassword
    ? { username: "elastic", password: settings.elasticsearchPassword }
    : undefined,
  tls: settings.elasticsearchUseTLS
    ? { rejectUnauthorized: true }
    : undefined,
});
```

Prod 角色权限（通过 ES API 在首次启动时创建）：

```json
{
  "agentforge_search_role": {
    "cluster": ["monitor"],
    "indices": [
      {
        "names": ["agentforge_knowledge"],
        "privileges": ["read", "view_index_metadata"]
      }
    ]
  }
}
```

若 ES 与 Server 不在同一主机，必须启用 HTTPS（自签证书 + `ca_certs` 或 Let's Encrypt）。

---

## 5. 容量规划

| 指标 | Dev | Prod |
|------|-----|------|
| ES Heap | 512MB | 1GB |
| 容器内存 Limit | 1GB | 1.5GB |
| 磁盘 | 5GB（Docker volume） | 20GB+（独立 volume） |
| 索引大小估算 | ~2-3x 原始文本 | 同左 |
| 监控 | 无 | 磁盘水位线 ≥85% 报警 |

---

## 6. 实施计划

### 任务列表

| # | 任务 | 优先级 | 依赖 | 预估 |
|---|------|--------|------|------|
| 1 | **ES Infrastructure** — docker-compose 添加 ES + analysis-ik Dockerfile；config.ts 添加 ES 配置（含 prod auth）；.env 新增环境变量 | P0 | 无 | 0.5d |
| 2 | **ES Client Module** — 创建 `elasticsearch.ts`：单例+惰性初始化、ensureIndex(含 IK mapping)、bulkIndexChunks、search(含 Zod 校验)、deleteByChunkId、ping | P0 | Task 1 | 1d |
| 3 | **Prometheus Metrics** — 在 `metrics.ts` 添加 `esSearchDurationMs`、`esSearchErrorsTotal`、`esIndexErrorsTotal`、`searchDegradationTotal` | P1 | Task 1 | 0.25d |
| 4 | **Ingestion Dual-Write** — 修改 `ingestChunks()`（PG 先写 → ES/Milvus 后写，ES/Milvus 失败不阻塞）；修改 `deleteDocument()`（PG 先删 → Milvus/ES 后删，删除方式改为按 chunk_id 过滤）；保留 PG inverted_index 写入 | P0 | Task 2 | 0.5d |
| 5 | **ES Search Integration** — 修改 `knowledge.ts`：新增 `esSearch()`（全库 BM25）+ `reciprocalRankFusion()`（k=60, topK×2）；保留 `computeBM25FromIndex()` 作为 fallback；env var `ES_SEARCH_ENABLED` 控制切换 | P0 | Task 2, 3 | 1d |
| 6 | **Data Migration Script** — 创建 `elasticsearch-migration.ts`：先启用 dual-write → 全量重建 → 增量补写 → 验证 doc count；`rebuildIndex(kbId?)` 方法 | P1 | Task 4 | 0.5d |
| 7 | **Search Fallback & Degradation** — ES 不可用 → dense-only 降级；记录降级 metric + warn 日志 | P1 | Task 5 | 0.25d |
| 8 | **ES Health Check** — `/api/health` 端点增加 ES 健康检查 | P1 | Task 2 | 0.25d |
| 9 | **Update Tests** — 更新 `knowledge.test.ts`：mock ES client、验证 RRF 正确性、验证降级行为、验证 Zod 校验 | P1 | Task 5 | 0.5d |
| 10 | **Orphan Cleanup Job** — 定期任务（每周）：双向扫描 ES + Milvus 中 `chunk_id` 不在 PG 的孤儿数据并清理 | P2 | Task 4 | 0.25d |
| 11 | **Cleanup PG Inverted Index** — Prisma migration 移除 `KnowledgeInvertedIndex` 表；移除 `knowledge-ingestion.ts` 中 PG inverted_index 写入；移除 `knowledge.ts` 中 `computeBM25FromIndex()` | P2 | Task 5-6 验证通过 | 0.5d |

### 阶段划分

```
Phase A (Task 1-4): 基础设施 + 双写
  ├── ES 服务就绪 + analysis-ik
  ├── 新摄入文档双写（ES + PG inverted_index）
  └── 现有数据迁移到 ES

Phase B (Task 5-9): 搜索切换 + 灰度 + 验证
  ├── ES 搜索路径 + RRF 融合
  ├── 环境变量灰度控制
  ├── 对比新旧结果质量
  └── 默认启用 ES → 观察 → 稳定

Phase C (Task 10-11): 清理
  └── 移除 PG 倒排索引表和相关逻辑
```

---

## 7. 涉及文件

| 文件 | 操作 | 影响 |
|------|------|------|
| `infra/docker/docker-compose.yml` | 修改 | 添加 elasticsearch service + volume |
| `infra/docker/docker-compose.prod.yml` | 修改 | 添加 elasticsearch + security |
| `infra/docker/Dockerfile.es` | **新建** | ES + analysis-ik 镜像 |
| `apps/server/src/services/elasticsearch.ts` | **新建** | ES 服务模块（含 Zod 校验） |
| `apps/server/src/services/elasticsearch-migration.ts` | **新建** | 数据迁移脚本 |
| `apps/server/src/services/knowledge.ts` | 修改 | `search()` 增加 ES 路径 + RRF |
| `apps/server/src/services/knowledge-ingestion.ts` | 修改 | `ingestChunks()` / `deleteDocument()` 增加 ES 操作 |
| `apps/server/src/observability/metrics.ts` | 修改 | 新增 ES/Prometheus 指标 |
| `apps/server/src/config.ts` | 修改 | 新增 ES 配置项 |
| `apps/server/.env` | 修改 | 新增环境变量 |
| `apps/server/src/index.ts` | 修改 | ES 初始化 + 健康检查 |
| `apps/server/src/services/__tests__/knowledge.test.ts` | 修改 | 更新测试 |
| `apps/server/package.json` | 修改 | 添加 `@elastic/elasticsearch` 依赖 |
| `packages/database/prisma/schema.prisma` | 修改 (Phase C) | 删除 `KnowledgeInvertedIndex` 模型 |

**不受影响的模块**（消费者接口不变）：
- `search_knowledge_base` tool
- `KnowledgeContextBuilder`
- `CitationVerifier`
- `POST /api/knowledge/search` route
- `MemoryEngine`（独立系统，不使用 BM25）

---

## 8. 风险矩阵

| 风险 | 等级 | 缓解措施 | 残留风险 |
|------|------|----------|----------|
| ES OOM | 中 | Dev 512MB / Prod 1GB heap；容器 memory limit；磁盘水位线监控 | 大量文档摄入可能触发 GC 停顿 |
| 中文分词精度不达标 | 低 | Phase 1 直接使用 analysis-ik，ik_max_word + ik_smart 方案等价于 jieba | IK 词典可能缺少特定领域术语（可通过 IK 自定义词典补充） |
| ES 数据与 PG 不一致 | 低 | PG 先写（原子）；ES 写入失败不阻塞 PG；定期孤儿清理 job | 短期窗口内搜索结果可能缺最新文档 |
| RRF 融合排序质量变化 | 中 | 通过 langfuse 对比新旧结果；k 参数可调 | 用户可能感知排序变化 |
| ES 服务中断 | 低 | dense-only 降级；搜索不完全中断 | 降级期间 BM25 关键词匹配缺失，客服 FAQ 精确匹配场景受影响 |
| Docker 资源不足 | 低 | ES 512MB 可运行；prod 预留 1.5GB | - |
| Migration 期间数据遗漏 | 低 | 先双写 → 全量 → 增量补写 → 验证 | - |

---

## 9. 回滚方案

| 阶段 | 操作 |
|------|------|
| Phase A | `docker-compose stop elasticsearch` → 系统回到纯 PG+Milvus 状态 |
| Phase B | `ES_SEARCH_ENABLED=false` → 回退到 PG BM25（PG 倒排索引仍在） |
| Phase C | Prisma migration down 恢复表结构 + 重新启用 PG BM25 路径 |

---

## 10. 验收标准

1. **基础设施**：`docker-compose up` 后 ES 健康，`/_cluster/health` 返回 green
2. **分词验证**：分析 `agentforge_knowledge` index 对中文文本的分词结果，确认与 jieba 分词结果语义一致
3. **数据同步**：摄入文档后 ES doc count == PG chunk count；删除文档后 ES 对应 doc 同步删除
4. **搜索功能**：`POST /api/knowledge/search` 返回结果结构不变；对客服 FAQ 查询的 top-3 结果与当前方案做对比，相关性不下降
5. **降级行为**：停止 ES 容器后搜索仍可用（dense-only 降级），metric counter `searchDegradationTotal{reason="es_unavailable"}` 增加
6. **API 兼容**：`KnowledgeService.search()` 签名不变，调用方无需修改
7. **迁移脚本**：`rebuildIndex()` 可成功从 PG 重建 ES 索引，重建后 doc count == chunk count
8. **Metrics**：ES 搜索延迟、错误计数可在 Prometheus/Grafana 中观测
9. **测试**：`pnpm test` 全部通过

---

## 11. 配置参考

### 新增环境变量

```bash
# apps/server/.env

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=agentforge_knowledge

# ES 搜索灰度开关（默认关闭，验证后手动开启）
ES_SEARCH_ENABLED=false

# Prod only:
# ELASTICSEARCH_PASSWORD=xxx
# ELASTICSEARCH_USE_TLS=false
```

**`ES_SEARCH_ENABLED` 行为边界**：仅控制 `KnowledgeService.search()` 内部是否走 ES sparse 路径。不影响双写（ingestion 始终双写 ES + PG inverted_index 到 Phase C），也不影响 `rebuildIndex()` 运维操作。

### Docker Compose 新增

**Dev 环境** (`infra/docker/docker-compose.yml`)：

```yaml
elasticsearch:
  build:
    context: ../../
    dockerfile: infra/docker/Dockerfile.es
  environment:
    discovery.type: single-node
    xpack.security.enabled: "false"
    ES_JAVA_OPTS: "-Xms512m -Xmx512m"
  ports:
    - "9200:9200"
  volumes:
    - es_data:/usr/share/elasticsearch/data
  healthcheck:
    test: ["CMD-SHELL", "curl -f http://localhost:9200/_cluster/health || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 10
    start_period: 60s
  deploy:
    resources:
      limits:
        memory: 1G

  server:
    # ...已有配置...
    environment:
      # 已有变量...
      ELASTICSEARCH_URL: http://elasticsearch:9200
    depends_on:
      - elasticsearch  # 新增
```

**Prod 环境** (`infra/docker/docker-compose.prod.yml`)：

```yaml
elasticsearch:
  build:
    context: ../../
    dockerfile: infra/docker/Dockerfile.es
  environment:
    discovery.type: single-node
    xpack.security.enabled: "true"
    ELASTIC_PASSWORD: ${ES_PASSWORD:?err}
    ES_JAVA_OPTS: "-Xms1g -Xmx1g"
  ports:
    - "127.0.0.1:9200:9200"  # 仅监听 localhost，不暴露公网
  volumes:
    - es_data:/usr/share/elasticsearch/data
  restart: unless-stopped
  healthcheck:
    test: ["CMD-SHELL", "curl -f -u elastic:${ES_PASSWORD} http://localhost:9200/_cluster/health || exit 1"]
    interval: 15s
    timeout: 5s
    retries: 10
    start_period: 60s
  deploy:
    resources:
      limits:
        memory: 1536M
        cpus: "1.0"
      reservations:
        memory: 1024M
```

### Dockerfile.es

```dockerfile
FROM docker.elastic.co/elasticsearch/elasticsearch:8.17.0
RUN elasticsearch-plugin install --batch https://get.infini.cloud/elasticsearch/analysis-ik/8.17.0
```

---

## 12. 架构自检

- [x] 充分理解现有系统（已查阅 CLAUDE.md、所有相关源文件、docker-compose、Prisma schema）
- [x] 方案复用已有能力（Milvus 不变、embedding pipeline 不变、BullMQ ingestion 不变、PG 事务不变）
- [x] 数据一致性以 PG 为主数据源（PG 先写，ES/Milvus 后写）
- [x] 中文分词直接使用 analysis-ik（ik_max_word + ik_smart），质量不低于当前 jieba
- [x] 外部数据先校验（ES 返回值 Zod safeParse）
- [x] 禁止静默吞错（ES 失败记录 warn 日志 + metric counter）
- [x] 降级策略完备（ES 不可用 → dense-only，搜索不中断）
- [x] 零停机迁移（先双写 → 全量 → 增量 → 验证）
- [x] 可观测性（ES 延迟/错误/降级 metrics）
- [x] 回滚方案明确（每阶段可独立回滚）
- [x] 消费者接口兼容（KnowledgeService.search() 签名不变）
- [x] 无多余抽象（ES Service 与 Milvus Service 平行设计）
