# AgentForge 后端 TypeScript → Python 迁移方案

> **状态**: 方案设计阶段，代码迁移尚未开始
> **原则**: 保留现有代码不变，渐进式迁移，新 Python 后端独立目录运行

---

## 一、Python 技术栈选型

### 1.1 核心技术栈对照

| 层级 | 当前 TS 技术栈 | Python 替换方案 | 选型理由 |
|---|---|---|---|
| **运行时** | Node.js 20+, ESM | Python 3.12+, asyncio | Python 3.12 asyncio 性能大幅提升 |
| **Web 框架** | Hono 4 | **FastAPI** | 异步原生、Pydantic v2 深度集成、自动 OpenAPI、SSE 支持 |
| **ASGI 服务器** | @hono/node-server | **Uvicorn** (dev) / **Gunicorn + Uvicorn workers** (prod) | 业界标准组合 |
| **ORM** | Prisma 6 | **SQLAlchemy 2.0** (ORM) + **Alembic** (迁移) | Python 生态 ORM 标准，2.0 的 async session 与 FastAPI 配合完美 |
| **PGVector** | Prisma pgvector | **pgvector-python** + SQLAlchemy 扩展 | 官方 pgvector Python SDK |
| **验证/序列化** | Zod | **Pydantic v2** | FastAPI 原生集成，性能远超 v1 |
| **LLM SDK** | openai (Node) | **openai** (Python) | 同一厂商，API 一致 |
| **LLM 可观测** | Langfuse + OpenTelemetry JS | **langfuse** + **opentelemetry-api/sdk** (Python) | 相同体系 |
| **作业队列** | BullMQ (Redis) | **ARQ** (首选) 或 Celery | ARQ 异步原生、轻量、Redis 驱动，映射 BullMQ 模式最自然 |
| **Redis 客户端** | ioredis | **redis-py** (async) | 标准库 |
| **向量搜索** | Elasticsearch | **elasticsearch-py** (async) | 同一生态 |
| **对象存储** | minio (Node SDK) | **minio** (Python SDK) | 同一厂商 |
| **中文分词** | @node-rs/jieba | **jieba** | Python 原生，更成熟 |
| **文档解析** | mammoth, unpdf | **python-docx** / **mammoth**, **pymupdf** | Python 生态更丰富 |
| **认证** | bcryptjs | **passlib[bcrypt]** + **python-jose** (JWT) | 标准组合 |
| **配置管理** | dotenv + 手写 settings | **pydantic-settings** | 类型安全的环境变量管理 |
| **测试** | Vitest | **pytest** + **pytest-asyncio** + **httpx** | Python 测试标准 |
| **类型检查** | tsc --noEmit | **mypy** (strict) 或 **pyright** | 与 TS 严格类型习惯一致 |
| **包管理** | pnpm + Turborepo | **uv** (包管理 + 项目管理) 或 **Poetry** | uv 速度最快，Rust 实现 |
| **代码格式化** | Prettier | **ruff** (format + lint) | Rust 实现，极快 |
| **进程管理** | tsx watch | **uvicorn --reload** (dev) / **gunicorn** (prod) | 标准工具链 |
| **流式输出** | SSE (手写) | **sse-starlette** 或 FastAPI StreamingResponse | FastAPI 原生支持 |

### 1.2 补充依赖

```toml
# pyproject.toml 核心依赖清单

[project]
name = "agentforge-server"
version = "0.0.1"
requires-python = ">=3.12"

[project.dependencies]
# Web
fastapi = ">=0.115"
uvicorn = { extras = ["standard"], version = ">=0.34" }
sse-starlette = ">=2.0"

# Database
sqlalchemy = { extras = ["asyncio"], version = ">=2.0" }
asyncpg = ">=0.30"          # PostgreSQL async driver
alembic = ">=1.14"
pgvector = ">=0.3"          # pgvector for SQLAlchemy

# Validation & Config
pydantic = ">=2.10"
pydantic-settings = ">=2.7"

# Redis & Queue
redis = { extras = ["hiredis"], version = ">=5.2" }
arq = ">=0.26"

# LLM
openai = ">=1.70"
langfuse = ">=2.60"

# Observability
opentelemetry-api = ">=1.30"
opentelemetry-sdk = ">=1.30"
opentelemetry-instrumentation-fastapi = ">=0.51"
opentelemetry-exporter-otlp = ">=1.30"
prometheus-client = ">=0.21"

# Search
elasticsearch = { extras = ["async"], version = ">=8.17" }

# Storage
minio = ">=7.2"

# Auth
passlib = { extras = ["bcrypt"], version = ">=1.7" }
python-jose = { extras = ["cryptography"], version = ">=3.3" }

# Document Parsing
jieba = ">=0.42"
pymupdf = ">=1.25"          # PDF
python-docx = ">=1.1"       # Word
Pillow = ">=11.0"           # Images
openai-whisper = ">=20240930"  # Audio transcription

# Utilities
httpx = ">=0.28"            # Async HTTP client
python-multipart = ">=0.0.18"  # File upload support

[project.optional-dependencies]
dev = [
    "pytest >= 8.3",
    "pytest-asyncio >= 0.25",
    "pytest-cov >= 6.0",
    "httpx >= 0.28",          # TestClient
    "ruff >= 0.9",
    "mypy >= 1.14",
    "pre-commit >= 4.0",
]
```

---

## 二、新项目目录结构

```
apps/server-py/                    # 新 Python 后端，独立于现有 apps/server/
├── pyproject.toml                 # uv/Poetry 项目定义
├── alembic.ini                    # Alembic 配置
├── alembic/                       # 数据库迁移脚本
│   ├── env.py
│   └── versions/
├── src/
│   ├── __init__.py
│   ├── main.py                    # FastAPI 应用入口（对应 index.ts）
│   ├── worker.py                  # ARQ Worker 入口（对应 worker.ts）
│   ├── config.py                  # pydantic-settings 配置（对应 config.ts）
│   ├── db.py                      # SQLAlchemy engine + session（对应 db.ts）
│   │
│   ├── models/                    # SQLAlchemy ORM 模型（对应 Prisma schema）
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── conversation.py
│   │   ├── knowledge.py
│   │   ├── workflow.py
│   │   ├── agent_team.py
│   │   └── app_project.py
│   │
│   ├── schemas/                   # Pydantic 请求/响应模型（对应 shared-types）
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── agent.py
│   │   ├── workflow.py
│   │   ├── tool.py
│   │   └── ...
│   │
│   ├── middleware/                # 中间件（对应 middleware/）
│   │   ├── __init__.py
│   │   ├── auth.py
│   │   ├── cors.py
│   │   ├── error_handler.py
│   │   ├── metrics.py
│   │   ├── rate_limit.py
│   │   ├── request_id.py
│   │   └── content_safety.py
│   │
│   ├── routes/                    # API 路由（对应 routes/）
│   │   ├── __init__.py
│   │   ├── health.py
│   │   ├── auth.py
│   │   ├── agent.py
│   │   ├── agent_runtime.py
│   │   ├── tools.py
│   │   ├── workflows.py
│   │   ├── teams.py
│   │   └── diagnosis.py
│   │
│   ├── providers/                 # LLM Provider 抽象层（对应 providers/）
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── openai_provider.py
│   │   ├── deepseek_provider.py
│   │   └── registry.py
│   │
│   ├── services/                  # 业务逻辑层（对应 services/）
│   │   ├── __init__.py
│   │   ├── auth_service.py
│   │   ├── agent_runtime/         # Agent Runtime 核心
│   │   │   ├── __init__.py
│   │   │   ├── agent_executor.py  # ReAct 引擎
│   │   │   ├── router.py          # 4-route 分类器
│   │   │   ├── routing/           # 多层路由管线
│   │   │   │   ├── __init__.py
│   │   │   │   ├── l1_keyword.py
│   │   │   │   ├── l2_semantic.py
│   │   │   │   ├── l3_llm_router.py
│   │   │   │   ├── l5_fallback.py
│   │   │   │   └── pipeline.py
│   │   │   ├── safety_agent.py
│   │   │   ├── chat_agent.py
│   │   │   ├── task_intent.py
│   │   │   ├── human_agent.py
│   │   │   ├── knowledge_context.py
│   │   │   ├── citation_verifier.py
│   │   │   ├── validation.py
│   │   │   ├── react_json_utils.py
│   │   │   └── errors.py          # 错误码定义
│   │   ├── knowledge_service.py
│   │   ├── knowledge_ingestion.py
│   │   ├── knowledge_regression.py
│   │   ├── embeddings.py
│   │   ├── reranker.py
│   │   ├── memory_service.py
│   │   ├── memory_compressor.py
│   │   ├── text_splitter.py
│   │   ├── tokenizer.py
│   │   ├── document_parser/       # 文档解析
│   │   ├── document_normalizer/
│   │   ├── agent_service.py
│   │   ├── agent_guard.py
│   │   ├── diagnosis/             # LangGraph 诊断引擎
│   │   │   ├── __init__.py
│   │   │   ├── graph.py
│   │   │   ├── nodes.py
│   │   │   ├── state.py
│   │   │   └── tools/
│   │   ├── codegen/               # 代码生成
│   │   ├── storage/               # 文件存储抽象
│   │   ├── elasticsearch.py
│   │   ├── degradation_chain.py
│   │   ├── error_classifier.py
│   │   └── retry_executor.py
│   │
│   ├── tools/                     # Agent 工具系统（对应 tools/）
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── registry.py
│   │   ├── builtins/
│   │   │   ├── search_knowledge.py
│   │   │   └── ...
│   │   ├── business/
│   │   │   ├── create_ticket.py
│   │   │   └── diagnosis_tools.py
│   │   ├── file_tools.py
│   │   ├── database_tools.py
│   │   └── network_tools.py
│   │
│   ├── workflows/                 # 工作流引擎（对应 workflows/）
│   │   ├── __init__.py
│   │   ├── schema.py
│   │   ├── dag_executor.py
│   │   ├── step_runner.py
│   │   ├── handlers/
│   │   │   ├── __init__.py
│   │   │   ├── agent_step.py
│   │   │   ├── tool_step.py
│   │   │   ├── condition_step.py
│   │   │   ├── parallel_step.py
│   │   │   ├── human_approval_step.py
│   │   │   └── transform_step.py
│   │   ├── checkpoint.py
│   │   ├── variable_resolver.py
│   │   └── service.py
│   │
│   ├── teams/                     # 多 Agent 协作（对应 teams/）
│   │   ├── __init__.py
│   │   ├── blackboard.py
│   │   ├── message_bus.py
│   │   ├── executor.py
│   │   └── modes/
│   │       ├── __init__.py
│   │       └── diagnosis.py
│   │
│   ├── runtime/                   # 运行时抽象（对应 runtime/）
│   │   ├── __init__.py
│   │   ├── context.py
│   │   ├── controller.py
│   │   ├── buffer.py
│   │   └── scope.py
│   │
│   ├── observability/             # 可观测性（对应 observability/）
│   │   ├── __init__.py
│   │   ├── tracing.py
│   │   ├── metrics.py
│   │   └── langfuse_provider.py
│   │
│   ├── jobs/                      # 后台作业（对应 jobs/）
│   │   ├── __init__.py
│   │   ├── queues.py
│   │   └── processors.py
│   │
│   ├── lib/                       # 工具库（对应 lib/）
│   │   ├── __init__.py
│   │   ├── circuit_breaker.py
│   │   ├── context_window.py
│   │   ├── conversation_guard.py
│   │   └── json_utils.py
│   │
│   └── prompts/                   # 提示词（对应 shared-prompts）
│       ├── __init__.py
│       ├── registry.py
│       ├── persona.py
│       └── system_prompts.py
│
└── tests/                         # 测试（遵循 pytest 约定）
    ├── __init__.py
    ├── conftest.py                # Fixtures: DB session, TestClient, etc.
    ├── test_auth.py
    ├── test_agent_executor.py
    ├── test_routing_pipeline.py
    └── ...
```

---

## 三、关键架构映射

### 3.1 类型安全策略

| TS 模式 | Python 等效 |
|---|---|
| `zod` schema → type inference | `pydantic` model → type hints |
| `Prisma.TableName` (类型推导) | SQLAlchemy model + Pydantic schema |
| `Discriminated Union` | `typing.Literal` + Union types |
| `satisfies` operator | mypy `assert_type()` |
| `tsc --noEmit` | `mypy --strict` |

### 3.2 异步模型映射

```python
# TS: async/await + EventEmitter
# Python: async/await + asyncio

# FastAPI 依赖注入 → TS middleware 模式
async def get_current_user(
    token: str = Depends(oauth2_scheme)
) -> User:
    ...

# SSE 流式输出
from sse_starlette.sse import EventSourceResponse

async def stream_chat(request: ChatRequest):
    async def event_generator():
        async for chunk in agent_executor.run(request.message):
            yield {"data": chunk.model_dump_json()}
    return EventSourceResponse(event_generator())
```

### 3.3 数据库迁移——从 Prisma 到 SQLAlchemy + Alembic

**迁移方式**：直接从现有 PostgreSQL 数据库生成 Alembic 基线迁移，不手写 SQL。

```bash
# 1. 从现有数据库自动生成 Alembic 模型
alembic init alembic

# 2. 使用 sqlacodegen 从数据库反向生成 SQLAlchemy 模型
pip install sqlacodegen
sqlacodegen postgresql://user:pass@localhost:5434/agentforge --outfile src/models/autogen.py

# 3. 手工整理 autogen.py → 分模块的 models/*.py

# 4. 生成初始迁移（标记为基线，不重新执行）
alembic stamp head
```

### 3.4 关键模式迁移

| TS 模式 | Python 模式 |
|---|---|
| `export const prisma = new PrismaClient()` | `engine = create_async_engine(); session = async_sessionmaker()` |
| `@hono/zod-validator` | FastAPI `Depends()` + Pydantic |
| `app.use("*", middleware)` | `app.add_middleware()` 或 `app.middleware("http")` |
| `app.route("/", router)` | `app.include_router(router)` |
| `Hono Context Variables` | FastAPI `Request.state` |
| `BullMQ Worker` | ARQ Worker |
| `AsyncGenerator<Event>` | `AsyncGenerator[Event, None]` |

---

## 四、从 0 到 1 的迁移步骤

### Phase 0：项目初始化（不写业务代码）

| 序号 | 任务 | 说明 | 产出 |
|---|---|---|---|
| 0.1 | 创建 `apps/server-py/` 目录 | `mkdir -p apps/server-py/src` | 空目录 |
| 0.2 | 初始化 `pyproject.toml` | `uv init` 或手写，列出全部依赖 | 项目骨架 |
| 0.3 | 配置 Ruff + mypy | `.ruff.toml` + `mypy.ini`，开启 strict mode | 类型检查就绪 |
| 0.4 | 初始化 Alembic | `alembic init`，配置 `env.py` 指向 async engine | 迁移就绪 |
| 0.5 | 从现有 DB 生成 SQLAlchemy 模型 | `sqlacodegen` 自动生成 → 手工分模块整理 | `models/` 就绪 |
| 0.6 | 创建 `docker-compose.python.yml` | 独立编排新后端 + 共享 infra（PG/Redis/ES） | 可启动 |

**验收标准**：`uv run uvicorn src.main:app` 可以启动空 FastAPI 应用，`/api/health` 返回 200。

### Phase 1：基础设施层（Config + DB + Middleware）

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 1.1 | `config.py` — pydantic-settings 迁移 | 0.2 | 将所有 `process.env.X` 迁移为 `Settings` 类 |
| 1.2 | `db.py` — SQLAlchemy engine + session factory | 0.5 | async engine → async_sessionmaker |
| 1.3 | `middleware/` 迁移 | 1.2 | cors, error_handler, request_id, metrics, rate_limit |
| 1.4 | `middleware/auth.py` 迁移 | 1.2 | JWT 验证 + FastAPI `Depends(get_current_user)` |
| 1.5 | `observability/` 迁移 | 1.1 | OpenTelemetry + Langfuse + Prometheus |

**验收标准**：`curl` 或手动调用验证中间件行为正确（auth 拒绝无效 token、rate-limit 返回 429 等），可观测性数据可送达 OTLP 端点。

### Phase 2：Provider 层 + Agent Runtime 核心

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 2.1 | `providers/` — LLM Provider 抽象 | 1.1 | BaseProvider → OpenAIProvider + DeepSeekProvider |
| 2.2 | `tools/` — Tool 系统 | 1.2 | Tool base, Registry, builtins |
| 2.3 | `runtime/` — 运行时抽象 | — | RunContext, Controller, Buffer, Scope |
| 2.4 | `services/agent_runtime/errors.py` | — | 统一错误码定义 |
| 2.5 | `services/agent_runtime/router.py` + routing/ | 2.1 | 4-route 分类器 + 多层管线 |
| 2.6 | `services/agent_runtime/agent_executor.py` | 2.2, 2.3, 2.5 | **核心** ReAct 执行引擎 |
| 2.7 | `services/agent_runtime/safety_agent.py` | 2.6 | 安全 Agent |
| 2.8 | `services/agent_runtime/chat_agent.py` | 2.6 | 聊天 Agent |
| 2.9 | `services/agent_runtime/task_intent.py` | 2.6 | 任务 Agent + 意图识别 |
| 2.10 | `services/agent_runtime/human_agent.py` | 2.6 | 人工协同 Agent |

**验收标准**：通过脚本/REPL 调用 `AgentExecutor.invoke()` 可正常走通 ReAct 循环（观察→分析→规划→决策），Router 对 4 种路由各送几条典型消息验证分类正确。

### Phase 3：API 路由层（对外接口）

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 3.1 | `routes/health.py` | 1.2 | 健康检查 |
| 3.2 | `routes/auth.py` | 1.4 | /api/auth/* |
| 3.3 | `routes/agent_runtime.py` | 2.6 | /api/agent/chat (SSE 流式) |
| 3.4 | `routes/agent.py` | 2.6 | /api/agent/* |
| 3.5 | `routes/tools.py` | 2.2 | /api/tools |
| 3.6 | `routes/diagnosis.py` | 2.6 | /api/diagnosis/query |
| 3.7 | `main.py` — 组装 FastAPI app | 全部 | 注册所有路由和中间件 |

**验收标准**：所有 API 端点可通过 `curl`/Postman 正常访问，SSE 流式输出在浏览器终端可见逐 chunk 推送。

### Phase 4：业务服务层

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 4.1 | `services/knowledge_service.py` | 1.2, 2.6 | 知识库 CRUD |
| 4.2 | `services/knowledge_ingestion.py` | 4.1 | 知识摄入管线 |
| 4.3 | `services/embeddings.py` | 2.1 | Embedding 生成 |
| 4.4 | `services/text_splitter.py` | — | Token-aware 分片 |
| 4.5 | `services/document_parser/` | — | 文档解析器链 |
| 4.6 | `services/document_normalizer/` | — | 文档标准化 |
| 4.7 | `services/memory_service.py` | 1.2 | 短期记忆 |
| 4.8 | `services/memory_compressor.py` | 2.1 | 记忆摘要压缩 |
| 4.9 | `services/knowledge_regression.py` | 4.1 | 回归测试 |
| 4.10 | `services/reranker.py` | 2.1 | Reranker 服务 |

### Phase 5：高级能力

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 5.1 | `workflows/` — 工作流引擎 | 2.6, 3.4 | DAG executor + 全部 step handlers |
| 5.2 | `teams/` — 多 Agent 协作 | 2.6, 5.1 | Blackboard + message bus |
| 5.3 | `services/diagnosis/` — LangGraph 诊断 | 2.6 | 状态图诊断引擎 |
| 5.4 | `services/storage/` — 文件存储 | — | MinIO + local storage |
| 5.5 | `services/codegen/` — 代码生成 | 2.6 | LLM 驱动代码生成 |

### Phase 6：作业队列 + Worker 进程

| 序号 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 6.1 | `jobs/queues.py` — ARQ 队列定义 | 1.2 | 知识摄入队列 |
| 6.2 | `jobs/processors.py` — 作业处理器 | 4.1, 4.3, 4.4 | 异步知识文档处理 |
| 6.3 | `worker.py` — ARQ Worker 入口 | 6.1, 6.2 | 独立 worker 进程 |

### Phase 7：全量测试 + 前端对接

> **所有测试工作集中在最后阶段，编码阶段（Phase 0-6）只做手工验证。**

| 序号 | 任务 | 覆盖范围 | 说明 |
|---|---|---|---|
| 7.1 | 基础设施测试 | `config.py`, `db.py`, 所有 middleware, observability | pytest + httpx，测试 auth/cors/rate-limit/error-handler 每条中间件独立行为和中间件链组合行为 |
| 7.2 | Provider 层测试 | `providers/` — OpenAI, DeepSeek, Registry | mock LLM 响应，测试 provider 切换、降级、超时重试 |
| 7.3 | Tool 系统测试 | `tools/` — Registry, builtins, business, file/db/network tools | 测试 tool 注册/查询/执行，circuit breaker 启停，参数校验拒绝无效 args |
| 7.4 | Runtime 抽象测试 | `runtime/` — Context, Controller, Buffer, Scope | 测试 RunContext 不可变、子上下文继承、状态机转换、Buffer 批量写入 |
| 7.5 | Agent Runtime 核心测试 | Router + routing pipeline + AgentExecutor + 4 个 Agent | 测试 L1-L5 每层路由正确性、ReAct JSON 解析容错、4 个 Agent 独立行为和边界条件 |
| 7.6 | API 路由层测试 | 全部 `routes/` — auth, agent-runtime, agent, tools, workflows, teams, diagnosis | pytest + httpx AsyncClient，测试每个端点正常响应、错误处理、SSE 流式逐 chunk 验证 |
| 7.7 | 业务服务层测试 | Knowledge, Embedding, Memory, Document Parser/Normalizer, Reranker, Regression | 测试知识摄入管线、分片/去重、向量搜索、记忆滑动窗口、摘要压缩 |
| 7.8 | 高级能力测试 | Workflows, Teams, Diagnosis, Storage, Codegen | 测试 DAG 执行、checkpoint/恢复、多 Agent 协作、Blackboard 状态共享 |
| 7.9 | 作业队列测试 | ARQ queues + processors + worker | 测试知识文档入队→处理→状态更新全链路 |
| 7.10 | 前端代理配置切换 | — | 将前端 `VITE_API_BASE` 指向 Python 后端 port 8002 |
| 7.11 | 端到端回归测试 | — | 跑通核心用户流程：注册→登录→发起对话→Agent ReAct 思考→工具调用→流式回复→满意度评分 |
| 7.12 | 性能对比测试 | — | 同场景下 Python 版 vs TS 版延迟（P50/P95/P99）和吞吐量基准对比 |

**目标覆盖率**：核心路径（Agent Runtime、Router、Knowledge Pipeline）> 80%，路由层 > 70%，其他 > 60%。

---

## 五、迁移难点与风险

### 5.1 高风险项

| 风险 | 说明 | 缓解措施 |
|---|---|---|
| **Prisma → SQLAlchemy 模型转换** | Prisma schema 含 Unsupported(pgvector)、Json、枚举等 | 使用 sqlacodegen 自动生成基线，手工验证 Relation 映射 |
| **SSE 流式输出行为差异** | Hono SSE vs FastAPI StreamingResponse 缓冲区行为不同 | 编写 SSE 契约测试，逐 chunk 对比 |
| **ReAct JSON 解析** | TS `JSON.parse` 容错 vs Python `json.loads` 严格 | 复用 react_json_utils 的容错正则逻辑 |
| **LangGraph 诊断引擎** | TS 手工实现 vs Python 可直接用 LangGraph 库 | 评估是否直接用 langgraph Python 包替代手工状态图 |
| **并发模型差异** | Node.js 单线程 event loop vs Python asyncio (GIL) | 必要时用 `run_in_executor` 处理 CPU 密集 |

### 5.2 中等风险项

| 风险 | 说明 |
|---|---|
| BullMQ → ARQ 功能差异 | ARQ 无 BullMQ 的 rate limiter、backoff 策略部分功能需自建 |
| JWT 库行为差异 | TS `jsonwebtoken` vs Python `python-jose` 签名算法默认值 |
| 中文分词精度 | jieba (Python) vs @node-rs/jieba (Rust) 分词语料可能有差异 |
| Alembic 迁移历史 | 需要从现有 DB schema 生成基线迁移，确保新旧后端共用同一 DB schema |

---

## 六、共存策略

迁移期间 TS 和 Python 后端需要共存：

```
                    ┌──────────────────┐
                    │   Nginx / LB     │
                    │   port 8000      │
                    └──────┬───────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
     TS Backend     Python Backend   Frontend
     :8001 (旧)     :8002 (新)     :5173
              │            │
              └────────────┼────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
          PostgreSQL   Redis   Elasticsearch
         (共用同一套基础设施)
```

- **前端配置**：`VITE_API_BASE` 环境变量控制指向哪个后端
- **逐步切换**：先切 `/api/health`，验证链路通达，再逐个路由切换
- **回滚**：改一个环境变量即可 100% 回滚

---

## 七、工时估算

| Phase | 内容 | 估算人天 |
|---|---|---|
| Phase 0 | 项目初始化 + 模型生成 | 2-3 天 |
| Phase 1 | Config + DB + Middleware | 4-6 天 |
| Phase 2 | Provider + Agent Runtime 核心 | 8-12 天 |
| Phase 3 | API 路由层 | 4-6 天 |
| Phase 4 | 业务服务层 | 8-12 天 |
| Phase 5 | 高级能力（Workflow + Teams + Diagnosis） | 8-12 天 |
| Phase 6 | 作业队列 + Worker | 2-4 天 |
| Phase 7 | 全量测试（12 项）+ 前端对接 | 12-18 天 |
| **总计** | | **48-73 人天** |

---

## 八、前置确认清单

在开始写任何 Python 代码前，请确认以下决策：

1. **包管理工具**：`uv` vs `Poetry`？（推荐 uv）
2. **作业队列**：`ARQ` vs `Celery`？（推荐 ARQ，轻量且映射 BullMQ 最自然）
3. **LangGraph 诊断**：直接用 `langgraph` Python 包还是手工迁移状态图？
4. **WebSocket**：当前有 WebSocket 端点吗？Python 用 FastAPI WebSocket 还是独立 socket.io？
5. **SDK 包重写**：`packages/sdk` 需要提供 Python 版本吗？（pip installable package）
6. **shared-prompts**：prompt 模板是继续放在 `packages/shared-prompts` 还是移到 Python 项目内部？
7. **数据库迁移是否锁定**：在迁移期间是否允许修改 Prisma schema？如允许，需要同步更新 SQLAlchemy 模型。
