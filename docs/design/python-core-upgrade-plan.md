# AgentForge Python V1 核心能力升级方案

## Context

Python 后端 (`apps/server-py`) 核心链路已打通（路由 → ReAct → SSE），但三个关键能力缺失：

1. 手写 ReAct 循环难以扩展，无法利用 LangGraph 生态的 checkpointing / human-in-the-loop
2. 知识库只有 ILIKE 关键词搜索，无语义检索
3. 可观测性只有 Noop 空实现，无法追踪 LLM 调用链路

此方案按 **Phase A → B → C** 顺序递进实施，每阶段保持向后兼容。

---

## Phase A: LangGraph ReAct（基础）

### 核心思路

不引入 `langchain-openai` 依赖。写一个薄的 `ProviderChatModel(LangChain BaseChatModel)` 适配器，包装现有的 `LLMProvider`（OpenAI / DeepSeek 等）。这样 LangGraph 的 `ToolNode`、`astream_events()` 等基础设施可以直接复用，同时保留现有 Provider 层的所有能力。

### Graph 结构

```
START → agent_node → (有 tool_calls?) → tools_node → agent_node
                       → (无 tool_calls?) → END
```

- **agent_node**: 调 LLM（带 tool 定义），收集 token + tool_calls
- **tools_node**: 用 LangGraph 内置 `ToolNode`，调用自定义 tool executor（委托给现有 `ToolRegistry`）
- **条件边**: `should_continue` → 有 tool_calls 且迭代 < 5 → tools，否则 → END

### 流式策略

使用 `graph.astream_events(initial_state, version="v2")`：

- `on_chat_model_stream` → yield `StreamToken`
- `on_chat_model_end` → 检查 tool_calls
- `on_tool_end` → 日志记录

### 文件变更

| 操作     | 文件                                | 说明                                                                     |
| -------- | ----------------------------------- | ------------------------------------------------------------------------ |
| CREATE   | `src/agent/state.py`                | `AgentState(TypedDict)` — messages, iteration_count                      |
| CREATE   | `src/agent/langchain_adapter.py`    | `ProviderChatModel(BaseChatModel)` — 包装现有 LLMProvider，实现 `_agenerate` / `_astream` |
| MODIFY   | `src/agent/executor.py`             | 用 `StateGraph` + `astream_events()` 替换手写 while 循环，**保持 `execute() -> AsyncIterator[RouteStreamEvent]` 签名不变** |
| MODIFY   | `src/agent/__init__.py`             | 按需重导出                                                                |
| MODIFY   | `pyproject.toml`                    | 添加 `langgraph>=0.4`, `langchain-core>=0.3`                               |

### 不变项（关键约束）

- `chat.py` 的 `_to_sse()` 和路由分发逻辑 **不修改**
- `types.py` 的 `RouteStreamEvent` 类型和 `RouteAgent` Protocol **不修改**
- `StreamMeta → StreamToken* → StreamDone` 事件序列 **不变**
- 现有 `tests/test_agent.py` **必须通过**

### 添加依赖

```toml
"langgraph>=0.4.0",
"langchain-core>=0.3.0",
```

注意：**不加** `langchain-openai`——用自定义 `ProviderChatModel` 包装现有 Provider。

---

## Phase B: RAG 知识库（语义搜索）

### 核心思路

实现已有的 `KnowledgeService` Protocol，用 pgvector 做语义搜索。V1 只做纯向量检索（无 Elasticsearch、无 RRF 融合、无 HTTP Reranker），但保留双路扩展点。

### 数据流

```
文档文本 → RecursiveTokenTextSplitter → Chunks → OpenAI Embedding → pgvector 写入

用户查询 → Embedding → pgvector <=> 余弦相似度 → KnowledgeSearchResult[]
```

### 文件变更

| 操作     | 文件                                              | 说明                                        |
| -------- | ------------------------------------------------- | ------------------------------------------- |
| CREATE   | `src/rag/embeddings.py`                           | `EmbeddingProvider` Protocol + `OpenAIEmbeddingProvider` |
| CREATE   | `src/rag/splitter.py`                             | `RecursiveTokenTextSplitter` — CJK 启发式 token 估算 |
| CREATE   | `src/rag/ingestion.py`                            | `ingest_document(kb_id, title, content)` — split → embed → store |
| CREATE   | `src/rag/pgvector.py`                             | `PgVectorKnowledgeService` 实现 `KnowledgeService` Protocol |
| CREATE   | `src/models/knowledge.py`                         | `KnowledgeDocument` + `KnowledgeChunk` SQLAlchemy 模型 |
| CREATE   | `alembic/versions/<hash>_knowledge_base.py`       | 建表 + pgvector 扩展 + HNSW 索引           |
| CREATE   | `src/api/v1/knowledge.py`                         | `POST /api/knowledge/ingest`                |
| MODIFY   | `src/agent/tools/builtins/search_knowledge.py`    | 删除 raw asyncpg 直连，改用 `PgVectorKnowledgeService` |
| MODIFY   | `src/rag/__init__.py`                             | 导出 RAG 组件 + `get_knowledge_service()` 工厂 |
| MODIFY   | `src/config.py`                                   | 添加 embedding / pgvector 配置项             |
| MODIFY   | `src/main.py`                                     | 注册 knowledge router                        |
| MODIFY   | `alembic/env.py`                                  | 导入 knowledge 模型                           |
| MODIFY   | `src/models/__init__.py`                          | 导出 knowledge 模型                           |
| MODIFY   | `pyproject.toml`                                  | 添加 `pgvector>=0.3`                         |

### Config 新增

```python
embedding_model: str = "text-embedding-3-small"
embedding_base_url: str = "https://api.openai.com/v1"
embedding_api_key: str = ""       # 空则 fallback 到 openai_api_key
chunk_size_tokens: int = 512
chunk_overlap_tokens: int = 64
pgvector_enabled: bool = False
```

### DB Migration 关键 SQL

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kb_id VARCHAR(255) NOT NULL,
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'completed',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    kb_id VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    token_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
```

---

## Phase C: Langfuse 可观测性

### 核心思路

实现已有 `ObservabilityProvider` Protocol 的 `LangfuseProvider`。所有 Langfuse 调用 try/catch 保护，绝不 crash 主流程。

### 埋点位置（V1 最小集，共 4 处）

| 位置                          | Generation 名称       | 触发时机               |
| ----------------------------- | --------------------- | ---------------------- |
| `AgentExecutor.execute()`     | `agent-reAct-{N}`     | 每次 ReAct 迭代的 LLM 调用 |
| `ToolRegistry.execute()`      | `tool-{name}`         | 每次工具执行             |
| `chat.py _handle_chat()`      | Trace: `chat-request` | 每次用户请求             |
| `DiagnosisMode._run_agent()`  | `diag-{agent_name}`   | 诊断 Agent 的 LLM 调用   |

### 文件变更

| 操作     | 文件                                        | 说明                                      |
| -------- | ------------------------------------------- | ----------------------------------------- |
| CREATE   | `src/observability/langfuse_provider.py`    | `LangfuseProvider` + `LangfuseTrace` + `LangfuseGeneration` |
| MODIFY   | `src/observability/__init__.py`             | 生命周期函数：init / get / shutdown          |
| MODIFY   | `src/api/v1/chat.py`                        | 创建/结束 Trace，传给 AgentExecutor          |
| MODIFY   | `src/agent/executor.py`                     | `execute()` 接受 `trace` 参数，每次 LLM 调用创建 Generation |
| MODIFY   | `src/agent/tools/registry.py`               | `execute()` 接受 `trace` 参数，每次工具执行创建 Generation |
| MODIFY   | `src/agent/diagnosis/mode.py`               | `_run_agent()` 中将 trace 传给 AgentExecutor |
| MODIFY   | `src/main.py`                               | startup / shutdown 中初始化和关闭 observability |
| MODIFY   | `src/config.py`                             | 添加 langfuse 配置项                       |
| MODIFY   | `pyproject.toml`                            | 添加 `langfuse>=3.0`                       |

### Config 新增

```python
langfuse_enabled: bool = False
langfuse_public_key: str = ""
langfuse_secret_key: str = ""
langfuse_base_url: str = "https://cloud.langfuse.com"
```

### 安全模式

- `langfuse_enabled=false` → 使用现有 `NoopObservabilityProvider`（默认行为不变）
- Langfuse SDK 抛异常 → catch 后静默忽略，主流程不受影响
- Langfuse SDK 未安装 → `init_observability()` 中 try/except ImportError，降级到 Noop
- shutdown 时 `client.flush()` 确保数据不丢失

---

## 完整依赖变更

```toml
# Phase A
"langgraph>=0.4.0",
"langchain-core>=0.3.0",

# Phase B
"pgvector>=0.3.0",

# Phase C
"langfuse>=3.0.0",
```

注意：
- **不加** `langchain-openai`（用自定义适配器包装现有 Provider）
- **不加** `elasticsearch`（V1 不做 ES 混合搜索）
- **不加** `redis`（V1 不做限流/缓存）

---

## 测试策略

### Phase A

| 测试文件                             | 验证内容                                    |
| ------------------------------------ | ------------------------------------------- |
| `tests/test_langchain_adapter.py`    | `ProviderChatModel._agenerate()` / `_astream()` 正确委托 |
| `tests/test_agent_langgraph.py`      | StateGraph 编译、tool_call 循环、max_iterations 截断 |
| `tests/test_agent.py`（现有）         | 必须通过（Router + ToolRegistry 测试不变）    |

### Phase B

| 测试文件                       | 验证内容                                |
| ------------------------------ | --------------------------------------- |
| `tests/test_rag_splitter.py`   | CJK / 英文混合 token 估算、分隔符优先级    |
| `tests/test_rag_embeddings.py` | Mock OpenAI API，验证请求格式             |
| `tests/test_rag_pgvector.py`   | 搜索和摄入（`skipif` 无 pgvector 时跳过）  |
| `tests/test_rag_ingestion.py`  | 端到端 split → embed → store → search     |

### Phase C

| 测试文件                            | 验证内容                                |
| ----------------------------------- | --------------------------------------- |
| `tests/test_observability.py`       | Mock Langfuse SDK，验证 try/catch 不传播异常 |
| `tests/test_observability_wiring.py` | 集成测试，验证埋点触发                    |

---

## 验证清单

### Phase A

```bash
uv run uvicorn src.main:app --port 8000
curl -X POST localhost:8000/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"什么是活体检测？"}'
# 验证: token 逐字到达（非缓冲）、tool_call 仍工作

uv run pytest tests/test_agent.py -v
# 验证: 现有测试全部通过
```

### Phase B

```bash
uv run alembic upgrade head
psql -p 5434 -d agentforge_py -c "\dt knowledge_*"
psql -p 5434 -d agentforge_py -c \
  "SELECT * FROM pg_extension WHERE extname='vector'"

curl -X POST localhost:8000/api/knowledge/ingest \
  -H "Content-Type: application/json" \
  -d '{"kb_id":"default","title":"活体检测FAQ","content":"活体检测是指通过..."}'

curl -X POST localhost:8000/api/agent/chat \
  -d '{"message":"刷脸失败是什么原因？"}'
# 验证: 返回语义相关结果，非纯关键词匹配
```

### Phase C

```bash
# LANGFUSE_ENABLED=true + 有效 key
curl -X POST localhost:8000/api/agent/chat -d '{"message":"你好"}'
# 验证: Langfuse Dashboard 中出现 trace "chat-request" 含 generation

# LANGFUSE_ENABLED=false
curl -X POST localhost:8000/api/agent/chat -d '{"message":"你好"}'
# 验证: 请求正常、无报错
```

---

## 风险与缓解

| 风险                                   | 缓解                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| LangGraph API 不稳定                    | 固定 `langgraph>=0.4,<1.0`                              |
| ProviderChatModel 适配器复杂度          | 只需实现 `_agenerate` 和 `_astream`，预计 < 200 行       |
| pgvector 维度与模型不匹配               | V1 固定 1536d（text-embedding-3-small），换模型需新 migration |
| Langfuse SDK 导入失败                   | lazy import + try/except ImportError → Noop             |
| 现有测试被破坏                          | Phase A 不修改 types.py / chat.py，只改 executor 内部实现  |

---

## 下阶段工作清单（V1 明确不做，V2+ 依次推进）

以下每一项均有明确的"为什么 V1 不做"和"什么时候做"，避免后续遗忘。

---

### RAG 知识库增强（Phase B 之后）

| # | 工作项 | V1 为什么不做 | 优先级 | 触发条件 |
|---|--------|--------------|--------|---------|
| R1 | **RRF 混合搜索（向量 + 关键词）** | V1 只做纯向量检索，关键词检索仍走 ILIKE fallback；RRF 需要双路召回 + 融合排序，增加约 300 行复杂度 | P1 | Phase B 上线后、用户反馈向量搜索召回不足时启动 |
| R2 | **HTTP Reranker（Cross-Encoder）** | 需要额外部署 Reranker 服务或调用 Cohere/Jina API，V1 阶段先靠 pgvector cosine 距离排序 | P2 | 向量搜索 Top-K 结果不够精准时启动 |
| R3 | **Elasticsearch 关键词倒排索引** | ES 部署运维成本高，V1 优先验证 pgvector 纯向量路径 | P3 | 需要支持 BM25 全文搜索或混合搜索规模化时启动 |
| R4 | **层次化分块（Parent-Child Chunk）** | V1 用平铺 chunk + overlap，不做 parent chunk 摘要和两阶段检索 | P2 | chunk 上下文丢失导致答案质量下降时启动 |
| R5 | **文档解析器（PDF / DOCX / Markdown / HTML）** | V1 只接受纯文本 `content` 字段，不做文件上传和格式解析 | P2 | 需要从文件导入知识库时启动 |
| R6 | **多知识库隔离 + 权限控制** | V1 所有 ingest 和 search 都指定 `kb_id`，但不做 kb 级别的 CRUD 管理和 RBAC | P2 | 知识库数量 > 3 且需要租户隔离时启动 |
| R7 | **Embedding 模型可切换（BGE / Jina / Cohere）** | V1 固定 `text-embedding-3-small`(1536d)，换模型需改 config + migration | P2 | 需要中文 embedding 优化或多模型评测时启动 |

---

### Langfuse 可观测性增强（Phase C 之后）

| # | 工作项 | V1 为什么不做 | 优先级 | 触发条件 |
|---|--------|--------------|--------|---------|
| O1 | **Span 级别埋点（Generation → Span 细粒度）** | V1 只有 Trace + Generation 两级；Span 用于记录 ReAct 循环内每一步（thinking / tool_selection / tool_execution） | P1 | Phase C 上线后、需要分析 Agent 每一步耗时分布时启动 |
| O2 | **Token 用量自动统计（prompt_tokens / completion_tokens）** | V1 的 Generation 只记录起止时间，不记录 token 量；token 数据在 `StreamDone.usage` 中已有但未写入 Langfuse | P1 | 需要成本分析和模型用量监控时启动 |
| O3 | **用户反馈关联（Thumbs up/down → Langfuse Score）** | V1 没有前端反馈收集端点和 Score API | P2 | 前端埋好反馈按钮后启动 |
| O4 | **Prompt 版本管理（Langfuse Prompt Management）** | V1 所有 system prompt 硬编码在 Python 源码中；Langfuse Prompt Management 支持 A/B 测试和在线更新 | P3 | 需要 prompt 迭代和 A/B 测试时启动 |
| O5 | **Dataset + Evaluation 管线** | V1 不做自动化评测；需要积累标注数据后才能建 eval pipeline | P3 | 积累 100+ 标注样本后启动 |

---

### LangGraph ReAct 增强（Phase A 之后）

| # | 工作项 | V1 为什么不做 | 优先级 | 触发条件 |
|---|--------|--------------|--------|---------|
| G1 | **Checkpointing（对话状态持久化）** | V1 的 StateGraph 不启用 checkpointer；每次请求都是无状态的一次性执行 | P1 | Phase A 上线后、需要断点续传或多轮对话记忆时启动 |
| G2 | **Human-in-the-Loop（工具调用前审批）** | V1 的 `tools_node` 无条件执行工具调用；HITL 需要 `interrupt()` + 前端审批 UI | P2 | 涉及资金操作或不可逆操作的工具上线时启动 |
| G3 | **并行工具调用（Parallel Tool Calling）** | V1 的 `tools_node` 顺序执行多个 tool_call；当某次 LLM 响应返回多个独立 tool_call 时可并行执行 | P2 | 工具调用耗时成为瓶颈时启动 |
| G4 | **动态 System Prompt（基于 RouteContext）** | V1 的 agent_node 用固定 system prompt；路由信息（intent/route）未注入到 prompt | P2 | 需要根据路由上下文调整 Agent 行为时启动 |
| G5 | **多 Agent 编排（Supervisor / Swarm）** | V1 的 DIAGNOSIS 路由使用自研 `DiagnosisMode` 而非 LangGraph 多 Agent；LangGraph 的 `create_react_agent` + subgraphs 是更标准的方案 | P3 | 诊断 Agent 架构重构时启动 |

---

### 通用平台能力（未分配 Phase）

| # | 工作项 | 当前状态 | 优先级 | 触发条件 |
|---|--------|---------|--------|---------|
| P1 | **会话持久化（Chat History + Conversation CRUD）** | `chat.py` 的 `/chat/history`、`/chat/conversations` 等端点全部返回空数组 | P1 | 需要真实的多轮对话和会话管理时启动 |
| P2 | **Redis 接入（Session Store + Rate Limiter + Cache）** | `config.py` 有 `redis_url` 但无任何 Redis 使用代码；TS 侧有完整的 Redis session store | P1 | 需要多实例部署或限流保护时启动 |
| — | ~~WebSocket 视频对话~~ | ~~不需要，已从路线图移除~~ | — | — |
| P4 | **MCP（Model Context Protocol）集成** | TS 侧的 `ToolRegistry` 支持 MCP tool discovery；Python 侧无 MCP 相关代码 | P2 | 需要接入外部 MCP Server 提供的工具时启动 |
| P5 | **用户 Memory / 上下文记忆（Mem0 / 自建）** | TS 侧有 `injected_memories` 机制；Python 侧的 `RouteContext.injected_memories` 一直为空列表 | P2 | 需要个性化长期记忆时启动 |
| P6 | **多 Provider 扩展（Anthropic / Gemini / 本地模型）** | V1 只有 OpenAI-compatible provider；LangChain 适配器完成后可自然扩展 | P3 | 需要用到非 OpenAI 模型时启动 |
| P7 | **流式 Transport 优化（WebSocket → SSE fallback）** | V1 只有 SSE；WebSocket 双向通信更适合诊断等长时间交互场景 | P3 | SSE 无法满足实时性需求时启动 |
| P8 | **Evaluation / Benchmark 框架** | 无自动化评测；每次改动靠手工 curl 验证 | P2 | Phase A+B+C 完成后、需要回归测试保障时启动 |

---

### 已知技术债（Code Quality）

| # | 工作项 | 说明 | 优先级 |
|---|--------|------|--------|
| T1 | `DiagnosisMode` 重构为 LangGraph Subgraph | 目前是手写的 Multi-Agent 编排（~920 行 mode.py），LangGraph 迁移完成后可改为 `StateGraph` subgraph | P2 |
| T2 | `search_knowledge.py` 删除 raw asyncpg | Phase B 会解决这个问题——改为调用 `PgVectorKnowledgeService` | P1（Phase B 自动解决） |
| T3 | `chat.py` 模块级单例改为依赖注入 | 当前 `_get_router()` / `_get_executor()` / `_get_diagnosis_agent()` 用全局变量做惰性初始化；应用增长后应用 FastAPI `Depends` 管理生命周期 | P2 |
| T4 | Mock 工具替换为真实监控 API 调用 | `diagnosis/tools.py` 的三个工具（`query_trace_log` / `query_merchant_metrics` / `query_error_code_distribution`）返回 mock 数据 | P1 |
| T5 | SSE `_to_sse()` 中 `isinstance` 链扩展性 | 每加一个事件类型就要加一个 `elif` 分支；可改为 event class 自带 `to_sse()` 方法或注册表模式 | P3 |

---

### 推进节奏建议

```
V1 (当前方案):  Phase A → B → C
V1.1 (补漏):   T4(真实监控工具) + P1(会话持久化) + P2(Redis)
V2 (RAG 增强): R1(RRF) + O2(Token统计) + G1(Checkpointing)
V3 (评测):     P8(Eval框架) + R2(Reranker) + O1(Span埋点)
```

非紧急项（R3~R7, O3~O5, G3~G5, P4~P8, T1/T3/T5）根据实际需求择机启动。
