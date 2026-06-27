# AgentForge 混合检索、知识图谱、多模态解析与分层记忆方案

## Summary

在现有 AgentForge monorepo 上升级知识库与记忆系统：知识库向量检索从 Milvus 迁移到 PGVector，关键词检索接入 Elasticsearch，使用 RRF 融合多路召回结果，再用 Reranker 模型重排；新增 Neo4j 知识图谱检索链路；扩展文档解析为统一 Markdown 管线并接入 MinIO；短期记忆使用 Redis，长期记忆接入 Mem0，最终统一注入 Agent Prompt 上下文。

默认选择：知识库向量库替换为 PGVector，Milvus 不再作为知识库主链路；记忆模块可在后续独立评估是否继续使用 Milvus 或完全迁移到 Mem0。

## Key Changes

### 检索架构

- PostgreSQL 启用 `vector` 扩展，在 `knowledge_chunks` 增加 embedding 向量字段或新建 `knowledge_chunk_embeddings` 表。
- Elasticsearch 新增 `knowledge_chunks` 索引，字段包含 `chunkId`、`kbId`、`docId`、`title`、`content`、`sourceType`、`qualityLabel`、metadata。
- `KnowledgeService` 改为三段式：PGVector 语义召回、Elasticsearch BM25 关键词召回、RRF 融合。
- RRF 默认参数 `k=60`，每路召回默认 `topK * 5`，融合后取 `topK * 3` 进入 rerank。
- Reranker 默认走独立模型接口，优先支持配置化 HTTP reranker；无 reranker 时回退到融合分数排序，不再默认用生成式 LLM 做重排。

### 知识图谱

- Docker compose 增加 Neo4j 服务与配置项：`NEO4J_URI`、`NEO4J_USER`、`NEO4J_PASSWORD`。
- 新增 `GraphExtractionService`：文档入库后用 LLM 从 chunk/section 抽取实体、关系、证据片段，写入 Neo4j。
- 图谱节点最小模型：`Entity {name,type,kbId,docIds,aliases}`；关系：`(:Entity)-[:REL {type,confidence,sourceChunkId,docId}]->(:Entity)`。
- 查询时新增 `GraphRetrievalService`：LLM 从用户问题抽取实体与意图，Neo4j 执行 1-3 跳检索，返回推理链路、相关实体、证据 chunkId。
- `AgentRuntime` Prompt 上下文融合三类内容：RAG chunks、graph reasoning chains、memory context，并保留来源标识，便于引用和调试。

### 多模态文档解析

- 扩展当前 `document-parser` registry，统一输出 `ParsedMarkdownDocument`：`markdown`、`assets`、`pages/segments`、`metadata`。
- PDF、Word、TXT 解析为 Markdown；图片提取后上传 MinIO，并将 Markdown 中图片替换为公开或签名 URL。
- 图片文件走 OCR parser；音频走 ASR parser；视频走“分片抽帧 + 音频 ASR + 视频理解模型摘要”parser，最终也输出 Markdown。
- MinIO 替换当前 local storage 为默认对象存储，实现 `save/read/delete/getPublicUrl`。
- 文档处理状态继续沿用当前状态机，新增 `extracting_assets`、`graph_extracting` 可观测阶段。

### 记忆系统

- Redis 实现短期记忆：按 `conversationId/sessionId` 存滑动窗口消息，超过阈值后生成摘要，TTL 默认 7 天。
- Mem0 实现长期记忆：用户级、会话级两层 namespace；写入来源包括对话抽取、用户显式偏好、任务结果摘要。
- 现有 `MemoryEngine` 改为 facade：`ShortTermMemoryStore` + `LongTermMemoryStore`，Agent 只依赖统一接口。
- Prompt 注入顺序：系统指令 -> 短期摘要和最近窗口 -> 长期相关记忆 -> 图谱链路 -> RAG 证据。

## Public Interfaces

### 新增环境变量

- `ELASTICSEARCH_URL`
- `PGVECTOR_ENABLED=true`
- `RERANKER_BASE_URL`
- `RERANKER_MODEL`
- `NEO4J_URI`
- `NEO4J_USER`
- `NEO4J_PASSWORD`
- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- `MEM0_API_KEY` 或 `MEM0_BASE_URL`

### 新增或调整服务接口

- `KnowledgeService.searchHybrid(query, kbIds, topK)` 返回融合分、召回来源、rerank 分数。
- `GraphRetrievalService.retrieve(query, kbIds)` 返回实体、关系链、证据 chunk。
- `DocumentParser.parse(buffer, meta)` 返回 Markdown 和资产列表。
- `MemoryService.buildContext(userId, conversationId, query)` 返回短期摘要、窗口消息、长期记忆。

## Test Plan

### 单元测试

- RRF 融合排序：验证 dense、BM25、graph evidence 多路结果去重与稳定排序。
- Reranker fallback：reranker 不可用时仍返回融合结果。
- Parser registry：PDF、Word、TXT、图片、音频、视频选择正确 parser。
- Redis 短期记忆：滑动窗口截断、摘要生成、TTL 行为。
- Mem0 长期记忆：用户级和会话级隔离。

### 集成测试

- 文档上传后写入 PostgreSQL/PGVector、Elasticsearch、MinIO、Neo4j。
- 删除文档时清理 PG chunk、ES 索引、MinIO 资产引用、Neo4j 证据关系。
- 用户问题同时命中 RAG 和图谱时，Prompt 上下文包含证据与推理链路。
- Elasticsearch、Neo4j、reranker 任一不可用时可降级，不阻塞基础问答。

### 验收场景

- 精确关键词问题能由 Elasticsearch 召回。
- 语义改写问题能由 PGVector 召回。
- 多实体复杂业务问题能返回图谱链路和文档证据。
- 扫描 PDF、图片、音频、视频均可转成 Markdown 入库。
- 同一用户跨会话能召回长期偏好，同一会话能保留短期上下文。

## Assumptions

- 知识库向量检索目标为 PGVector，Milvus 仅作为旧数据迁移来源或后续清理对象。
- Elasticsearch 使用官方 Elasticsearch，不替换为 OpenSearch。
- MinIO URL 由后端生成，默认使用服务端可配置的公开 URL 或短期签名 URL。
- Mem0 作为长期记忆主实现；现有 `memories` 表保留为审计、回退或迁移缓冲。
- 第一阶段优先实现后端能力和 ingestion/search 链路，管理后台 UI 只做必要状态展示，不做复杂图谱可视化。
