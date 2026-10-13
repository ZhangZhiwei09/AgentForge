# AgentForge

AgentForge 是一个面向企业故障排查的 AI 诊断工作台，围绕问题诊断、知识证据和流程配置构建。
当前诊断样例聚焦核身与身份认证场景；接入其他场景需要准备相应知识、工具和流程。

项目提供可运行的前端、API、知识库检索和 Agent Runtime，但不是托管服务。使用时需要自行配置 LLM API、数据库以及业务知识数据。

## 核心能力

- **诊断对话**：流式展示排查过程、知识引用和诊断结果，支持信息补充、工具调用与人工审批。
- **知识与质量**：管理文档和分块，使用向量与关键词混合检索，通过命中测试和检索回归检查质量；用户反馈集中在知识库入口。
- **Agent 流程**：统一管理一级路由流程与诊断流程，支持草稿、发布、激活、试运行和运行记录。

文档解析保留文本、PDF、Word（DOCX）与图片。Langfuse 通过管理端外部链接打开，后端继续提供追踪、指标与结构化日志。

项目的展示重点是可检查的诊断证据、可回归的检索质量以及可复现的流程版本。当前没有附带真实业务数据或经过验证的生产性能指标。

## 运行结构

| 模块                                    | 技术                                | 职责                                                |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `apps/customer-service`                 | React / TypeScript / Vite           | 诊断对话与证据展示                                  |
| `apps/data-admin`                       | React / TypeScript / Vite           | 知识库、反馈与统一流程管理                          |
| `apps/server-py`                        | Python / FastAPI / SQLAlchemy / ARQ | 公共 API、认证、知识库、Agent Runtime 与摄取 worker |
| `packages/sdk`、`packages/shared-types` | TypeScript                          | 前端 API 客户端与接口类型                           |
| `packages/ui`、`packages/cui`           | React / TypeScript                  | 共享界面与对话组件                                  |

后端迁移已完成：API、Agent Runtime、摄取 worker、数据库迁移与管理脚本全部使用 Python。
原 TS 后端源码、BullMQ worker 和 Prisma 客户端及运行工具已移除，后端 Docker 镜像无需 Node.js。

前端、共享组件、客户端 SDK 和浏览器测试继续使用 TS/TSX。Node.js 用于前端开发、构建、
浏览器测试及本地开发启动编排；`pnpm` 中的后端命令会调用 Python。完整项目开发仍需要 Node.js。

`packages/database/prisma` 保留历史 schema 和 SQL 迁移，用于旧数据库兼容验证；
当前数据模型与迁移位于 `apps/server-py/src/models` 和 `apps/server-py/alembic`。
已有环境配置、上传文件和日志继续保留。旧安装可能仍有未纳入 Git 的 `dist`、
`node_modules` 或构建缓存，这些不属于当前后端源码。

## 快速开始

下面的路径启动诊断前端、管理端和一个 Python 后端。

### 环境要求

- Node.js 20+ 与 pnpm 9+：前端开发、构建与浏览器测试
- Python 3.12+ 与 uv：API、worker 与数据库工具
- Docker Desktop：启动本地 PostgreSQL、Redis 等依赖服务
- 一个可用的 OpenAI 兼容 LLM API Key

### 1. 安装依赖

```bash
pnpm install
cd apps/server-py
uv sync --locked
cd ../..
```

### 2. 配置环境变量

macOS / Linux：

```bash
cp .env.example apps/server-py/.env
```

PowerShell：

```powershell
Copy-Item .env.example apps/server-py/.env
```

首次安装时创建并编辑 `apps/server-py/.env`；已有配置不要覆盖。至少配置：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

确认 `DATABASE_URL` 指向本地 PostgreSQL。默认 Docker 配置使用 `5434` 端口。

配置优先级为进程环境、Python `.env`、根 `.env`、旧 `apps/server/.env`。
旧环境文件仅作兼容回退，不需要 Node API。数据库初始化和升级也全部由 Python 完成。

管理端追踪链接默认指向 `http://localhost:3000`；需要修改时，在 `apps/data-admin/.env.local` 设置 `VITE_LANGFUSE_URL`。

### 3. 启动依赖服务

```bash
pnpm infra:up
# 可选检索服务
docker compose -f infra/docker/docker-compose.yml --profile search up -d ollama elasticsearch
```

### 4. 初始化数据库

```bash
pnpm db:migrate
pnpm db:check
pnpm db:admin --email admin@agentforge.local
```

### 5. 启动 API 和前端

```bash
pnpm dev
```

启动完成后访问：

- 诊断前端：<http://localhost:5173>
- 管理端：<http://localhost:5200>
- API 健康检查：<http://localhost:8000/api/health>
- Python OpenAPI：<http://localhost:8000/docs>

在诊断页面输入问题即可开始对话，知识库和流程管理需要登录。首次使用知识库检索时，还需要准备 Embedding 模型或配置兼容的 Embedding 服务。
现有向量为 1024 维；OpenAI text-embedding-3 模型会显式请求 1024 维，
其他兼容服务也需返回 1024 维。异步摄取需开启 `INGESTION_ASYNC_ENABLED=true`
并单独运行 `pnpm server:worker`。`pnpm dev:agent-flows` 可自动选择空闲端口启动两端工作台。

### 仅运行 Python 后端

数据库、Redis 与环境变量准备好后，可直接使用 Python 工具链：

```bash
cd apps/server-py
uv sync --locked
uv run python -m src.database upgrade
uv run python -m src.database check
uv run python -m src.dev
```

启用异步摄取时，在另一个终端从 `apps/server-py` 运行 `uv run python -m src.worker`。
后端运行无需安装 Node.js 或 pnpm；更多后端配置见 [Python 后端说明](apps/server-py/README.md)。

## 验证重点

```bash
pnpm typecheck
pnpm py:test
# 先启动管理端；测试使用模拟 API
pnpm --filter @agentforge/data-admin test:e2e:workbench
```

浏览器测试默认连接 `http://localhost:5201`；使用默认管理端端口时，将 `AGENT_FLOW_ADMIN_URL` 设置为 `http://localhost:5200`。
真实浏览器验收使用独立 `agentforge_test_*` 数据库和 Python 数据夹具，配置方法见开发指南。

检索质量应使用固定测试集比较命中率与排序指标；诊断质量应结合固定故障案例检查结论和证据，再记录时延与成本。仓库包含检索回归接口与自动化测试，尚未提供统一的诊断基准报告。

## 深入文档

- [开发指南](docs/operations/development.md)：完整的本地开发流程和质量检查
- [Python 后端说明](apps/server-py/README.md)：当前 API、Agent Runtime、知识摄取与 worker
- [架构与路由](docs/architecture/routing.md)：当前 Python 请求分类和 Agent 分发
- [Agent Runtime 历史设计](docs/runtime/execution-runtime-v1.md)：原 TS 执行器设计，文中路径为历史引用
- [知识混合检索历史设计](docs/architecture/knowledge-hybrid-retrieval.md)：原 TS 检索设计与算法说明，当前实现见 Python 后端说明
- [部署手册](docs/operations/deployment.md)：生产环境部署
- [备份与恢复](docs/operations/backup-restore.md)：数据库备份和恢复

## 项目状态

AgentForge 当前处于实验阶段，接口、数据模型和运行方式可能发生变化。生产使用前请根据实际业务补充认证、权限、数据隔离、监控和部署配置。

## 许可证

当前仓库未包含 `LICENSE` 文件，许可证尚未声明。公开分发或商用前，请先确认项目授权方式。
