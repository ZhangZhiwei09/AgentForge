# Server Services Layer

`apps/server/src/services/` 是后端业务逻辑层，处在路由层和 Provider 层之间，遵循标准分层架构：

```
路由层 (src/routes/)       → HTTP 关心的事：请求解析、参数校验、SSE 流
服务层 (src/services/)      → 业务逻辑：编排 DB 操作 + LLM 调用 + 向量搜索
Provider 层 (src/providers/) → LLM 抽象：统一不同 AI 厂商的接口
数据库层 (packages/database/) → Prisma ORM + PostgreSQL + Milvus
```

---

## 文件总览

9 个 Service 文件按职责分为三类：

### 一、聊天服务（核心编排层）

| 文件 | 类 | 职责 |
|------|-----|------|
| `chat.ts` | `ChatService` | 主聊天流程：加载历史 → 注入记忆到 system prompt → 流式调用 LLM → 保存消息 → 自动生成对话标题 → 提取新记忆到向量库 |
| `customer-chat.ts` | `CustomerChatService` | 客服聊天变体：搜索知识库 → 中文客服 prompt → 基于 sessionId 管理匿名对话 |

### 二、知识库服务（RAG 管线）

| 文件 | 类 | 职责 |
|------|-----|------|
| `knowledge.ts` | `KnowledgeService` | 混合检索：dense 向量 + BM25 稀疏向量，可选 LLM Rerank 重排序 |
| `knowledge-ingestion.ts` | `KnowledgeIngestionService` | 文档摄取：切分 → embedding → Milvus → PG，支持批量/删除/重建 BM25 索引 |

### 三、基础设施服务（底层工具）

| 文件 | 类 | 职责 |
|------|-----|------|
| `memory-engine.ts` | `MemoryEngine` | 长期记忆：CRUD + 向量搜索 + LLM 从对话中提取用户事实/偏好 |
| `embeddings.ts` | `OpenAIEmbeddingProvider` | Embedding 封装：OpenAI API → 1536 维向量 |
| `milvus.ts` | （函数模块） | Milvus 客户端单例 + Collection 自动创建/索引 |
| `bm25.ts` | `BM25SparseEncoder` | 稀疏向量编码器（当前为 stub，返回空向量） |
| `text-splitter.ts` | `RecursiveCharacterTextSplitter` | 递归文本切分，按分隔符优先级降级，带 overlap |

---

## 典型数据流

以 `POST /api/chat` 为例：

```
路由 chatRoutes
  └→ ChatService.streamChat()
      ├─ 1. 查 PG 获取 conversation + user
      ├─ 2. MemoryEngine.search() → Milvus 向量搜索找相关记忆
      ├─ 3. 注入记忆文本到 system prompt
      ├─ 4. 保存用户消息到 PG
      ├─ 5. 加载历史消息
      ├─ 6. provider.streamChat() → 流式调用 OpenAI / DeepSeek
      ├─ 7. 逐 token yield → SSE → 前端实时渲染
      └─ 8. [done] 保存助手消息 + 自动生成标题 + MemoryEngine.extractAndStore()
```

## 设计要点

- **路由不碰业务逻辑**：routes/ 只做参数校验和 HTTP 响应，具体"怎么做"全在 services/
- **Provider 抽象**：services 不直接调 OpenAI SDK，通过 `LLMProvider` 接口，换模型只改配置
- **双写存储**：记忆和知识库同时写入 PostgreSQL（元数据/全文）和 Milvus（向量搜索）
- **优雅降级**：Milvus 不可用时，MemoryEngine 回退到纯 PG 查询；BM25 stub 不阻塞主流程
- **ChatService vs CustomerChatService**：两个独立实现，不共享基类——客服版多了知识库检索，少了记忆注入
