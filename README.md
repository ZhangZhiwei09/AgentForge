# AgentForge

面向企业内部问答、平台能力调用、知识管理和多 Agent 协作的全栈实验平台。仓库采用 pnpm + Turborepo 管理 React 前端、TypeScript 主后端、Python Agent Runtime 与共享包。

## 架构

```
React Apps (5173 / 5200)
          │  Vite proxy: /api → :8000
          ▼
TypeScript API · Hono (8000)
          ├── Auth / Data Management
          ├── Agent Runtime ── 5-route 分类 ── OpenAI / DeepSeek
          ├── Workflow Engine / Multi-Agent Team / Tool Registry
          └── Knowledge ── PGVector + Elasticsearch ── RRF ── Reranker (可选)
                    │
                    └── PostgreSQL · Redis · Ollama

Python API · FastAPI (8004，可选、独立演进)
          └── 5 层 Router ── LangGraph ReAct / Diagnosis Graph / RAG
```

三个前端当前都接入 TypeScript API。Python API 是独立的数据模型与 Runtime 实现，尚未接入前端，不是 TypeScript 服务的透明替代品。

## 核心能力

| 能力 | 状态 | 说明 |
|------|------|------|
| **Agent Runtime** | ✅ | TypeScript 主链路提供 ReAct 执行器与 SAFETY / CHAT / TASK / HUMAN / DIAGNOSIS 五类路由 |
| **RAG** | ✅ | PGVector 稠密检索 + Elasticsearch BM25 关键词检索，RRF 融合；Reranker 可选（需配置 `RERANKER_BASE_URL` / `RERANKER_MODEL`） |
| **文档解析** | ✅ | 文本、PDF、Word、图片、音频、视频解析，按文件类型和优先级选择解析器 |
| **Multi-Agent** | ✅ | 角色化 Agent 团队，消息总线，Blackboard 共享上下文 |
| **Tool Calling** | ✅ | Tool Registry（12 个内置/业务工具），风险分级 + 审批门禁 + 熔断器 |
| **Workflow Engine** | ✅ | DAG 编排，Checkpoint / Resume，暂停 / 恢复 / 重试 |
| **Human-in-the-Loop** | ✅ | 审批门禁，默认 300s 超时 |
| **Python Runtime** | 演进中 | FastAPI + LangGraph，覆盖五层路由、ReAct、诊断图、RAG 与 Redis 短期记忆 |
| **可观测性** | ✅ | Langfuse LLM 追踪 + OpenTelemetry + Jaeger + Prometheus |

> 已移除的能力（早期版本存在，代码已删除）：Voice Agent、Video Conversation、Docker 工具沙箱、Neo4j 知识图谱。`tools/types.ts` 仍保留 `sandbox` 标记字段，但已无执行实现，当前没有工具启用它。

## 双后端现状

仓库内并存两个后端，当前产品链路以 TypeScript 服务为主，Python 服务用于并行演进 Agent Runtime：

| | `apps/server`（TS） | `apps/server-py`（Python） |
|---|---|---|
| 角色 | 三个前端当前接入的主 API，包含认证和平台业务 | 独立 Agent Runtime 实现，包含开发用兼容认证端点 |
| 框架 | Hono 4 + Prisma 6 | FastAPI + SQLAlchemy + LangGraph |
| 端口（dev） | 8000 | 8004 |
| 数据库 | `agentforge`（Prisma） | `agentforge_py`（Alembic） |
| 主要能力 | 认证、数据管理、Agent、Workflow、Team | 五层路由、LangGraph ReAct、诊断多 Agent、RAG、Redis 短期记忆 |
| 共享包 | 使用 `packages/database`、`shared-*`、`logger` | 不依赖 `packages/*` |

两者当前不共享数据库。配置相同 `JWT_SECRET` 后，Python 端可以校验 TS 签发的 Token；Python 自带的 `/api/auth/signup` 和 `/api/auth/signin` 仅用于本地开发，正式部署应由统一认证服务签发 Token。

两个前端（customer-service / data-admin）的 Vite 代理均指向 `:8000`，即 TS 后端。Python 端目前没有前端接入。

> `apps/server-py/src/config.py` 与 `.env.example` 的默认端口是 8000。请使用 `pnpm py:dev`（固定为 8004），或在 Python 的 `.env` 中显式设置 `PORT=8004`，避免与 TS 服务冲突。

## 项目结构

```
AgentForge/
├── apps/
│   ├── server/              # Hono 4 后端 API（端口 8000，主后端）
│   ├── server-py/           # FastAPI 后端（端口 8004，并行演进中）
│   ├── customer-service/    # 智能客服前端（端口 5173）
│   └── data-admin/          # 数据管理前端（端口 5200）
├── packages/
│   ├── database/            # Prisma 6 Schema + Client 单例
│   ├── shared-types/        # 共享类型定义（纯类型，无运行时代码）
│   ├── shared-prompts/      # 集中化 Prompt 注册中心
│   ├── sdk/                 # AgentForgeClient + SSE 流式
│   ├── cui/                 # 聊天 UI 组件库
│   ├── ui/                  # 共享 UI 组件库
│   └── logger/              # pino 结构化日志
├── infra/
│   ├── docker/              # Docker Compose + Dockerfile
│   └── scripts/             # 运维脚本
└── docs/                    # 架构文档、工程规范、设计记录
```

## 技术栈

| 层 | 技术 |
|----|------|
| **前端** | React 19 · Vite 6 · TypeScript 5.7 · Tailwind CSS 3 · Zustand 5 · React Router 7 · TanStack Query 5 |
| **后端 (TS)** | Node.js 20+ · Hono 4 · TypeScript 5.7 · Zod 3 · Prisma 6 |
| **后端 (Python)** | Python 3.12 · FastAPI · SQLAlchemy (async) · Alembic · LangGraph · pgvector |
| **数据** | Prisma 6 · PostgreSQL 16 (pgvector) · Redis 7 · MinIO（可选，未纳入 Compose） |
| **向量检索** | PGVector · Elasticsearch 8 · Ollama（本地 Embedding，bge-m3 1024d） |
| **可观测性** | Langfuse · OpenTelemetry · Jaeger · Prometheus · pino |
| **基础设施** | Docker Compose · BullMQ · Turborepo · pnpm 9 |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 9
- Docker Desktop
- Python 3.12 + [uv](https://docs.astral.sh/uv/)（仅在使用 `server-py` 时需要）

### 安装

```bash
pnpm install
```

### 环境变量

```bash
cp .env.example apps/server/.env
cp .env.example packages/database/.env
# 编辑 apps/server/.env，至少配置一个可用的 LLM API Key
```

Prisma 命令从 `packages/database/.env` 读取 `DATABASE_URL`，TS 服务从 `apps/server/.env` 读取运行配置。Python 服务使用独立的 `apps/server-py/.env`，按需从同目录的 `.env.example` 复制。

### 启动基础设施

本地开发建议只启动依赖服务，避免容器内的 TS 服务占用 8000 端口：

```bash
docker compose -f infra/docker/docker-compose.yml up -d db redis ollama elasticsearch
```

`pnpm infra:up` 会启动 Compose 文件中的全部服务，包括 PostgreSQL、pgAdmin、Redis、Ollama、Elasticsearch、Jaeger、Langfuse 和容器化 TS API。使用它时不要再同时运行 `pnpm server:dev`。

### 初始化数据库

```bash
pnpm db:generate
pnpm db:migrate
```

### 启动开发服务

```bash
# 推荐按需启动
pnpm server:dev     # TS 后端 → http://localhost:8000
pnpm cs:dev         # 智能客服 → http://localhost:5173
pnpm admin:dev      # 数据管理 → http://localhost:5200

# 启动整个 workspace（包含可选 Python 服务）
pnpm dev
```

### 可选：Python Runtime

Python 服务使用独立数据库。首次启动前，先创建 `agentforge_py` 数据库并执行 Alembic 迁移：

```bash
cp apps/server-py/.env.example apps/server-py/.env
docker compose -f infra/docker/docker-compose.yml exec db createdb -U postgres agentforge_py
cd apps/server-py
uv sync
uv run alembic upgrade head
cd ../..
pnpm py:dev
```

如果数据库已经存在，可跳过 `createdb`。也可以通过 pgAdmin 手动创建数据库。Python API 启动后位于 http://localhost:8004，Swagger 文档位于 http://localhost:8004/docs。

### 访问地址

| 服务 | 地址 |
|------|------|
| 后端 API (TS) | http://localhost:8000 |
| 智能客服 | http://localhost:5173 |
| 数据管理 | http://localhost:5200 |

### 基础设施面板

| 服务 | 地址 | 凭据 |
|------|------|------|
| pgAdmin | http://localhost:5050 | admin@agentforge.io / admin |
| Jaeger UI | http://localhost:16686 | — |
| Langfuse | http://localhost:3000 | — |

## 常用命令

```bash
# 开发
pnpm dev                  # 启动全部服务
pnpm server:dev           # 启动 TS API 和 BullMQ Worker
pnpm server:worker        # 单独启动 BullMQ Worker
pnpm py:dev               # 启动可选 Python API

# 数据库
pnpm db:studio            # Prisma Studio → http://localhost:5555
pnpm db:seed              # 填充种子数据

# 质量
pnpm lint                 # 全量 Lint
pnpm typecheck            # 全量类型检查
pnpm test                 # 全量测试
pnpm py:test              # 仅 Python 后端测试

# 基础设施
pnpm infra:up             # 启动全部 Docker 服务
pnpm infra:down           # 停止全部 Docker 服务
pnpm infra:restart        # 重启全部 Docker 服务

# 构建
pnpm build                # 全量生产构建
```

## 文档

| 文档 | 说明 |
|------|------|
| [架构与路由](docs/architecture/routing.md) | 数据流、5-路由分类、Agent 分发 |
| [Agent Runtime](docs/runtime/execution-runtime-v1.md) | AgentExecutor、Router、KnowledgeContextBuilder |
| [知识混合检索](docs/architecture/knowledge-hybrid-retrieval.md) | PGVector + BM25 + RRF 融合 |
| [Python 核心能力升级](docs/design/python-core-upgrade-plan.md) | LangGraph ReAct、PGVector RAG、Langfuse |
| [多 Agent LangGraph 方案](docs/design/multi-agent-langgraph-plan.md) | Python 端诊断多 Agent 编排 |
| [类型安全规范](docs/engineering/type-safety.md) | Zod 校验、Prisma 类型推导、禁止 `any` |
| [中文 Prompt 规范](docs/engineering/chinese-prompts.md) | 所有 LLM 对话 Prompt 使用中文 |
| [开发指南](docs/operations/development.md) | 本地开发工作流 |
| [Pipeline 流程](docs/agents/pipeline.md) | Architect → Review → Implementation → Compliance → Code Review |
