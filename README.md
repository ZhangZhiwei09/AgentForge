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

| 模块 | 职责 |
| --- | --- |
| `apps/customer-service` | 诊断对话与证据展示 |
| `apps/data-admin` | 知识库、反馈与统一流程管理 |
| `apps/server` | TypeScript 公共 API、认证、知识摄取、Agent Runtime |
| `apps/server-py` | 配置式诊断流程执行，由 TypeScript API 转发调用 |

未激活配置式诊断流程时，默认诊断仍使用 TypeScript 内部 Team 执行器。独立通用 Workflow、公开 Team 管理 API 和旧悬浮客服已移除；历史数据库表保留。详细边界见[项目精简说明](docs/design/project-simplification.md)。

## 快速开始

下面的路径同时启动诊断前端、管理端和两个后端服务。

### 环境要求

- Node.js 20+
- pnpm 9+
- Python 3.12+ 与 uv
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

`pnpm py:dev` 会从 `apps/server/.env` 继承数据库、认证密钥和模型配置。TypeScript 通过 `AGENT_FLOW_BACKEND_URL` 访问 Python，默认地址为 `http://127.0.0.1:8004`。

管理端追踪链接默认指向 `http://localhost:3000`；需要修改时，在 `apps/data-admin/.env.local` 设置 `VITE_LANGFUSE_URL`。

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

```bash
pnpm dev
```

启动完成后访问：

- 诊断前端：<http://localhost:5173>
- 管理端：<http://localhost:5200>
- API 健康检查：<http://localhost:8000/api/health>
- Python 流程服务：<http://localhost:8004/docs>

在诊断页面输入问题即可开始对话，知识库和流程管理需要登录。首次使用知识库检索时，还需要准备 Embedding 模型或配置兼容的 Embedding 服务。

## 验证重点

```bash
pnpm typecheck
pnpm --filter @agentforge/server test
# 先启动管理端；测试使用模拟 API
pnpm --filter @agentforge/data-admin test:e2e:workbench
```

浏览器测试默认连接 `http://localhost:5201`；使用默认管理端端口时，将 `AGENT_FLOW_ADMIN_URL` 设置为 `http://localhost:5200`。

检索质量应使用固定测试集比较命中率与排序指标；诊断质量应结合固定故障案例检查结论和证据，再记录时延与成本。仓库包含检索回归接口与评测脚本，尚未提供统一的诊断基准报告。

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
