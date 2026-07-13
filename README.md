# AgentForge

渐进式 AI Agent 平台 — 从智能客服到多 Agent 协作，一套 Runtime 统一驱动。

## 架构

```
Browser ──SSE/HTTP──▶ Hono (8000) ──▶ LLMProvider ──▶ OpenAI / DeepSeek
                          │
              ┌───────────┼───────────┐
              │           │           │
         ChatService  AgentRuntime  Voice/Video
         (/api/chat)  (/api/agent)  (WebSocket)
                          │
              ┌───────────┼───────────┐
              │           │           │
         Router     AgentExecutor   Knowledge
    (SAFETY/CHAT/     (ReAct)       Context
     TASK/HUMAN)                     Builder
              │
    ┌─────────┼─────────┬──────────┬──────────┐
    │         │         │          │          │
  PGVector  Milvus  Elasticsearch  Neo4j    Redis
  (向量)    (向量)   (关键词)     (知识图谱)  (队列)
```

## 核心能力

| 能力 | 状态 | 说明 |
|------|------|------|
| **Agent Runtime** | ✅ | 统一 `AgentExecutor`（ReAct），4-route 分类器，动态 Tool 获取 |
| **RAG + KG + Multimodal** | ✅ | PGVector + Milvus 双路向量检索，Elasticsearch 关键词检索，Neo4j 知识图谱，RRF 融合 + Reranker 精排 |
| **Multi-Agent** | ✅ | 角色化 Agent 团队，消息总线，Blackboard 共享上下文 |
| **Voice Agent** | ✅ | WebSocket 实时语音，Whisper ASR，OpenAI TTS |
| **Video Conversation** | ✅ | WebSocket 视频对话，Vision LLM 多模态理解 |
| **Tool Calling** | ✅ | Tool Registry + Docker 沙箱安全执行 |
| **Workflow Engine** | ✅ | DAG 编排，Checkpoint/Resume |
| **Human-in-the-Loop** | ✅ | 审批门禁，5 分钟超时自动拒绝 |
| **可观测性** | ✅ | Langfuse LLM 追踪 + OpenTelemetry + Jaeger + Prometheus |

## 项目结构

```
AgentForge/
├── apps/
│   ├── server/              # Hono 4 后端 API（端口 8000）
│   ├── customer-service/    # 智能客服前端（端口 5173）
│   ├── app-creator/         # Agent 构建器前端（端口 8080）
│   └── data-admin/          # 数据管理前端（端口 5200）
├── packages/
│   ├── database/            # Prisma 6 Schema + Client 单例
│   ├── shared-types/        # 共享类型定义（纯类型，无运行时代码）
│   ├── shared-prompts/      # 集中化 Prompt 注册中心
│   ├── sdk/                 # AgentForgeClient + SSE 流式
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
| **后端** | Node.js 20+ · Hono 4 · TypeScript 5.7 · Zod 3 · OpenAI SDK · DeepSeek SDK |
| **数据** | Prisma 6 · PostgreSQL 16 (pgvector) · Redis 7 · MinIO |
| **向量检索** | PGVector · Milvus 2.4 · Elasticsearch 8 · Neo4j 5 (知识图谱) |
| **可观测性** | Langfuse · OpenTelemetry · Jaeger · Prometheus · pino |
| **基础设施** | Docker Compose · BullMQ · Turborepo · pnpm 9 |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 9
- Docker Desktop

### 安装

```bash
pnpm install
```

### 环境变量

```bash
cp .env.example apps/server/.env
# 编辑 apps/server/.env，填入 API Key
```

### 启动基础设施

```bash
pnpm infra:up
```

这会在 Docker 中启动：PostgreSQL (pgvector) · Milvus · Elasticsearch · Neo4j · Redis · MinIO · Ollama · Jaeger · Langfuse · pgAdmin。

### 初始化数据库

```bash
pnpm db:generate
pnpm db:migrate
```

### 启动开发服务

```bash
# 一键启动全部服务
pnpm dev

# 或分别启动
pnpm server:dev     # 后端 → http://localhost:8000
pnpm cs:dev         # 智能客服 → http://localhost:5173
pnpm creator:dev    # Agent 构建器 → http://localhost:8080
pnpm admin:dev      # 数据管理 → http://localhost:5200
```

### 访问地址

| 服务 | 地址 |
|------|------|
| 后端 API | http://localhost:8000 |
| API 文档 (Swagger) | http://localhost:8000/docs |
| 智能客服 | http://localhost:5173 |
| Agent 构建器 | http://localhost:8080 |
| 数据管理 | http://localhost:5200 |

### 基础设施面板

| 服务 | 地址 | 凭据 |
|------|------|------|
| pgAdmin | http://localhost:5050 | admin@agentforge.io / admin |
| Jaeger UI | http://localhost:16686 | — |
| Langfuse | http://localhost:3000 | — |
| MinIO Console | http://localhost:9001 | minioadmin / minioadmin |
| Neo4j Browser | http://localhost:7474 | neo4j / agentforge123 |

## 常用命令

```bash
# 开发
pnpm dev                  # 启动全部服务
pnpm server:worker        # 单独启动 BullMQ Worker

# 数据库
pnpm db:studio            # Prisma Studio → http://localhost:5555
pnpm db:seed              # 填充种子数据

# 质量
pnpm lint                 # 全量 Lint
pnpm typecheck            # 全量类型检查
pnpm test                 # 全量测试

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
| [架构概览](docs/architecture/overview.md) | 数据流、包布局、版本路线图 |
| [Agent Runtime](docs/runtime/execution-runtime-v1.md) | AgentExecutor、Router、KnowledgeContextBuilder |
| [类型安全规范](docs/engineering/type-safety.md) | Zod 校验、Prisma 类型推导、禁止 `any` |
| [中文 Prompt 规范](docs/engineering/chinese-prompts.md) | 所有 LLM 对话 Prompt 使用中文 |
| [开发指南](docs/operations/development.md) | 本地开发工作流 |
| [Pipeline 流程](docs/agents/pipeline.md) | Architect → Review → Implementation → Compliance → Code Review |
