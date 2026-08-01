# 平台服务化拆分方案

> **状态：** 草案，Phase 1 暂不执行
> **日期：** 2026-07-10
> **范围：** 将 AgentForge 从单体 Server 演进为领域驱动的多服务架构，支持多个前端应用
>
> **✅ 已执行的独立决策**: 决策 #1 Neo4j 已移除、决策 #3 Orchestrator/Peer/Debate 已移除。各服务拆分（knowledge-worker、codegen-service、media-service）尚未执行。

---

## 一、问题陈述

### 1.1 当前状态

AgentForge 目前是一个单进程后端 (`apps/server`)，对 4 个前端：

```
apps/server (Hono, 单进程)
    ├── /api/agent/chat     → customer-service
    ├── /api/voice/*        → customer-service（前端未接）
    ├── /api/video/*        → customer-service（前端未接）
    ├── /api/projects/*     → app-creator
    ├── /api/knowledge/*    → data-admin
    ├── /api/workflows/*    → data-admin
    ├── /api/teams/*        → data-admin
    └── /api/auth/*         → 所有前端共用
```

### 1.2 识别到的具体问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | **资源特征混杂** — WebSocket 长连接 (voice/video) 和 HTTP 短请求 (chat) 共用一个进程，连接数、内存、并发模型互相干扰 | 扩容粒度粗，voice/video 的少量长连接可能阻塞 chat 的大量短请求 |
| 2 | **安全边界模糊** — Docker sandbox (codegen) 和核心 Agent 在同一进程，sandbox 逃逸风险直接影响 Auth/DB | 安全审计困难 |
| 3 | **依赖膨胀** — `apps/server/package.json` 有 40+ 依赖（pgvector + ES + Neo4j + MinIO + Redis + BullMQ + Docker + LangChain + OpenTelemetry + Langfuse...），包管理负担重 | CI 安装慢，依赖冲突风险高 |
| 4 | **领域耦合不彻底** — Video/Voice/Workflow/Team(3模式)/AppCreator 的代码都在 server 里，但它们跟 Agent Chat 主链路没有实际调用关系 | 代码理解成本高，新人会误以为它们都是核心路径 |
| 5 | **独立演进受限** — 想升级 ES 版本、换 Neo4j 驱动、改 voice 的 ASR 方案，全部要动同一个 server 的依赖树 | 变更风险集中 |
| 6 | **大量闲置代码** — Video/Voice 后端完整但前端没接；Neo4j 图谱提取了但搜索不查；Workflow 独立 API 但没融入 Chat；Team 3 种模式无人调用 | 维护负担 |

---

## 二、设计原则

### 2.1 不做什么

- ❌ **不拆成微服务** — 不引入服务网格、不引入分布式事务、不引入 API Gateway
- ❌ **不为一个前端拆一个后端** — 前端的边界不等于后端的边界
- ❌ **不一次性全拆** — 分阶段，每个阶段独立交付、独立验证
- ❌ **Agent Core 不动** — Auth → Router → AgentExecutor → ToolRegistry → KnowledgeSearch 是强耦合链路，拆开反而增加延迟和故障面

### 2.2 拆分维度

按**领域边界**和**资源特征**拆，不按前端拆：

| 维度 | 说明 |
|------|------|
| **资源特征不同** | WebSocket 长连接 vs HTTP 短请求；CPU 密集 (ingestion) vs IO 密集 (chat) |
| **安全隔离需要** | Docker sandbox 不应和 Auth/DB 同进程 |
| **独立生命周期** | Knowledge Ingestion 可以独立扩缩容，Media Service 可以在 GPU 节点部署 |
| **团队边界** | 如果有多个团队，核心 Agent 归平台组，业务场景归场景组 |

### 2.3 服务间通信

- **同一进程内**（Agent Core 内部）：直接函数调用，保持低延迟
- **跨服务同步调用**：HTTP REST（Hono RPC 模式），每种服务的 client 封装在 `@agentforge/sdk` 中
- **跨服务异步调用**：BullMQ（已有基础设施，复用）

---

## 三、目标架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend Apps                                │
│                                                                     │
│  customer-service    app-creator     data-admin    (future apps)    │
└──────────┬───────────────┬───────────────┬──────────────────────────┘
           │               │               │
           ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     @agentforge/sdk                                  │
│  统一 Client: auth, agent-chat, knowledge, voice, video, workflow   │
│  每种服务有独立的 client 子模块，SDK 负责服务发现和负载均衡            │
└─────────────────────────────────────────────────────────────────────┘
           │               │               │
           ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Agent Core (不动)                                │
│                                                                     │
│  apps/server                                                        │
│  ├── auth              (JWT + API Key)                              │
│  ├── agent-runtime     (Router → RouteAgents)                       │
│  ├── knowledge-search  (PGVector + ES 查询，不含 ingestion)          │
│  ├── tools             (ToolRegistry，含 search_knowledge_base)     │
│  ├── memory            (短期记忆 + 压缩 + 注入)                      │
│  └── modules/          (ServerModule 接口保留，供业务模块挂载)       │
│                                                                     │
│  依赖：PostgreSQL, Redis, Elasticsearch (查询)                       │
│  端口：8000                                                          │
│  特征：HTTP 短请求，低延迟，高并发                                    │
└──────────┬──────────────────────────────────────────────────────────┘
           │
           │  HTTP / BullMQ
           │
    ┌──────┴──────────────────────────────────────────────┐
    │                                                      │
    ▼                                                      ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│ Knowledge Worker          │    │ Codegen Service              │
│                           │    │                              │
│ apps/knowledge-worker     │    │ apps/codegen-service         │
│ ├── ingestion             │    │ ├── codegen (plan/gen/review)│
│ ├── embeddings            │    │ └── sandbox (Docker 隔离)    │
│ ├── elasticsearch (写入)  │    │                              │
│ ├── graph-extraction      │    │ 依赖：Docker                  │
│ └── regression-tests      │    │ 端口：8003                    │
│                           │    │ 特征：安全敏感，需隔离        │
│ 依赖：PostgreSQL, Neo4j   │    │                              │
│       ES, Ollama          │    └──────────────────────────────┘
│ 端口：8002                │
│ 特征：CPU/IO 密集，可异步  │
│ 已有基础：worker.ts       │
└──────────────────────────┘

┌──────────────────────────────┐
│ Media Service                 │
│                               │
│ apps/media-service            │
│ ├── voice (WS + ASR + TTS)    │
│ └── video (WS + Vision LLM)   │
│                               │
│ 依赖：Whisper, TTS API        │
│ 端口：8001                    │
│ 特征：WebSocket 长连接         │
│       GPU 节点可独立部署       │
└──────────────────────────────┘
```

### 3.1 各服务职责边界

| 服务 | 职责 | 不负责 |
|------|------|--------|
| **Agent Core** | 路由、ReAct执行、KB搜索、工具调用、记忆、Auth | 文档摄入、图谱提取、Docker沙箱、WebSocket媒体流 |
| **Knowledge Worker** | 文档解析→分块→embedding→ES索引→图谱提取→回归测试 | 在线搜索（那是 Core 的事） |
| **Media Service** | WebSocket 连接管理、ASR、TTS、Vision 帧处理 | Agent 逻辑（收到文本后调用 Core 的 `/api/agent/chat`） |
| **Codegen Service** | LLM规划→代码生成→审查→写文件，Docker沙箱执行 | 通用 Agent 任务（那是 Core 的事） |

### 3.2 跨服务调用关系

```
Media Service ──HTTP──→ Agent Core (/api/agent/chat)
                              │
                              │ BullMQ enqueue
                              ▼
                     Knowledge Worker (ingestion job)

Codegen Service ──独立 API──→ app-creator 前端（不经过 Core）

data-admin ──HTTP──→ Agent Core (knowledge search)
                 └──→ Knowledge Worker (上传文档触发 ingestion)
```

---

## 四、分阶段实施计划

### Phase 1：清理 + 减负（当前就可以做）

**目标：** 降低 server 认知负担，减少依赖，不引入新服务

| 步骤 | 内容 | 影响 |
|------|------|------|
| 1.1 | 删除 `voiceRoutes` + `videoRoutes` 的 app.ts 注册 | Voice/Video 代码保留但不在运行时加载 |
| 1.2 | 删除 `agent-runtime.ts` 中对 Voice/Video 的引用 | 确保编译通过 |
| 1.3 | 删除 Neo4j 依赖和 `graph-retrieval.ts` 的 server 引用（`graph-extraction.ts` 保留，将来归 Knowledge Worker） | 减一个数据库连接 |
| 1.4 | 将 `sandbox-tools` 和 `app-gen-tools` 从 ToolRegistry 中移除（保留代码） | Agent Chat 不再暴露 sandbox/代码生成工具 |
| 1.5 | 删除 BullMQ Memory Extraction Queue 的 Worker 注册（本来就没入队过任务） | 减一个无用 Worker |
| 1.6 | 将未使用的 Team 模式（Orchestrator/Peer/Debate）从 `TeamExecutor` 注册表中移除 | 保留代码，减少运行时初始化 |

**验证标准：**
- `pnpm typecheck` 通过
- `pnpm --filter @agentforge/server test` 通过
- server 启动日志中不再出现 Neo4j/Sandbox/Voice/Video 相关连接
- agent chat 功能不受影响

### Phase 2：Knowledge Worker 拆分（1-2周）

**目标：** 将文档摄入链路从 server 中完全拆出

这是最自然的拆分——你已经有 `worker.ts` 独立入口和 BullMQ 队列隔开它们。

| 步骤 | 内容 |
|------|------|
| 2.1 | 创建 `apps/knowledge-worker/` package，迁移以下模块：<br>- `knowledge-ingestion.ts`（文档解析→分块→embedding→索引）<br>- `elasticsearch.ts`（ES 索引管理，查询部分保留在 Core）<br>- `embeddings.ts`（Ollama/OpenAI embedding 调用）<br>- `graph-extraction.ts`（Neo4j 图谱提取）<br>- `document-parser/`、`document-normalizer/`、`text-splitter.ts`<br>- `reranker.ts`（精排模型）<br>- `storage/`（MinIO/本地存储）<br>- `knowledge-regression.ts`（回归测试） |
| 2.2 | Agent Core 中的 `KnowledgeService.search()` 保留（在线查询，不迁移） |
| 2.3 | Knowledge Worker 通过 BullMQ 接收 `{ docId, kbId }` 任务（已有队列，只改 worker 的 package 归属） |
| 2.4 | 从 Agent Core 的 `package.json` 移除：`neo4j-driver`, `@elastic/elasticsearch`, `mammoth`, `unpdf`, `minio`（查询用 ES 走 HTTP client 即可） |
| 2.5 | `@agentforge/sdk` 新增 `KnowledgeWorkerClient`，封装文档上传、摄入状态查询 API |

**验证标准：**
- Agent Chat 中 `search_knowledge_base` 工具正常返回结果
- data-admin 上传文档后，摄入流程正常完成（通过新的 Knowledge Worker）
- Agent Core 启动不依赖 Neo4j

### Phase 3：Codegen Service 拆分（1周）

**目标：** Docker sandbox 与 Agent Core 物理隔离

| 步骤 | 内容 |
|------|------|
| 3.1 | 创建 `apps/codegen-service/`，迁移 `services/codegen/`、`services/sandbox.ts`、`services/app-project.ts` |
| 3.2 | Codegen Service 通过 HTTP API 暴露：`POST /generate`、`GET /projects/:id` 等 |
| 3.3 | `app-creator` 前端直接请求 Codegen Service（不经过 Agent Core） |
| 3.4 | 从 Agent Core 的 `package.json` 移除 `dockerode` |
| 3.5 | `@agentforge/sdk` 新增 `CodegenClient` |

**验证标准：**
- app-creator 前端功能正常，可以创建项目、生成代码
- Agent Core 进程中没有 Docker socket 连接
- 安全审计：即使 sandbox 被攻破，也无法访问 Agent Core 的数据库

### Phase 4：Media Service 拆分（按需）

**目标：** 当决定启用 Video/Voice 前端时，再拆分

| 步骤 | 内容 |
|------|------|
| 4.1 | 创建 `apps/media-service/`，迁移 `services/voice.ts`、`services/video.ts`、`routes/voice.ts`、`routes/video.ts`、`services/audio-providers.ts`、`lib/audio-utils.ts` 及相关依赖 |
| 4.2 | Media Service 内部的 Agent 逻辑：收到 ASR 文本后，调用 Agent Core 的 `/api/agent/chat` 获取回复，再做 TTS 返回 |
| 4.3 | `@agentforge/sdk` 新增 `VoiceClient`、`VideoClient`，封装 WebSocket 连接 |
| 4.4 | customer-service 前端新增 Voice/Video UI 组件 |

**前置条件：** Phase 1 已清除了 server 中的 voice/video 注册

### Phase 5：Team 闲置模式清理

| 模块 | 决策 | 操作 |
|------|------|------|
| **Team (Orchestrator/Peer/Debate)** | 删除 | 仅保留 DiagnosisMode，其余 3 种模式 + API 端点删除 |
| **Workflow** | 保留不动 | 继续作为独立 API 存在，不融入 Chat |

---

## 五、共享基础设施

### 5.1 不拆的部分（所有服务共用）

| 组件 | 理由 |
|------|------|
| `packages/database` (Prisma Schema) | 单数据源，共享 Schema 是唯一真相源 |
| `packages/shared-types` | 类型定义，天然应该共享 |
| `packages/shared-prompts` | 中文 prompt 集中管理，便于审计和对齐 |
| `packages/logger` | 统一日志格式和 Correlation ID |
| `packages/sdk` | 统一前端 SDK，每个服务的 client 作为子模块 |
| `packages/ui` | 共享 UI 组件 |

### 5.2 Monorepo 结构演进

```
AgentForge/
├── apps/
│   ├── server/               # Agent Core（减负后）
│   ├── knowledge-worker/     # Phase 2 新建
│   ├── codegen-service/      # Phase 3 新建
│   ├── media-service/        # Phase 4 新建（按需）
│   ├── customer-service/     # 前端
│   ├── app-creator/          # 前端
│   └── data-admin/           # 前端
├── packages/
│   ├── database/             # Prisma Schema（共享）
│   ├── shared-types/         # 类型定义（共享）
│   ├── shared-prompts/       # Prompt 注册表（共享）
│   ├── sdk/                  # 统一前端 SDK（共享）
│   ├── logger/               # 结构化日志（共享）
│   └── ui/                   # UI 组件库（共享）
├── infra/
│   └── docker/
│       ├── docker-compose.yml        # 全量开发环境
│       └── docker-compose.core.yml   # 仅 Core + 依赖（日常开发用）
└── turbo.json
```

### 5.3 开发体验

```bash
# 日常开发（只启动 Core + 基础设施）
pnpm dev                  # turbo dev → server + 3 前端

# 需要 knowledge-worker 时
pnpm --filter @agentforge/knowledge-worker dev

# 需要 codegen 功能时
pnpm --filter @agentforge/codegen-service dev

# 全量启动
pnpm infra:up             # 所有基础设施
pnpm dev:all              # 所有服务
```

每个服务有自己的 `package.json`、`tsconfig.json`、`vitest.config.ts`、`.env`。共享的 Prisma Schema 通过 `@agentforge/database` 引用。

---

## 六、风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| SDK 中 client 模块的 API 不稳定 | 中 | 每个 client 先内部使用，标记 `@internal`，稳定后再公开 |
| Knowledge Worker 拆分导致 Prisma Schema 漂移 | 低 | Schema 仍然在 `packages/database` 单源管理，两个服务引用同一个 package |
| 跨服务 HTTP 调用增加延迟 | 低 | 当前的主要延迟在 LLM 调用（500ms-30s），跨服务 HTTP 延迟（<5ms 本地）可以忽略 |
| Media Service 的 Agent 逻辑重复 | 中 | Media Service 不实现 Agent 逻辑，只做 ASR/TTS，Agent 文本回复全部调用 Core 的 `/api/agent/chat` |
| Phase 后 Voice/Video 前端仍未实现 | 中 | Phase 4 的前置条件就是"前端需求确认"，不确定就不拆 |

---

## 七、决策记录

| # | 决策项 | 结论 | 日期 |
|---|--------|------|------|
| 1 | Neo4j 去留 | **删除**。图谱提取了但搜索从不查，纯维护负担 | 2026-07-10 |
| 2 | Workflow 去留 | **保留不动**。作为独立 API 继续存在，暂不融入 Chat | 2026-07-10 |
| 3 | Team 闲置模式 (Orchestrator/Peer/Debate) | **删除**。只有 Diagnosis 在用，其余三个无人调用 | 2026-07-10 |
| 4 | Phase 1 是否现在执行 | **暂不执行**。先确定完整方案，不写代码 | 2026-07-10 |

| 5 | ES 共享方式 | **Core 保留只读连接**。Worker 独占写入，Core 直接查询 ES，不经过 HTTP 中转 | 2026-07-10 |

---

## 八、与现有文档的关系

- 本方案是 `docs/architecture/routing.md` 所述 Agent Runtime 路由架构之上的演进版本
- 不影响 `docs/architecture/routing.md` 中描述的路由架构（Core 不动）
- 涉及 P0-P1 平台基础（Auth、Logging、Testing、CI/CD、Security、Jobs、Observability）— 均已完成
