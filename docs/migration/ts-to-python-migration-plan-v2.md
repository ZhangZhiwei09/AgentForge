# AgentForge TypeScript → Python 技术栈迁移方案 V2

> **原则**: 不机械翻译，结合 Python 生态重新设计。保留架构思想，提升工程质量。
> **目标**: 掌握 Python 后端全栈工程能力，产出可面试展示的生产级 AI Agent 平台。

---

## 一、完整迁移架构设计

### 1.1 架构分层总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Layer (FastAPI)                          │
│  /api/auth  /api/chat  /api/agent  /api/workflows  /api/teams   │
├─────────────────────────────────────────────────────────────────┤
│                   Middleware Stack                               │
│  Auth(JWT) → RateLimit(Redis) → ContentSafety → ErrorHandler    │
├─────────────────────────────────────────────────────────────────┤
│                    Agent Framework                               │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌─────────────┐   │
│  │ Router   │  │ Executor   │  │ Tools    │  │ Workflow    │   │
│  │ L1-L5    │  │ ReAct Loop │  │ Registry │  │ DAG Engine  │   │
│  └──────────┘  └────────────┘  └──────────┘  └─────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    Core Runtime (最高优先级)                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │Execution │  │RunContext│  │ExecutionTree│  │StateMachine │  │
│  │Node      │  │(frozen)  │  │(ancestry)  │  │+ Cancellation│  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐                    │
│  │EventBus  │  │Retry     │  │Timeout     │                    │
│  │(pub/sub) │  │(tenacity)│  │(asyncio)   │                    │
│  └──────────┘  └──────────┘  └────────────┘                    │
├─────────────────────────────────────────────────────────────────┤
│                    Data Layer                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │PostgreSQL│  │Redis     │  │Elastic-  │  │Neo4j         │   │
│  │+pgvector │  │(cache/Q) │  │search    │  │(Knowledge    │   │
│  │          │  │          │  │(search)  │  │ Graph)       │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    Infrastructure                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │OpenTele- │  │Langfuse  │  │Prometheus│  │ARQ Worker    │   │
│  │metry     │  │          │  │          │  │              │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计决策

| 决策点 | 选择 | 为什么不选另一个 |
|---|---|---|
| Web 框架 | **FastAPI** | Flask 异步支持是后来嫁接的，SSE Streaming 需要同步 generator 模拟；FastAPI 原生 `AsyncGenerator` + `StreamingResponse`，与项目核心路径完全匹配 |
| ORM | **SQLAlchemy 2.0** | Prisma Python 客户端存在但非官方，且不支持 pgvector；Django ORM 需要 Django 全家桶；SQLAlchemy 2.0 Typed ORM + async session 是最接近 Prisma 质量的选择 |
| 作业队列 | **ARQ** | Celery 太重（需要额外 broker），且 async 支持是 add-on；ARQ 直接复用 Redis + asyncio，与 BullMQ 的 Redis 驱动模式一致 |
| 包管理 | **uv** | Poetry 成熟但慢（Python 实现）；uv 是 Rust 实现，解析速度 10-100x，且与 pip 生态完全兼容 |
| 类型检查 | **mypy** (渐进 strict) | pyright 更快但 VS Code 绑定；mypy 生态更广，CI 集成更成熟。策略：核心模块 strict，其他逐步加 |
| 格式/Lint | **ruff** | 一个工具替代 flake8 + isort + black，Rust 实现，执行时间毫秒级 |

### 1.3 Python 原生化设计原则

**不要做的事**：
```python
# ❌ 机械翻译 TS class
class AgentExecutor:
    def __init__(self, router: Router, tools: ToolRegistry):
        self.router = router
        self.tools = tools
    
    async def execute(self, context: dict) -> dict:
        ...
```

**应该做的事**：
```python
# ✅ Python 原生设计
from dataclasses import dataclass, field
from typing import Protocol, AsyncIterator

# 1. 接口用 Protocol（结构化子类型，比 TS interface 更灵活）
class Agent(Protocol):
    route: RouteName
    
    async def execute(
        self, 
        ctx: RunContext, 
        scope: ExecutionScope
    ) -> AsyncIterator[StreamEvent]:
        ...

# 2. 不可变上下文用 frozen dataclass
@dataclass(frozen=True, slots=True)
class RunContext:
    run_id: str
    ancestry: tuple[str, ...]  # 比 list 更安全，真正不可变
    signal: asyncio.Event  # 取消信号
    metadata: Mapping[str, object] = field(default_factory=dict)

# 3. 状态机用 Enum + 显式转换
class RunState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    INTERRUPTING = "interrupting"
    COMPLETED = "completed"
    FAILED = "failed"

# 4. 配置用 Pydantic Settings（环境变量 → 类型安全的 Settings 对象）
class Settings(BaseSettings):
    database_url: PostgresDsn
    redis_url: RedisDsn
    openai_api_key: SecretStr
    
    model_config = SettingsConfigDict(env_file=".env")
```

---

## 二、Python 项目目录结构

```
apps/server-py/
├── pyproject.toml                    # uv 项目定义 + 依赖
├── alembic.ini                       # Alembic 数据库迁移配置
├── alembic/
│   ├── env.py                        # async engine 配置
│   └── versions/                     # 迁移脚本
├── .env.example                      # 环境变量模板
├── .ruff.toml                        # Ruff 配置
├── mypy.ini                          # mypy 渐进 strict 配置
├── Dockerfile
├── docker-compose.yml                # 独立 Python 后端 + infra
│
├── src/
│   ├── __init__.py
│   ├── main.py                       # FastAPI app 组装 + lifespan
│   ├── config.py                     # pydantic-settings
│   ├── db.py                         # SQLAlchemy engine + session factory
│   ├── worker.py                     # ARQ Worker 入口
│   │
│   ├── models/                       # ── SQLAlchemy 2.0 ORM 模型 ──
│   │   ├── __init__.py
│   │   ├── base.py                   # DeclarativeBase + mixins
│   │   ├── user.py
│   │   ├── conversation.py
│   │   ├── knowledge.py              # KB, Document, Chunk + pgvector
│   │   ├── agent.py                  # AgentSession, Approval
│   │   ├── workflow.py
│   │   ├── team.py
│   │   └── project.py
│   │
│   ├── schemas/                      # ── Pydantic v2 请求/响应模型 ──
│   │   ├── __init__.py
│   │   ├── common.py                 # Pagination, ErrorResponse
│   │   ├── user.py
│   │   ├── chat.py
│   │   ├── agent.py                  # AgentStreamEvent (Discriminated Union)
│   │   ├── tool.py
│   │   ├── workflow.py
│   │   └── team.py
│   │
│   ├── api/                          # ── FastAPI 路由层 ──
│   │   ├── __init__.py
│   │   ├── deps.py                   # 共享依赖: get_db, get_current_user
│   │   ├── router.py                 # 主路由聚合
│   │   ├── middleware/
│   │   │   ├── __init__.py
│   │   │   ├── auth.py
│   │   │   ├── rate_limit.py
│   │   │   ├── content_safety.py
│   │   │   └── error_handler.py
│   │   └── v1/                       # API v1
│   │       ├── __init__.py
│   │       ├── health.py
│   │       ├── auth.py
│   │       ├── chat.py               # SSE streaming
│   │       ├── agent.py              # Agent execution endpoints
│   │       ├── tools.py
│   │       ├── knowledge.py
│   │       ├── workflows.py
│   │       ├── teams.py
│   │       └── diagnosis.py
│   │
│   ├── runtime/                      # ── 核心 Runtime（Phase 2 最高优先级）──
│   │   ├── __init__.py
│   │   ├── context.py                # RunContext (frozen dataclass)
│   │   ├── node.py                   # ExecutionNode (树节点)
│   │   ├── tree.py                   # ExecutionTree (ancestry 追踪)
│   │   ├── state.py                  # RunState + StateMachine
│   │   ├── events.py                 # EventBus (asyncio.Queue pub/sub)
│   │   ├── controller.py            # ExecutionController (编排)
│   │   ├── cancellation.py          # 取消信号传播
│   │   ├── timeout.py               # 超时管理
│   │   └── retry.py                  # 重试策略 (tenacity 封装)
│   │
│   ├── agent/                        # ── Agent Framework（Phase 3）──
│   │   ├── __init__.py
│   │   ├── types.py                  # Protocol: Agent, Router, ToolExecutor
│   │   ├── router/                   # 路由分类器
│   │   │   ├── __init__.py
│   │   │   ├── pipeline.py           # QueryRouter 编排器
│   │   │   ├── l1_keyword.py
│   │   │   ├── l2_semantic.py
│   │   │   ├── l3_llm_router.py
│   │   │   └── l5_fallback.py
│   │   ├── executor.py               # ReAct AgentExecutor
│   │   ├── agents/                   # 各路由 Agent 实现
│   │   │   ├── __init__.py
│   │   │   ├── safety.py
│   │   │   ├── chat.py
│   │   │   ├── task.py
│   │   │   ├── human.py
│   │   │   └── diagnosis.py
│   │   ├── tools/                    # Tool 系统
│   │   │   ├── __init__.py
│   │   │   ├── registry.py
│   │   │   ├── base.py               # Tool Protocol + decorator
│   │   │   ├── builtins/
│   │   │   │   ├── search_knowledge.py
│   │   │   │   └── ...
│   │   │   └── business/
│   │   │       ├── create_ticket.py
│   │   │       └── diagnosis_tools.py
│   │   └── validation.py             # 业务响应校验
│   │
│   ├── rag/                          # ── RAG 系统（Phase 4）──
│   │   ├── __init__.py
│   │   ├── parser/                   # 文档解析器链
│   │   │   ├── __init__.py
│   │   │   ├── registry.py
│   │   │   ├── text.py
│   │   │   ├── pdf.py
│   │   │   ├── word.py
│   │   │   ├── image.py
│   │   │   └── video.py
│   │   ├── chunking/                 # 分片管线
│   │   │   ├── __init__.py
│   │   │   ├── splitter.py           # Token-aware splitter
│   │   │   ├── hierarchical.py       # 层次分片
│   │   │   └── dedup.py
│   │   ├── embedding/
│   │   │   ├── __init__.py
│   │   │   ├── provider.py           # EmbeddingProvider Protocol
│   │   │   └── batch.py              # 批量向量化
│   │   ├── retrieval/
│   │   │   ├── __init__.py
│   │   │   ├── semantic.py           # pgvector k-NN
│   │   │   ├── keyword.py            # Elasticsearch BM25
│   │   │   ├── hybrid.py             # RRF 融合
│   │   │   └── reranker.py
│   │   ├── ingestion.py              # 摄入管线编排
│   │   ├── regression.py             # 回归测试
│   │   └── graph/                    # Knowledge Graph (Neo4j)
│   │       ├── __init__.py
│   │       ├── client.py
│   │       └── builder.py
│   │
│   ├── workflows/                    # ── Workflow 引擎（Phase 3）──
│   │   ├── __init__.py
│   │   ├── schema.py
│   │   ├── dag.py                    # DAG executor
│   │   ├── step_runner.py
│   │   ├── checkpoint.py
│   │   ├── variable_resolver.py
│   │   └── handlers/
│   │       ├── __init__.py
│   │       ├── agent.py
│   │       ├── tool.py
│   │       ├── condition.py
│   │       ├── parallel.py
│   │       ├── human_approval.py
│   │       └── transform.py
│   │
│   ├── teams/                        # ── Multi-Agent（Phase 3）──
│   │   ├── __init__.py
│   │   ├── blackboard.py
│   │   ├── message_bus.py
│   │   ├── executor.py
│   │   └── modes/
│   │       └── diagnosis.py
│   │
│   ├── providers/                    # ── LLM Provider 抽象 ──
│   │   ├── __init__.py
│   │   ├── base.py                   # LLMProvider Protocol
│   │   ├── openai_provider.py
│   │   ├── deepseek_provider.py
│   │   └── registry.py
│   │
│   ├── storage/                      # ── 文件存储抽象 ──
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── local.py
│   │   └── minio.py
│   │
│   ├── observability/                # ── 可观测性 ──
│   │   ├── __init__.py
│   │   ├── tracing.py                # OpenTelemetry
│   │   ├── metrics.py                # Prometheus
│   │   └── langfuse.py               # LLM 可观测
│   │
│   ├── jobs/                         # ── 后台作业 ──
│   │   ├── __init__.py
│   │   ├── queues.py
│   │   └── processors.py
│   │
│   └── lib/                          # ── 工具库 ──
│       ├── __init__.py
│       ├── circuit_breaker.py
│       ├── json_utils.py
│       └── token_counter.py
│
└── tests/                            # ── 全量测试（Phase 5 集中编写）──
    ├── __init__.py
    ├── conftest.py                    # 全局 fixtures
    ├── factories/                     # 测试数据工厂
    │   ├── __init__.py
    │   ├── user.py
    │   └── conversation.py
    ├── unit/
    │   ├── test_config.py
    │   ├── test_db.py
    │   ├── runtime/
    │   │   ├── test_context.py
    │   │   ├── test_node.py
    │   │   ├── test_tree.py
    │   │   ├── test_state_machine.py
    │   │   ├── test_events.py
    │   │   └── test_controller.py
    │   ├── agent/
    │   │   ├── test_router_pipeline.py
    │   │   ├── test_executor.py
    │   │   └── test_tool_registry.py
    │   └── rag/
    │       ├── test_splitter.py
    │       ├── test_retrieval.py
    │       └── test_ingestion.py
    ├── integration/
    │   ├── test_auth_api.py
    │   ├── test_chat_api.py
    │   ├── test_agent_api.py
    │   ├── test_workflow_api.py
    │   └── test_team_api.py
    └── e2e/
        └── test_user_journey.py
```

---

## 三、TS 与 Python 核心模块对应关系

### 3.1 模块映射表

| 当前 TS 模块 | Python 对应 | 设计变化 |
|---|---|---|
| `config.ts` (dotenv + 手写 settings) | `config.py` (pydantic-settings `BaseSettings`) | 环境变量 → 类型安全的 Settings 对象，自带校验 |
| `db.ts` (PrismaClient singleton) | `db.py` (async engine + async_sessionmaker) | Prisma 隐式连接池 → SQLAlchemy 显式 session 管理 |
| `lib/hono.ts` (typed Hono factory) | FastAPI `app = FastAPI()` + `deps.py` | Hono Context Variables → FastAPI `Depends()` 链 |
| `middleware/auth.ts` | `api/middleware/auth.py` | JWT 中间件 → FastAPI `Depends(get_current_user)` |
| `middleware/rate-limit.ts` | `api/middleware/rate_limit.py` | ioredis → redis-py async |
| `providers/` (class + interface) | `providers/` (Protocol + dataclass) | TS class 继承 → Python Protocol 结构化子类型 |
| `runtime/context.ts` (frozen object) | `runtime/context.py` (frozen dataclass) | `Object.freeze()` → `@dataclass(frozen=True, slots=True)` |
| `runtime/controller.ts` (class) | `runtime/controller.py` + `runtime/node.py` | 单 Controller 类 → ExecutionNode 树 + ExecutionController 编排 |
| `runtime/buffer.ts` | `runtime/events.py` (asyncio.Queue) | 手写 buffer → asyncio.Queue pub/sub |
| `services/agent-runtime/router.ts` | `agent/router/pipeline.py` | 同架构，Python 用 Protocol 定义 Router 接口 |
| `services/agent-runtime/agent-executor.ts` | `agent/executor.py` | ReAct loop 同算法，用 `async for` 替代 `AsyncGenerator` |
| `services/agent-runtime/routing/l1-keyword.ts` | `agent/router/l1_keyword.py` | 正则匹配逻辑一致 |
| `services/agent-runtime/routing/l2-semantic.ts` | `agent/router/l2_semantic.py` | pgvector k-NN，Python 用 `pgvector.sqlalchemy` |
| `services/agent-runtime/routing/l3-llm-router.ts` | `agent/router/l3_llm_router.py` | LLM 调用 + Pydantic 解析（替代 Zod） |
| `services/agent-runtime/types.ts` | `agent/types.py` (Protocol + Enum + dataclass) | `type RouteName = "A" \| "B"` → `StrEnum` |
| `tools/registry.ts` (class singleton) | `agent/tools/registry.py` (module-level instance) | Python 模块天然单例，无需 class wrapper |
| `tools/types.ts` | `agent/tools/base.py` (Protocol) | `interface ToolExecutor` → `class ToolExecutor(Protocol)` |
| `services/knowledge*.ts` | `rag/` 目录 | 按职责拆分到 parser/chunking/embedding/retrieval |
| `services/embeddings.ts` | `rag/embedding/provider.py` | Provider Protocol 支持多后端 |
| `services/reranker.ts` | `rag/retrieval/reranker.py` | 同逻辑 |
| `services/text-splitter.ts` | `rag/chunking/splitter.py` | 同算法，加 hierarchical 模式 |
| `services/knowledge-ingestion.ts` | `rag/ingestion.py` | 管线编排：parse → normalize → chunk → embed → index |
| `workflows/` | `workflows/` | DAG 引擎同架构 |
| `teams/` | `teams/` | Blackboard + MessageBus 同模式 |
| `jobs/queues.ts` (BullMQ) | `jobs/queues.py` (ARQ) | BullMQ Job → ARQ @job 装饰器 |
| `observability/` | `observability/` | OpenTelemetry Python SDK 同 API |
| `services/auth.ts` | `api/v1/auth.py` + `lib/auth.py` | JWT 逻辑拆分到 lib，路由放 api |
| `modules/` | 合并到 `api/v1/` | 模块系统 → FastAPI `APIRouter` + `include_router` |

### 3.2 关键类型映射

| TS | Python | 说明 |
|---|---|---|
| `interface Agent { execute(): AsyncGenerator }` | `class Agent(Protocol): async def execute() -> AsyncIterator` | Protocol 是结构化子类型，比 TS interface 更灵活 |
| `type RouteName = "SAFETY" \| "CHAT" \| "TASK" \| "HUMAN"` | `class RouteName(StrEnum)` | Enum 有运行时值，不仅限于类型层面 |
| `z.object({...}).parse()` | `MyModel.model_validate(data)` | Pydantic v2 性能与 Zod 同级 |
| `AsyncGenerator<Event, void, unknown>` | `AsyncIterator[Event]` | Python 用 `async for` 消费 |
| `Record<string, unknown>` | `dict[str, Any]` 或 `Mapping[str, object]` | Mapping 表示不可变只读 |
| `Partial<T>` | `t.Installation` (typing) 或 Pydantic `.model_dump(exclude_unset=True)` | 两种路径 |
| `Pick<T, K>` | Pydantic `model_fields` 选择 | 通常重新定义一个小 Model 更清晰 |
| `Promise.all([...])` | `asyncio.gather(*tasks)` | 并发语义一致 |
| `EventEmitter` | `asyncio.Queue` 或自定义 Observer Protocol | Python 没有内置 EventEmitter |

---

## 四、分阶段 PR 开发计划

### Phase 1：基础工程能力（PR #1）

**目标**: 可运行的 FastAPI 空壳 + 数据库连接 + 用户系统

**PR 内容**:

```
PR #1: feat(python): Phase 1 - 项目骨架 + 用户系统 + Conversation API

apps/server-py/
├── pyproject.toml                    # uv 项目，含全部依赖声明
├── alembic.ini + alembic/            # 从现有 PG 生成基线迁移
├── .env.example
├── .ruff.toml
├── mypy.ini                          # 渐进: 先宽松，Phase 2 起逐步 strict
├── src/
│   ├── config.py                     # pydantic-settings
│   ├── db.py                         # async engine + sessionmaker
│   ├── main.py                       # FastAPI app + lifespan
│   ├── models/                       # SQLAlchemy 2.0 ORM（全部模型）
│   │   ├── base.py
│   │   ├── user.py
│   │   ├── conversation.py
│   │   ├── knowledge.py
│   │   ├── agent.py
│   │   ├── workflow.py
│   │   ├── team.py
│   │   └── project.py
│   ├── schemas/                      # Pydantic 请求/响应
│   │   ├── common.py
│   │   ├── user.py
│   │   └── chat.py
│   ├── api/
│   │   ├── deps.py                   # get_db, get_current_user
│   │   ├── middleware/
│   │   │   ├── error_handler.py
│   │   │   ├── auth.py
│   │   │   └── rate_limit.py
│   │   └── v1/
│   │       ├── health.py
│   │       ├── auth.py               # signup/signin/refresh/me
│   │       └── chat.py               # 基础 chat（不含 Agent Runtime）
│   └── providers/
│       ├── base.py                   # LLMProvider Protocol
│       ├── openai_provider.py
│       ├── deepseek_provider.py
│       └── registry.py
└── docker-compose.yml                # Python 后端 + 共享 PG/Redis
```

**技术细节**:

1. **SQLAlchemy 2.0 Typed ORM**:
```python
# models/base.py
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import DateTime, func
from datetime import datetime

class Base(DeclarativeBase):
    pass

class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

2. **pgvector 集成**:
```python
# models/knowledge.py
from pgvector.sqlalchemy import Vector

class KnowledgeChunk(Base, TimestampMixin):
    __tablename__ = "knowledge_chunks"
    
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
```

3. **Alembic 基线迁移策略**:
```bash
# 不从零建表，从现有 Prisma 管理的 PG 数据库反向生成
alembic init alembic
# 配置 env.py 使用 async engine
# 首次运行 stamp head，将当前 DB 状态标记为基线
alembic stamp head
# 后续模型变更才生成新迁移
```

4. **FastAPI 依赖注入模式**（替代 Hono Context Variables）:
```python
# api/deps.py
from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

async def get_db() -> AsyncIterator[AsyncSession]:
    async with async_session() as session:
        yield session

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await auth_service.verify_token(db, token)
    if not user:
        raise HTTPException(status_code=401)
    return user
```

**验收标准**:
- `uv run uvicorn src.main:app` 启动成功
- `curl /api/health` 返回 `{"status": "ok"}`
- `curl /api/v1/auth/signup` 可注册用户
- `curl /api/v1/auth/signin` 返回 JWT
- `/docs` 可见自动生成的 Swagger UI

---

### Phase 2：核心 Runtime（PR #2 — 最高优先级）

**目标**: 重新设计 Python 版本的 Execution Runtime，这是整个项目最核心的模块

**为什么 Runtime 是最高优先级？**

AgentForge 本质上是一个 Agent Runtime 平台。Agent Framework、Workflow、RAG 都是 Runtime 的消费者。如果 Runtime 抽象不好：
- Agent 执行无法取消（用户体验差）
- 调用链无法追踪（调试困难）
- 错误处理散落各处（维护噩梦）

反之，一个设计良好的 Runtime 是 AI Agent 工程能力的核心体现。

**PR 内容**:

```
PR #2: feat(python): Phase 2 - 核心 Execution Runtime

src/runtime/
├── __init__.py
├── context.py            # RunContext - 不可变运行时上下文
├── node.py               # ExecutionNode - 执行树节点
├── tree.py               # ExecutionTree - 执行树（ancestry 追踪）
├── state.py              # RunState 状态机
├── events.py             # EventBus - asyncio.Queue pub/sub
├── controller.py         # ExecutionController - 编排器
├── cancellation.py       # 取消信号传播
├── timeout.py            # 超时管理
└── retry.py              # 重试策略
```

**技术细节 — 每个模块的 Python 原生设计**:

#### 2.1 `context.py` — RunContext

```python
# TS 原版：Object.freeze() + readonly fields
# Python 版：frozen dataclass + slots（零开销 + 真不可变）

from dataclasses import dataclass, field
from typing import Mapping
import asyncio

@dataclass(frozen=True, slots=True)
class RunContext:
    """不可变运行时上下文。每个 Agent/Tool 调用创建子上下文。"""
    run_id: str
    ancestry: tuple[str, ...]  # tuple 而非 list —— 真不可变
    signal: asyncio.Event      # 取消信号（set 时触发取消）
    metadata: Mapping[str, object] = field(default_factory=dict)
    
    def child(self, child_run_id: str | None = None) -> "RunContext":
        """创建子上下文（新 ancestry 节点）"""
        import uuid
        return RunContext(
            run_id=child_run_id or str(uuid.uuid4()),
            ancestry=(*self.ancestry, self.run_id),
            signal=self.signal,  # 子上下文共享取消信号
            metadata=self.metadata,
        )
```

#### 2.2 `node.py` — ExecutionNode

```python
# 这是 TS 版本没有的抽象。Python 版重新设计。
# 每个 ExecutionNode 代表执行树中的一个节点，封装一个协程的执行。

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Coroutine, Any
from enum import StrEnum
import asyncio

class NodeStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class ExecutionNode:
    """执行树中的一个节点。
    
    每个节点：
    - 封装一个协程
    - 拥有独立的生命周期
    - 可被父节点取消
    - 记录开始/结束时间
    """
    name: str
    coro: Coroutine[Any, Any, Any]
    parent: ExecutionNode | None = None
    children: list[ExecutionNode] = field(default_factory=list)
    status: NodeStatus = NodeStatus.PENDING
    result: Any = None
    error: Exception | None = None
    started_at: float | None = None
    completed_at: float | None = None
    
    async def execute(self, ctx: RunContext) -> Any:
        """执行此节点。子节点由 coro 内部调用 controller.spawn() 创建。"""
        import time
        self.status = NodeStatus.RUNNING
        self.started_at = time.monotonic()
        try:
            self.result = await self.coro
            self.status = NodeStatus.COMPLETED
            return self.result
        except asyncio.CancelledError:
            self.status = NodeStatus.CANCELLED
            raise
        except Exception as e:
            self.status = NodeStatus.FAILED
            self.error = e
            raise
        finally:
            self.completed_at = time.monotonic()
    
    @property
    def elapsed_ms(self) -> float:
        if self.started_at and self.completed_at:
            return (self.completed_at - self.started_at) * 1000
        return 0.0
    
    @property
    def depth(self) -> int:
        """节点在树中的深度"""
        if self.parent is None:
            return 0
        return self.parent.depth + 1
```

#### 2.3 `tree.py` — ExecutionTree

```python
# 执行树：追踪整个请求的完整调用链
# 从 API 入口 → Agent → ReAct 步骤 → Tool 调用 → LLM 调用

@dataclass
class ExecutionTree:
    """执行树 — 替代 TS 版的 ancestry 数组。
    
    提供：
    - 完整调用链可视化
    - 时间线追踪
    - 按类型过滤节点
    """
    root: ExecutionNode
    
    @classmethod
    def create(cls, name: str, coro: Coroutine) -> tuple["ExecutionTree", ExecutionNode]:
        node = ExecutionNode(name=name, coro=coro)
        tree = cls(root=node)
        return tree, node
    
    def flatten(self) -> list[ExecutionNode]:
        """DFS 展平所有节点"""
        nodes = [self.root]
        for child in self.root.children:
            nodes.extend(ExecutionTree(root=child).flatten())
        return nodes
    
    def timeline(self) -> list[dict[str, Any]]:
        """按开始时间排序的时间线"""
        return sorted(
            [{"name": n.name, "start": n.started_at, "end": n.completed_at, 
              "status": n.status, "depth": n.depth}
             for n in self.flatten()],
            key=lambda n: n["start"] or 0
        )
    
    def to_dict(self) -> dict:
        """递归转为 dict（用于 API 返回调试信息）"""
        def _to_dict(node: ExecutionNode) -> dict:
            return {
                "name": node.name,
                "status": node.status,
                "elapsed_ms": node.elapsed_ms,
                "error": str(node.error) if node.error else None,
                "children": [_to_dict(c) for c in node.children],
            }
        return _to_dict(self.root)
```

#### 2.4 `state.py` — 状态机

```python
# TS 版：枚举 + switch 语句
# Python 版：显式状态转换表 + 非法转换拒绝

from enum import StrEnum, auto
from dataclasses import dataclass
from typing import Callable, Awaitable

class RunState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    INTERRUPTING = "interrupting"
    INTERRUPTED = "interrupted"
    COMPLETED = "completed"
    FAILED = "failed"

# 合法状态转换表
TRANSITIONS: dict[RunState, frozenset[RunState]] = {
    RunState.PENDING:      frozenset({RunState.RUNNING}),
    RunState.RUNNING:      frozenset({RunState.INTERRUPTING, RunState.COMPLETED, RunState.FAILED}),
    RunState.INTERRUPTING: frozenset({RunState.INTERRUPTED, RunState.COMPLETED, RunState.FAILED}),
    RunState.INTERRUPTED:  frozenset(),  # 终态
    RunState.COMPLETED:    frozenset(),  # 终态
    RunState.FAILED:       frozenset(),  # 终态
}

@dataclass
class StateMachine:
    """运行时状态机，拒绝非法转换"""
    state: RunState = RunState.PENDING
    
    def transition(self, to: RunState) -> None:
        allowed = TRANSITIONS.get(self.state, frozenset())
        if to not in allowed:
            raise InvalidStateTransition(
                f"Cannot transition {self.state} → {to}. "
                f"Allowed: {allowed}"
            )
        self.state = to
    
    @property
    def is_terminal(self) -> bool:
        return self.state in {RunState.COMPLETED, RunState.FAILED, RunState.INTERRUPTED}
```

#### 2.5 `events.py` — EventBus

```python
# TS 版：EventEmitter（on/emit/off 模式）
# Python 版：asyncio.Queue pub/sub（更适合 async 环境）

import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, TypeVar

T = TypeVar("T")

@dataclass
class EventBus:
    """基于 asyncio.Queue 的事件总线。
    
    每个 subscriber 获得独立的 Queue，互不影响。
    发布者无需关心 subscriber 数量。
    """
    _subscribers: list[asyncio.Queue] = field(default_factory=list)
    
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q
    
    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass
    
    async def publish(self, event: T) -> None:
        """向所有 subscriber 广播事件"""
        for q in self._subscribers:
            await q.put(event)
    
    async def close(self) -> None:
        """发送终止信号给所有 subscriber"""
        for q in self._subscribers:
            await q.put(None)  # Sentinel
        self._subscribers.clear()
    
    async def iter_events(self) -> AsyncIterator[T]:
        """订阅并获取异步迭代器"""
        q = self.subscribe()
        try:
            while True:
                event = await q.get()
                if event is None:  # Sentinel
                    break
                yield event
        finally:
            self.unsubscribe(q)
```

#### 2.6 `controller.py` — ExecutionController

```python
# 编排 ExecutionNode 树 + 状态机 + EventBus + 取消/超时

import asyncio
import time
from typing import Any

@dataclass
class ExecutionController:
    """执行编排器。
    
    职责：
    - 启动 ExecutionNode 树
    - 管理状态机转换
    - 事件发布（开始/完成/失败）
    - 超时控制
    - 取消信号传播
    """
    tree: ExecutionTree
    state: StateMachine = field(default_factory=StateMachine)
    events: EventBus = field(default_factory=EventBus)
    
    async def run(self, timeout_ms: int | None = None) -> Any:
        """执行主入口"""
        self.state.transition(RunState.RUNNING)
        ctx = RunContext(
            run_id=str(uuid.uuid4()),
            ancestry=(),
            signal=asyncio.Event(),
        )
        
        await self.events.publish({"type": "run_started", "run_id": ctx.run_id})
        
        try:
            if timeout_ms:
                result = await asyncio.wait_for(
                    self.tree.root.execute(ctx),
                    timeout=timeout_ms / 1000,
                )
            else:
                result = await self.tree.root.execute(ctx)
            
            self.state.transition(RunState.COMPLETED)
            await self.events.publish({"type": "run_completed", "result": result})
            return result
            
        except asyncio.TimeoutError:
            self.state.transition(RunState.FAILED)
            await self.events.publish({"type": "run_timeout"})
            raise
            
        except asyncio.CancelledError:
            self.state.transition(RunState.INTERRUPTED)
            ctx.signal.set()  # 传播取消信号给所有子节点
            await self.events.publish({"type": "run_cancelled"})
            raise
            
        except Exception as e:
            self.state.transition(RunState.FAILED)
            await self.events.publish({"type": "run_failed", "error": str(e)})
            raise
```

**验收标准**:
- `ExecutionNode` 可嵌套执行，子节点状态独立跟踪
- `ExecutionTree.flatten()` 正确展平 DFS
- `StateMachine` 拒绝非法转换（如 COMPLETED → RUNNING）
- `EventBus` 多 subscriber 各自独立接收
- `ExecutionController.run()` 正确传播取消信号
- 超时场景：子节点正确触发 `CancelledError`

---

### Phase 3：Agent Framework（PR #3）

**目标**: 在 Runtime 之上构建完整的 Agent 系统

**PR 内容**:

```
PR #3: feat(python): Phase 3 - Agent Framework + Workflow + Teams

src/agent/
├── types.py              # Agent, Router, ToolExecutor Protocol
├── router/pipeline.py    # QueryRouter（5 层管线编排）
├── router/l1_keyword.py
├── router/l2_semantic.py
├── router/l3_llm_router.py
├── router/l5_fallback.py
├── executor.py           # ReAct AgentExecutor
├── agents/{safety,chat,task,human,diagnosis}.py
├── tools/registry.py
├── tools/base.py
├── tools/builtins/
├── tools/business/
└── validation.py

src/workflows/            # Workflow 引擎
src/teams/                # Multi-Agent 协作
```

**技术细节**:

1. **Agent Protocol**（替代 TS interface）:
```python
from typing import Protocol, AsyncIterator

class Agent(Protocol):
    route: RouteName
    
    async def execute(
        self,
        ctx: RunContext,
        scope: ExecutionScope,
    ) -> AsyncIterator[StreamEvent]:
        """执行 Agent，流式产出事件"""
        ...
```

2. **ReAct Executor** — 核心算法不变，Python 化：
```python
class AgentExecutor:
    async def run(self, ctx: RunContext) -> AsyncIterator[StreamEvent]:
        controller = ExecutionController.create("react-loop", ...)
        
        async for event in controller.run():
            if isinstance(event, AgentThinkEvent):
                # 解析 ReAct JSON → tool_call / respond / ask_user
                decision = self.parse_decision(event.content)
                if decision.action == "tool_call":
                    # 创建子 ExecutionNode 执行工具
                    tool_node = await controller.spawn(
                        f"tool:{decision.tool}",
                        self.execute_tool(decision, ctx),
                    )
                    result = await tool_node.execute(ctx.child())
                    yield AgentActEvent(tool=decision.tool, result=result)
                elif decision.action == "respond":
                    yield AgentDoneEvent(content=decision.content)
                    break
```

3. **SSE Streaming 在 FastAPI 中的实现**:
```python
# api/v1/agent.py
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter()

@router.post("/api/agent/chat")
async def agent_chat(request: ChatRequest, user: User = Depends(get_current_user)):
    async def event_stream() -> AsyncIterator[str]:
        async for event in agent_executor.run(ctx):
            yield f"data: {event.model_dump_json()}\n\n"
    
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 nginx 缓冲
        },
    )
```

**验收标准**:
- Router 5 层管线正确分类 4 种路由
- AgentExecutor ReAct 循环正常：思考 → 工具调用 → 观察 → 回答
- SSE 流式输出在浏览器中可见逐 token 推送
- Workflow DAG 可执行含 agent/tool/condition/parallel 步骤的定义
- Teams 多 Agent 在 Blackboard 上正确共享状态

---

### Phase 4：RAG 系统（PR #4）

**目标**: 完整的 RAG Pipeline + Knowledge Graph

**PR 内容**:

```
PR #4: feat(python): Phase 4 - RAG 系统 + Knowledge Graph

src/rag/
├── parser/{registry,text,pdf,word,image,video}.py
├── chunking/{splitter,hierarchical,dedup}.py
├── embedding/{provider,batch}.py
├── retrieval/{semantic,keyword,hybrid,reranker}.py
├── ingestion.py
├── regression.py
└── graph/{client,builder}.py          # Neo4j Knowledge Graph
```

**技术细节**:

1. **Hybrid Retrieval (RRF Fusion)**:
```python
# 语义搜索（pgvector）+ 关键词搜索（Elasticsearch BM25）→ RRF 融合
async def hybrid_search(
    query: str,
    kb_id: str,
    top_k: int = 10,
) -> list[SearchResult]:
    semantic_results = await semantic_search(query, kb_id, top_k * 2)
    keyword_results = await bm25_search(query, kb_id, top_k * 2)
    return rrf_fusion(semantic_results, keyword_results, k=60)[:top_k]
```

2. **Neo4j Knowledge Graph**（Phase 4 新增能力）:
```python
# rag/graph/builder.py
from neo4j import AsyncGraphDatabase

class KnowledgeGraphBuilder:
    """从知识文档中抽取实体和关系，构建知识图谱"""
    
    async def extract_entities(self, text: str) -> list[Entity]:
        """LLM 驱动的实体抽取"""
        ...
    
    async def build_relations(self, entities: list[Entity]) -> list[Relation]:
        """实体间关系发现"""
        ...
    
    async def upsert_subgraph(self, doc_id: str, entities: list[Entity], relations: list[Relation]):
        """写入 Neo4j"""
        async with self.driver.session() as session:
            for entity in entities:
                await session.run(
                    "MERGE (e:Entity {name: $name}) SET e.type = $type, e.doc_id = $doc_id",
                    name=entity.name, type=entity.type, doc_id=doc_id,
                )
```

**验收标准**:
- 文档上传 → 解析 → 分片 → 向量化 → 索引全链路
- Hybrid Search (pgvector + ES) 返回融合结果
- Reranker 对结果重排序
- Neo4j 可查询实体间关系
- Regression 测试套件可运行

---

### Phase 5：生产能力 + 全量测试（PR #5）

**目标**: Docker/CI/Observability + 全面测试覆盖

**PR 内容**:

```
PR #5: feat(python): Phase 5 - 生产能力 + 全量测试

├── Dockerfile
├── docker-compose.yml
├── .github/workflows/ci.yml
├── src/observability/           # OpenTelemetry + Langfuse + Prometheus
├── src/jobs/                    # ARQ queues + processors
├── src/worker.py
└── tests/                       # 全量测试（集中编写）
    ├── conftest.py
    ├── factories/
    ├── unit/
    │   ├── runtime/             # Runtime 状态机、Node、Tree、EventBus
    │   ├── agent/               # Router 管线、Executor、Tool Registry
    │   └── rag/                 # Splitter、Retrieval、Ingestion
    ├── integration/
    │   ├── test_auth_api.py
    │   ├── test_chat_api.py
    │   ├── test_agent_api.py
    │   └── test_workflow_api.py
    └── e2e/
        └── test_user_journey.py
```

**测试策略细节**:

```python
# tests/conftest.py — 全局 fixtures
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

@pytest_asyncio.fixture
async def db_session():
    """每个测试独立的事务，自动回滚"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_session() as session:
        yield session
    await session.rollback()

@pytest_asyncio.fixture
async def client(db_session):
    """带 DB 的测试客户端"""
    from src.main import app
    app.dependency_overrides[get_db] = lambda: db_session
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac

# tests/unit/runtime/test_state_machine.py
async def test_rejects_illegal_transition():
    sm = StateMachine(state=RunState.COMPLETED)
    with pytest.raises(InvalidStateTransition):
        sm.transition(RunState.RUNNING)

async def test_allows_valid_transition():
    sm = StateMachine(state=RunState.PENDING)
    sm.transition(RunState.RUNNING)
    assert sm.state == RunState.RUNNING

# tests/unit/runtime/test_events.py
async def test_event_bus_multi_subscriber():
    bus = EventBus()
    sub1 = bus.subscribe()
    sub2 = bus.subscribe()
    
    await bus.publish({"test": True})
    
    assert (await sub1.get()) == {"test": True}
    assert (await sub2.get()) == {"test": True}
```

---

## 五、PR 开发序列总览

```
Phase 1 (PR #1): 基础工程              2-3 天
  └── FastAPI + SQLAlchemy + User System + Basic API

Phase 2 (PR #2): 核心 Runtime ★       5-7 天  ← 最高优先级
  └── RunContext + ExecutionNode + Tree + StateMachine + EventBus

Phase 3 (PR #3): Agent Framework      5-7 天
  └── Router + ReAct Executor + Tools + Workflow + Teams

Phase 4 (PR #4): RAG System           5-7 天
  └── Parser → Chunking → Embedding → Retrieval → KG

Phase 5 (PR #5): 生产 + 全量测试      7-10 天
  └── Docker + CI + Observability + Worker + All Tests

总计: 24-34 人天
```

---

## 六、迁移风险分析

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| **SQLAlchemy async session 生命周期管理** | 中 | 高 | 使用 `async_sessionmaker` + FastAPI `Depends` 确保每个请求独立 session，测试用回滚隔离 |
| **pgvector 在 SQLAlchemy 中的操作** | 中 | 中 | `pgvector.sqlalchemy` 支持 Vector 类型，但 k-NN 查询需手写 SQL；封装在 `retrieval/semantic.py` 中隔离 |
| **ARQ vs BullMQ 功能差异** | 中 | 中 | ARQ 缺少 rate limiter 和复杂 backoff 策略；初期用 tenacity 手动封装 retry，未来可切换 SAQ |
| **SSE Streaming 缓冲区行为** | 低 | 高 | FastAPI `StreamingResponse` 与 nginx 配合可能缓冲；设置 `X-Accel-Buffering: no` header |
| **JWT 签名算法兼容性** | 低 | 中 | TS 用 `jsonwebtoken`，Python 用 `python-jose`；统一用 HS256 算法，共享 JWT_SECRET |
| **中文分词精度差异** | 低 | 低 | `jieba` (Python) vs `@node-rs/jieba` (Rust) 是同一分词逻辑的不同实现，精度差异 < 5%；对搜索影响通过 hybrid retrieval 缓解 |
| **asyncio GIL 对 CPU 密集操作的影响** | 低 | 中 | pdf 解析、embedding 计算可能阻塞 event loop；用 `asyncio.to_thread()` 委托给线程池 |
| **Neo4j 引入增加运维复杂度** | 中 | 低 | Phase 4 可选项，docker-compose 中独立容器，不强制依赖 |

---

## 七、面试展示价值分析

### 7.1 这份代码能证明什么能力

| 能力维度 | 体现模块 | 面试价值 |
|---|---|---|
| **Python 异步工程** | `runtime/` — async/await, asyncio.Event, asyncio.Queue, asyncio.gather, CancelledError 传播 | 高级 Python 岗位核心考察点 |
| **类型系统掌握** | Protocol + frozen dataclass + StrEnum + TypedDict + Pydantic | 体现对 Python 类型系统的深度理解，而不只是"能写代码" |
| **架构设计** | 5 层 Routing Pipeline + ExecutionTree + StateMachine + EventBus | 展示系统设计能力，不只是 CRUD |
| **LLM/AI Agent 工程** | ReAct Loop + Tool Calling + SSE Streaming + Multi-Agent | AI 工程是目前最热门方向 |
| **RAG 系统** | Hybrid Retrieval + RRF + Reranker + Neo4j KG | 展示搜索/检索系统设计的深度 |
| **生产级思维** | Docker + CI + OpenTelemetry + Langfuse + Prometheus + Graceful Shutdown | 证明不只是"能跑"，而是"能上线" |
| **测试策略** | pytest + fixtures + factories + 分层测试（unit/integration/e2e） | 体现工程纪律 |

### 7.2 面试叙事建议

```
"我用 Python 重写了一个 AI Agent 平台的后端。

核心 Runtime 是我自己设计的 —— 因为 Node.js 的 EventEmitter 和 
asyncio 的协程模型有本质区别，我没有机械翻译，而是用 frozen 
dataclass + ExecutionNode 树 + asyncio.Queue pub/sub 重新设计了
整个执行模型。

Agent Framework 部分，我用 Protocol 而不是 ABC 来定义 Agent 接口，
因为 Python 的 Protocol 是结构化子类型，比 TS 的 interface 更灵活。

RAG 系统我做了 Hybrid Retrieval（pgvector + Elasticsearch）+ RRF 
融合，还加了 Neo4j 做 Knowledge Graph。

整个项目有完整的分层测试，Runtime 测试覆盖率超过 85%。"
```

### 7.3 GitHub 展示要点

- **README 中的架构图**: ASCII art 架构全景图 + 数据流图
- **5 个 PR 清晰的 commit history**: 每个 PR 一个主题，commit message 遵守 Conventional Commits
- **Runtime 模块单独 README**: 解释设计决策（为什么 Protocol 而不是 ABC、为什么 frozen dataclass 而不是 namedtuple、为什么 asyncio.Queue 而不是 callback）
- **Performance 对比**: Python 版 vs TS 版在相同场景下的基准测试图表
- **API 文档截图**: 自动生成的 Swagger UI 截图放在 README 中

---

## 八、前置决策确认

在开始写代码前，请确认：

1. ✅ Web 框架: **FastAPI**（已确认）
2. ✅ ORM: **SQLAlchemy 2.0 + Alembic**（已确认）
3. ✅ 验证: **Pydantic v2**（已确认）
4. ✅ 作业队列: **ARQ**（已确认）
5. ✅ 包管理: **uv**（已确认）
6. ✅ 测试: **pytest + pytest-asyncio**（已确认）
7. ✅ Lint: **ruff**（已确认）
8. ✅ 类型检查: **mypy** 渐进 strict（已确认）
9. ❓ Neo4j: Phase 4 引入 Knowledge Graph，是否需要？还是先 skip？
10. ❓ WebSocket: 当前有实时通信需求吗？FastAPI 原生支持 WebSocket
11. ❓ shared-prompts: prompt 模板继续放 `packages/shared-prompts`（TS），还是 Python 项目独立维护？
12. ❓ 迁移期间 Prisma schema 是否允许修改？如允许，需同步更新 SQLAlchemy 模型
