# AgentForge

AgentForge 是一个面向企业知识问答、故障诊断和多 Agent 协作的全栈实验平台。
它适合希望在自己的数据和业务系统上构建 AI 助手、知识库和诊断工作流的开发者与团队。

项目提供可运行的前端、API、知识库检索和 Agent Runtime，但不是托管服务。使用时需要自行配置 LLM API、数据库以及业务知识数据。

## 能力

- **知识问答**：支持知识库管理、文档解析、分块、向量检索、关键词检索和引用展示。
- **故障诊断**：支持多 Agent 协作、信息补充、诊断过程展示和结果汇总。
- **Agent Runtime**：支持 ReAct 执行、工具调用、风险控制、审批和流式响应。
- **工作流编排**：支持 DAG 工作流、暂停、恢复、重试和人工介入。
- **可观测性**：支持 Langfuse、OpenTelemetry、Jaeger、Prometheus 和结构化日志。

文档解析目前覆盖文本、PDF、Word、图片和音频。项目当前不包含视频对话或视频解析模块，也不附带真实业务数据、生产监控数据源或第三方业务系统集成。

## 快速开始

下面是一条运行客服前端和 TypeScript API 的推荐路径。

### 环境要求

- Node.js 20+
- pnpm 9+
- Docker Desktop
- 一个可用的 OpenAI 兼容 LLM API Key

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

macOS / Linux：

```bash
cp .env.example apps/server/.env
cp .env.example packages/database/.env
```

PowerShell：

```powershell
Copy-Item .env.example apps/server/.env
Copy-Item .env.example packages/database/.env
```

编辑 `apps/server/.env`，至少配置：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

确认 `packages/database/.env` 中的 `DATABASE_URL` 指向本地 PostgreSQL。默认 Docker 配置使用 `5434` 端口。

### 3. 启动依赖服务

```bash
docker compose -f infra/docker/docker-compose.yml up -d db redis ollama elasticsearch
```

### 4. 初始化数据库

```bash
pnpm db:generate
pnpm db:migrate
```

### 5. 启动 API 和前端

分别打开两个终端：

```bash
pnpm server:dev
```

```bash
pnpm cs:dev
```

启动完成后访问：

- 客服前端：<http://localhost:5173>
- API 健康检查：<http://localhost:8000/api/health>

在客服页面输入问题即可开始对话。首次使用知识库检索时，还需要准备 Embedding 模型或配置 OpenAI 兼容的 Embedding 服务。

## 深入文档

- [开发指南](docs/operations/development.md)：完整的本地开发流程和质量检查
- [架构与路由](docs/architecture/routing.md)：请求分类和 Agent 分发
- [Agent Runtime](docs/runtime/execution-runtime-v1.md)：执行器和运行时模型
- [知识混合检索](docs/architecture/knowledge-hybrid-retrieval.md)：向量检索、BM25 和 RRF
- [部署手册](docs/operations/deployment.md)：生产环境部署
- [备份与恢复](docs/operations/backup-restore.md)：数据库备份和恢复

## 项目状态

AgentForge 当前处于实验阶段，接口、数据模型和运行方式可能发生变化。生产使用前请根据实际业务补充认证、权限、数据隔离、监控和部署配置。

## 许可证

当前仓库未包含 `LICENSE` 文件，许可证尚未声明。公开分发或商用前，请先确认项目授权方式。
