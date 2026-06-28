# RAG Token 分片与相邻 Chunk 去重改造方案

## 背景

当前知识库 RAG 系统已支持文本型 PDF 的上传、解析、分片、向量化和混合检索，但现有分片与检索策略存在四类问题：

- 分片按 `string.length` 计算字符数，无法稳定控制 embedding token 成本和模型输入上限。
- overlap 从上一个 chunk 末尾截取固定长度字符，容易从半句话中间截断，降低语义完整性。
- chunk size 和 overlap 写死在代码中，不能按知识库或文档类型调整。
- 检索 top_k 可能返回多个相邻、高重合 chunk，浪费后续 LLM 上下文窗口。

目标是将分片升级为 token-aware，并在检索链路中做相邻 chunk 去重，同时保持现有上传、worker、PGVector、Elasticsearch、RRF 和可选 reranker 链路兼容。

## Summary

将知识库分片从“字符数驱动”改为“embedding token 数驱动”，把 overlap 改为语义边界保留，并把分片参数从硬编码迁移为可配置参数。同时在混合检索链路中增加相邻 chunk 去重，减少 top_k 返回的重复上下文。

默认策略：

- `chunkSizeTokens = 800`
- `chunkOverlapTokens = 120`
- `dedupeNeighborWindow = 1`
- `dedupeSimilarityThreshold = 0.82`
- 旧知识库不自动重分片，只有新上传或重新处理文档使用新策略。

## Key Changes

### Token-aware 分片器

替换或扩展 `apps/server/src/services/text-splitter.ts`：

- 新增 `RecursiveTokenTextSplitter`，按 token 计数判断 chunk 大小。
- 新增独立 `embedding-tokenizer` 工具，专门用于 embedding token 计数，不复用当前 `tokenizer.ts` 的 jieba/BM25 token。
- 分片仍按段落、标题、列表项、句子、空格、字符逐级降级，但合并和强制切分都以 token 数为准。
- overlap 从“上一 chunk 尾部固定字符”改为“上一 chunk 末尾若干完整语义单元”，优先取完整句子、列表项或段落。
- 只有单个语义单元超过 overlap 上限时，才按 token 做兜底截断。

### Ingestion 链路

修改 `KnowledgeIngestionService`：

- 构造 splitter 时读取配置，不再写死 `500, 50`。
- `ingestDocument`、`processExistingDocument`、seed 数据摄取统一使用同一套分片配置。
- `KnowledgeChunk.tokenCount` 存储 embedding token 数。
- BM25 分词仍只用于倒排索引，继续使用当前 `tokenizer.ts`。

### 配置与 API

增加可配置参数：

- 环境变量：
  - `KB_CHUNK_SIZE_TOKENS`
  - `KB_CHUNK_OVERLAP_TOKENS`
  - `KB_DEDUPE_NEIGHBOR_WINDOW`
  - `KB_DEDUPE_SIMILARITY_THRESHOLD`
- Prisma `KnowledgeBase` 增加 nullable 字段：
  - `chunkSizeTokens`
  - `chunkOverlapTokens`
- 创建和更新知识库 API 支持传入分片参数；未传则使用环境默认值。
- 管理端创建知识库时可选填写 chunk size 和 overlap，建议放在高级设置中，避免影响普通用户。

### 检索相邻去重

修改 `KnowledgeService.searchHybrid()`：

- 在 RRF 融合后、reranker 前执行相邻 chunk 去重。
- 同一 `docId` 且 `chunkIndex` 距离不超过 `dedupeNeighborWindow` 的候选，只保留分数更高者。
- 若两段文本的 token/Jaccard overlap 超过 `dedupeSimilarityThreshold`，也只保留分数更高者。
- 为避免去重后结果不足，RRF 阶段继续保留 `topK * 3` 候选，去重后再送 reranker 或截取 `topK`。
- 对外返回结构保持兼容，不新增引用溯源字段。

## Public Interfaces

### `POST /api/knowledge/bases`

新增可选字段：

- `chunk_size_tokens?: number`
- `chunk_overlap_tokens?: number`

校验规则：

- `chunk_size_tokens` 建议范围：`200..2000`
- `chunk_overlap_tokens >= 0`
- `chunk_overlap_tokens < chunk_size_tokens * 0.5`

### `PUT /api/knowledge/bases/:id`

支持更新：

- `chunk_size_tokens`
- `chunk_overlap_tokens`

更新只影响后续新文档或重新处理的文档，不隐式重建已有向量。

### KnowledgeBase 响应

新增字段：

- `chunk_size_tokens`
- `chunk_overlap_tokens`

## Test Plan

### 单元测试

- 中文、英文、中英混排文本按 token 上限切分，所有 chunk token 数不超过 `chunkSizeTokens`。
- overlap 不从半句话中间开始，优先保留完整句子、列表项或段落。
- 超长无标点文本能降级强制切分，且不会死循环。
- `chunkOverlapTokens >= chunkSizeTokens` 抛出校验错误。
- 相邻 chunk 去重保留高分结果，非相邻 chunk 不被误删。

### 服务测试

- `KnowledgeIngestionService` 使用环境默认参数。
- 知识库级参数覆盖环境默认参数。
- 检索 `topK = 5` 时，即使候选中有相邻重复 chunk，最终结果尽量返回 5 条非重复结果。

### 回归验证

- 文本上传、PDF 上传、worker 摄取、PGVector 写入、ES 索引、管理端搜索均保持可用。
- 旧数据不迁移、不重分片、不破坏已有检索。

## Assumptions

- 当前系统不需要引用溯源，因此不新增 page、offset 等引用字段。
- 现有 `tokenizer.ts` 继续服务 BM25 和倒排索引；embedding token 计数新增独立模块。
- 已有知识库保持原 chunk 数据，后续如需统一质量，可单独做“重建知识库索引/重新分片”功能。
