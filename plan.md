# AgentForge - Phase 1 Foundation（V1）

## 一、项目定位

AgentForge 是一个渐进式演化的 AI Agent 平台项目。

项目不会直接构建 Browser Agent 或 Multi-Agent 系统，而是按照真实产品演进路径逐步迭代：

```text
V1 ChatGPT Clone      ✅
↓
V2 Memory System      ✅
↓
V3 RAG System         ✅
↓
V4 Tool Calling       ✅
↓
P0 Platform Foundation  ✅ 认证 / 测试 / 日志 / CI
↓
P1 Agent Kernel         🔄 推理 / 规划 / 工作内存 (P1-3 ✅ P1-4 ✅ P1-6 ✅, P1-1/P1-2/P1-5 pending)
↓
V5 Voice Agent
↓
V6 Workflow Engine
↓
V9 Multi-Agent
↓
V10 MCP Ecosystem
```

V1 的目标并不是实现一个简单聊天机器人，而是搭建未来所有 Agent 能力的基础设施。

---

# 二、阶段目标

完成一个具备生产级架构的 ChatGPT Clone。

实现：

* 多轮会话
* 消息持久化
* 流式输出
* 模型切换
* Prompt 管理
* Provider 抽象
* Debug 面板
* Monorepo 基础设施

已完成：

* Memory（V2 ✅）
* RAG（V3 ✅）

未来新增：

* Tool Calling
* Voice
* Workflow Engine
* Browser Agent
* MCP Ecosystem

无需推翻现有架构。

---

# 三、技术栈

## Monorepo

* Turborepo
* pnpm workspace

职责：

* 项目统一管理
* 共享代码
* 增量构建
* 多应用协同开发

---

## Frontend

### Framework

* React 19
* TypeScript
* Vite

### UI

* TailwindCSS
* shadcn/ui

### State

* Zustand
* TanStack Query

### Rendering

* react-markdown
* remark
* rehype

### Streaming

* Fetch Stream
* ReadableStream

---

## Backend

### Framework

* TypeScript
* Node.js 20+
* Hono 4

### ORM

* Prisma 6

### Validation

* Zod

### Migration

* Prisma Migrate

---

## Database

### PostgreSQL

* 端口 5434（避免与其他服务冲突）
* Milvus 向量数据库（Docker 部署，端口 19530）

负责：

* User
* Conversation
* Message
* Memory（元数据 + 向量）
* KnowledgeBase / KnowledgeDocument / KnowledgeChunk（RAG 知识库）

存储

---

## LLM Layer

第一阶段支持：

* OpenAI
* DeepSeek

统一通过 Provider Layer 调用。

---

# 四、Monorepo 结构

```text
AgentForge/

apps/
├── web/          ← React 前端（端口 5173）
└── server/       ← TypeScript Hono 后端（端口 8000）

packages/
├── shared-types/   ← 共享 TypeScript 类型
├── shared-prompts/ ← Prompt 管理中心
├── database/       ← Prisma Schema + Client 单例
└── sdk/            ← API 客户端 + SSE 流解析

infra/
└── docker/         ← PostgreSQL + pgAdmin + Milvus + MinIO + etcd

docs/
```

---

## apps/web

React Web 应用。

职责：

* Chat UI
* Conversation UI
* Debug Panel
* Streaming Render

---

## apps/server

TypeScript Hono 服务。

职责：

* Chat API（SSE 流式）
* Customer Chat API（匿名客服 + 知识库检索）
* Conversation API
* Message API
* Memory API
* Knowledge Base API

---

## packages/shared-types

共享类型定义。

例如：

```ts
ChatMessage
Conversation
User
ProviderInfo
```

前后端统一使用。

---

## packages/shared-prompts

Prompt 管理中心。

统一管理：

```text
system prompt
chat prompt
future planner prompt
future memory prompt
future tool prompt
```

避免 Prompt 散落在代码中。

---

## packages/sdk

API 客户端 SDK（TypeScript）。

提供：

```typescript
AgentForgeClient   // HTTP 请求封装
streamChat()       // SSE 流解析 → AsyncGenerator<ChatStreamChunk>
```

前端通过 SDK 调用后端，不直接 fetch。

---

# 五、系统架构

```text
┌─────────────────────┐
│      React Web      │
└──────────┬──────────┘
           │ SSE / HTTP
           ▼
┌─────────────────────┐
│    Hono (TS Node)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    Provider Layer   │
└──────────┬──────────┘
           │
           ▼
 ┌─────────┼─────────┐
 ▼                    ▼
OpenAI           DeepSeek
           │
           ▼
┌─────────────────────┐
│  PostgreSQL + Milvus │
└─────────────────────┘
```

---

# 六、数据库设计

## users

```sql
id
email
created_at
updated_at
```

---

## conversations

```sql
id
title
user_id
created_at
updated_at
```

---

## messages

```sql
id
conversation_id
role
content
model
created_at
```

---

# 七、Provider 抽象设计

禁止在业务代码中直接调用 OpenAI SDK。

统一使用：

```typescript
interface LLMProvider {
  streamChat(
    messages: { role: string; content: string }[],
    model: string,
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk>;
}
```

实现：

```typescript
OpenAIProvider
DeepSeekProvider
AzureProvider
```

未来扩展无需修改业务逻辑。

---

# 八、API 设计

## 创建会话

```http
POST /api/conversations
```

---

## 获取会话列表

```http
GET /api/conversations
```

---

## 获取会话消息

```http
GET /api/conversations/{id}/messages
```

---

## 聊天接口

```http
POST /api/chat
```

返回：

```text
text/event-stream
```

支持流式输出。

---

# 九、前端页面设计

整体布局：

```text
┌────────┬───────────────────────┬──────────────┐
│        │                       │              │
│ 会话列表 │      聊天区域          │ Debug Panel │
│        │                       │              │
└────────┴───────────────────────┴──────────────┘
```

---

## 会话列表

功能：

* 创建会话
* 切换会话
* 删除会话

---

## 聊天区域

功能：

* 用户消息
* AI消息
* Markdown渲染
* 代码高亮
* Streaming渲染

---

## Debug Panel

展示：

```text
当前模型
Prompt
Token数量
Latency
响应时间
```

未来：

```text
Memory
Tool
Workflow
Agent State
```

也在此扩展。

---

# 十、流式架构设计

采用：

```text
Frontend
↓
Fetch Stream
↓
Hono (SSE)
↓
Provider
↓
LLM
```

实现 Token 级输出。

禁止等待完整结果返回后一次性渲染。

目标：

* 首 Token 快速响应
* 类 ChatGPT 用户体验

---

# 十一、V1 验收标准

完成以下能力即视为 V1 完成：

✅ Monorepo 架构搭建完成

✅ React + Hono 通信完成

✅ PostgreSQL 持久化完成

✅ Conversation 管理完成

✅ Message 管理完成

✅ OpenAI Provider 完成

✅ DeepSeek Provider 完成

✅ Streaming Chat 完成

✅ Markdown 渲染完成

✅ Debug Panel 完成

✅ Prompt 管理体系完成

✅ Shared Types 完成

✅ SDK 客户端完成

---

# 十二、V2 Memory System

## 1. 核心目标

在 V1 Chat 之上叠加长期记忆系统，让 AI 能够跨会话记住用户信息。

关键能力：

* 自动提取：每轮对话后 LLM 自动判断并提取关键信息
* 语义检索：对话前根据用户问题检索相关记忆，注入上下文
* 向量存储：Milvus 存储文本 Embedding，支持语义相似搜索
* 元数据管理：PostgreSQL 存储记忆元数据（类型、重要性、时间）
* 记忆面板：前端可视化查看、搜索、删除记忆

---

## 2. 系统架构

```text
┌─────────────────────────────────────┐
│             React Web               │
│  ┌──────────┬──────────┬──────────┐ │
│  │ 会话列表  │  聊天区域  │ 记忆面板  │ │
│  └──────────┴──────────┴──────────┘ │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│           Hono (TypeScript)          │
│  ┌──────────┬──────────┬──────────┐ │
│  │ Chat API │ Mem API  │Provider  │ │
│  │          │          │  Layer   │ │
│  └────┬─────┴────┬─────┴────┬─────┘ │
│       │          │          │       │
│  ┌────▼────┐ ┌───▼────┐     │       │
│  │Memory   │ │Memory  │     │       │
│  │Retriever│ │Extract │     │       │
│  └────┬────┘ └───┬────┘     │       │
│       │          │          │       │
└───────┼──────────┼──────────┼───────┘
        │          │          │
        ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐
   │Milvus  │ │Postgre │ │DeepSeek│
   │Vector  │ │  SQL   │ │OpenAI  │
   └────────┘ └────────┘ └────────┘
```

---

## 3. 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| 向量数据库 | Milvus Standalone (Docker) | 存储文本 Embedding，语义搜索 |
| 元数据存储 | PostgreSQL（已有） | 记忆 ID、类型、重要性等 |
| Embedding | DeepSeek / OpenAI API | 文本 → 向量 |
| 记忆提取 | LLM Prompt 工程 | 对话后自动提取关键事实 |

---

## 4. 数据模型

### memories (PostgreSQL)

```sql
id              UUID PRIMARY KEY
user_id         UUID → users(id)
type            ENUM('episodic', 'semantic', 'preference')
content         TEXT                    -- 记忆内容
importance      FLOAT DEFAULT 0.5      -- 重要性 0~1
embedding_id    BIGINT                 -- Milvus 向量 ID
metadata        JSONB DEFAULT '{}'     -- 扩展字段
conversation_id UUID → conversations(id) -- 来源会话
created_at      TIMESTAMP
updated_at      TIMESTAMP
```

### memory_embeddings (Milvus Collection)

```text
id              Int64 (Primary, Auto)
memory_id       VarChar
user_id         VarChar
embedding       FloatVector(1536)     -- 向量维度
content         VarChar               -- 冗余存储便于调试
```

---

## 5. Memory Engine 抽象

```typescript
class MemoryEngine {
  async store(memory: MemoryCreate): Promise<Memory>
    // 存储记忆到 PG + Milvus

  async search(query: string, userId: string, topK: number): Promise<Memory[]>
    // 语义搜索相关记忆

  async extractAndStore(messages: Message[], userId: string,
                        conversationId: string): Promise<Memory[]>
    // LLM 提取关键信息并存储

  async list(userId: string, type?: MemoryType): Promise<Memory[]>
    // 列出用户记忆

  async delete(memoryId: string): Promise<void>
    // 删除记忆
}
```

---

## 6. API 设计

### 语义搜索记忆

```http
GET /api/memories/search?q=用户名字&top_k=5
```

### 列出记忆

```http
GET /api/memories?type=preference
```

### 删除记忆

```http
DELETE /api/memories/{id}
```

---

## 7. Chat 集成流程

### 对话前 - 记忆注入

```text
用户发消息
    ↓
语义搜索相关记忆 (Milvus)
    ↓
将记忆拼接进 System Prompt: "关于用户你知道：..."
    ↓
LLM 生成回复（带有上下文）
```

### 对话后 - 记忆提取

```text
LLM 回复完成
    ↓
调用 MemoryEngine.extract_and_store()
    ↓
LLM 分析对话内容，判断是否有新信息
    ↓
有 → 提取结构化事实 → Embedding → 存入 Milvus + PostgreSQL
无 → 跳过（闲聊等无意义对话）
```

---

## 8. 前端设计

### 记忆面板

```text
┌──────────────────────────────┐
│  🔍 搜索记忆...              │
├──────────────────────────────┤
│  ┌─────────────────────────┐ │
│  │ 偏好: 用户喜欢 Python   │ │
│  │ 2024-01-15 · 重要性 0.8 │ │
│  │ [删除]                  │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │ 事实: 用户在创业         │ │
│  │ 2024-01-14 · 重要性 0.9 │ │
│  │ [删除]                  │ │
│  └─────────────────────────┘ │
└──────────────────────────────┘
```

模式切换：Debug Panel ↔ Memory Panel

---

## 9. V2 验收标准

完成以下能力即视为 V2 完成：

✅ Milvus 容器化部署完成

✅ Memory 数据模型 + 迁移完成

✅ Memory Engine 抽象层完成

✅ 语义搜索 API 完成

✅ 对话后自动记忆提取完成

✅ 对话前记忆注入上下文完成

✅ 前端记忆管理面板完成

✅ 记忆 Debug 信息展示完成

---

# 十三、V3 RAG 知识库系统（已完成 ✅）

V3 在 V2 Memory Engine 的向量检索能力基础上，扩展为完整的 RAG 知识库系统。

## 核心能力

* 文档管理：上传、删除、按知识库组织
* 文档摄取：自动切片 → Embedding → Milvus + PostgreSQL 双写
* 混合检索：dense 语义向量（0.6）+ BM25 关键词（0.4），可选 LLM Rerank
* 客服集成：`CustomerChatService` 自动搜索知识库，注入 system prompt
* 前端管理：知识库管理 UI + 搜索测试界面

## 数据模型

* `knowledge_bases` — 知识库（名称、描述、Embedding 模型）
* `knowledge_documents` — 文档（标题、类型、状态）
* `knowledge_chunks` — 切片（内容、序号、Embedding ID）

## 技术栈

* Milvus Hybrid Search（dense + sparse）
* `RecursiveCharacterTextSplitter` — 递归文本切分
* OpenAI `text-embedding-ada-002` → 1536 维向量

---

# 十四、V4 Tool Calling（已完成 ✅）

## 1. 核心目标

为 LLM 对话添加工具调用能力，让 AI 能够主动调用外部工具（计算器、时钟、搜索引擎等）来完成用户请求。

关键能力：

- Tool Registry：统一注册和管理所有可用工具
- 多轮工具调用：Server 端工具调用循环（最多 5 轮）
- SSE 流式协议：新增 `tool_call`、`tool_result` 事件类型
- 实时反馈：前端展示工具调用状态和结果
- Provider 透明：OpenAI 和 DeepSeek 均支持 Function Calling

## 2. 系统架构

```text
User: "123 * 456 = ?"
  ↓
ChatService (Tool Calling Loop)
  ↓
Provider.streamChat(messages, tools=[calculator])
  ↓
LLM → tool_call(name="calculator", args="{expression: '123*456'}")
  ↓
ToolRegistry.execute("calculator", args)
  ↓
Result: "56088"
  ↓
Feed back to LLM → "123 × 456 = 56,088"
  ↓
SSE Stream → Frontend
```

## 3. 数据流

```text
Meta Event:  tools_enabled: ["calculator", "get_current_time", "web_search"]
Tool Call:   tool_call: { id, name, arguments }
Tool Result: tool_result: { tool_call_id, name, result }
Tokens:      token (streaming text after tool results)
Done:        tool_calls_count: 1
```

## 4. 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| 工具注册 | ToolRegistry (Singleton) | 注册、查找、执行工具 |
| 内置工具 | get_current_time, calculator, web_search | MVP 基础工具集 |
| LLM 集成 | OpenAI Function Calling API | 工具定义传递和调用 |
| 执行循环 | ChatService Multi-Round | Server 端最多 5 轮循环 |

## 5. API 设计

### 查询可用工具

```http
GET /api/tools
```

### 发送带工具的消息

```http
POST /api/chat
Body: { "message": "...", "tools": ["calculator"] }
```

## 6. V4 验收标准

完成以下能力即视为 V4 完成：

✅ Tool Registry 设计完成

✅ 内置工具（get_current_time, calculator, web_search）实现完成

✅ Provider Layer 扩展（ChatMessage + Tools 参数）完成

✅ 多轮工具调用循环（Server 端最多 5 轮）完成

✅ SSE 流式协议扩展（tool_call, tool_result 事件）完成

✅ GET /api/tools 端点完成

✅ 前端工具调用展示（ToolCallBadge + DebugPanel Tools）完成

✅ 向后兼容（无 tools 参数时不发送工具定义）完成

✅ 自测验证通过（calculator 和 get_current_time 工具调用正常）


# 十五、P0 平台基础 —— 从 Demo 到可部署产品

> **定位说明：** P0/P1/P2 是平台工程阶段，与 V5-V10 的 Agent 能力演进并行推进。
> P0 聚焦"能让第二个用户使用"的最低平台门槛，P1 聚焦 Agent 内核，P2 聚焦生产运维。

## P0-1 认证与多用户系统

### 核心目标

从硬编码的单用户 `00000000-...-0001` 演进为支持真实多用户的认证体系。

### 架构设计

```text
┌────────────────────────────────────────────┐
│               Auth Middleware               │
│  ┌──────────┬──────────┬──────────────┐    │
│  │ JWT      │ API Key  │ OAuth 2.0    │    │
│  │ (Web UI) │ (API)    │ (GitHub/Gmail)│    │
│  └──────────┴──────────┴──────────────┘    │
│              ↓                              │
│  ┌──────────────────────────────────────┐  │
│  │        AuthService (Singleton)        │  │
│  │  - signUp / signIn / refreshToken    │  │
│  │  - validateToken / revokeToken       │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

### 数据模型扩展

```sql
-- users 表扩展
ALTER TABLE users ADD COLUMN password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500);
ALTER TABLE users ADD COLUMN role ENUM('admin', 'user', 'viewer') DEFAULT 'user';

-- 新增 refresh_tokens 表
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  token_hash  VARCHAR(255),
  expires_at  TIMESTAMP,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP
);

-- 新增 api_keys 表
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  name        VARCHAR(100),
  key_hash    VARCHAR(255),
  last_used   TIMESTAMP,
  expires_at  TIMESTAMP,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP
);
```

### API 设计

```http
POST   /api/auth/signup          # 注册
POST   /api/auth/signin          # 登录 → 返回 JWT + Refresh Token
POST   /api/auth/refresh         # 刷新 Access Token
POST   /api/auth/signout         # 登出
GET    /api/auth/me              # 获取当前用户信息

POST   /api/auth/api-keys        # 创建 API Key
GET    /api/auth/api-keys        # 列出 API Key
DELETE /api/auth/api-keys/:id    # 吊销 API Key
```

### Hono 中间件

```typescript
// apps/server/src/middleware/auth.ts
const authMiddleware = createMiddleware(async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "")
    ?? c.req.query("api_key");  // 也支持 query param 的 API Key

  if (!token) return c.json({ detail: "Unauthorized" }, 401);

  const user = await authService.validateToken(token);
  if (!user) return c.json({ detail: "Invalid or expired token" }, 401);

  c.set("user", user);  // 注入用户上下文
  await next();
});
```

### 验收标准

- [ ] 用户注册/登录 API 完成（JWT + bcrypt）
- [ ] Refresh Token 轮转机制完成
- [ ] API Key 管理完成（CRUD + 吊销）
- [ ] Auth 中间件注入用户上下文到所有路由
- [ ] 现有 API 全部迁移为 per-user 数据隔离（conversation/memory/knowledge 按 user_id 过滤）
- [ ] 前端登录/注册页面完成
- [ ] 前端 Auth 状态管理（Zustand store + 请求拦截器自动附带 Token）

---

## P0-2 结构化日志与链路追踪

### 核心目标

从 `console.log` 演进为结构化日志 + 请求级 Correlation ID，让每条请求的处理链路可追踪。

### 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| 日志库 | pino | 结构化 JSON 日志，极低开销 |
| 日志传输 | pino-pretty (dev) / pino/file (prod) | 开发时人类可读，生产时 JSON → 文件或 stdout |
| Correlation ID | Hono 中间件 + AsyncLocalStorage | 每个请求生成唯一 ID，贯穿所有日志 |
| 日志级别 | trace / debug / info / warn / error / fatal | 通过环境变量 `LOG_LEVEL` 控制 |

### 架构

```typescript
// packages/logger/src/index.ts  (新建共享包)
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "development"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
  mixin() {
    // 自动注入 correlationId
    const ctx = getRequestContext();
    return ctx ? { reqId: ctx.requestId, userId: ctx.userId } : {};
  },
});
```

### Hono 中间件集成

```typescript
// apps/server/src/middleware/request-id.ts
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-ID") || crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);  // 返回给前端便于问题定位
  await runWithRequestContext({ requestId }, next);
});
```

### 验收标准

- [ ] `packages/logger` 共享包创建完成（pino 封装）
- [ ] Request ID 中间件完成，自动注入到所有日志
- [ ] 关键路径日志替换完成：ChatService、MemoryEngine、KnowledgeService、ToolRegistry
- [ ] 日志级别分级：正常流 info，异常 warn/error，LLM 调用 debug
- [ ] 前端 Console 日志替换为分级日志（开发环境输出，生产环境抑制）

---

## P0-3 测试基础设施

### 核心目标

从零测试覆盖到核心路径有测试保护，建立测试文化和 CI 门禁。

### 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| 测试框架 | vitest | 与 Vite 生态一致，速度快 |
| 断言 | vitest 内置 expect | 无需额外断言库 |
| Mock | vitest + msw (Mock Service Worker) | Mock HTTP / Provider 层 |
| 数据库测试 | 测试用 PostgreSQL 实例 或 SQLite 替代 | 隔离的测试数据库 |
| E2E | Playwright | 浏览器端测试 |

### 测试分层

```text
┌─────────────────────────────────────────┐
│            E2E (Playwright)              │  ← 关键用户流程
│  登录 → 创建会话 → 发送消息 → 验证流式响应  │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         Integration Tests (vitest)       │  ← API 路由 + 数据库
│  POST /api/chat → 验证 SSE 响应结构       │
│  Tool Calling → 验证多轮循环              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│          Unit Tests (vitest)             │  ← 核心逻辑
│  ToolRegistry.execute()                 │
│  MemoryEngine.search()                  │
│  TextSplitter.split()                   │
│  Provider.streamChat() Mock             │
└─────────────────────────────────────────┘
```

### 优先测试清单

1. **ToolRegistry** — 注册、查找、执行、未知工具报错、参数解析失败
2. **ChatService** — 记忆注入、知识库注入、工具调用循环、最大轮数边界
3. **MemoryEngine** — 存储、搜索、提取、删除
4. **TextSplitter** — 各种文本长度和语言
5. **BM25** — 关键词搜索正确性
6. **API 路由** — 所有端点的正常和异常响应

### 验收标准

- [ ] vitest 配置完成，`pnpm test` 可运行
- [ ] `packages/database` 测试辅助工具（测试数据库初始化/清理）完成
- [ ] ToolRegistry 单元测试覆盖 ≥ 90%
- [ ] ChatService 集成测试覆盖核心流程（含 Mock Provider）
- [ ] MemoryEngine 集成测试覆盖 CRUD + 搜索
- [ ] API 路由测试覆盖所有端点（至少 happy path + 错误场景各 1 个）
- [ ] `pnpm test` 在 CI 中运行（见 P0-4）

---

## P0-4 CI/CD 流水线

### 核心目标

自动化构建、测试、类型检查、Lint，确保每次提交的质量门禁。

### GitHub Actions 流水线设计

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main, init, 'feature/**']
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: agentforge_test
        ports: ["5434:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck        # 全量类型检查
      - run: pnpm lint             # ESLint
      - run: pnpm format --check   # Prettier 格式检查
      - run: pnpm test             # vitest 测试
      - run: pnpm build            # 构建验证
```

### 流水线阶段

| 阶段 | 触发条件 | 操作 |
|------|----------|------|
| **Quality** | 每次 push/PR | typecheck → lint → format → test → build |
| **Preview Deploy** | PR 创建 | 部署到临时环境（后续可加） |
| **Release** | main 分支 tag push | 构建 Docker 镜像 → 推送到 Registry |

### 验收标准

- [ ] `.github/workflows/ci.yml` 创建并通过
- [ ] `pnpm typecheck` 全量通过
- [ ] `pnpm lint` 配置完成（ESLint flat config）
- [ ] `pnpm format --check` 配置完成（Prettier）
- [ ] `pnpm test` 在 CI 中通过
- [ ] PR 门禁：所有 Quality 检查必须通过才能合并

---

## P0-5 安全加固

### Rate Limiting

```typescript
// 使用 Hono 的 rate-limiter 或 hono-rate-limiter
// apps/server/src/middleware/rate-limit.ts
import { rateLimiter } from "hono-rate-limiter";

// 全局：每个 IP 每分钟最多 60 次请求
app.use("*", rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (c) => c.req.header("X-Forwarded-For") || "unknown",
}));

// Chat API：每个用户每分钟最多 20 次（防止 token 滥用）
app.use("/api/chat", rateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (c) => c.get("user")?.id || c.req.header("X-Forwarded-For"),
}));
```

### Input Validation

- 所有 API 路由使用 `@hono/zod-validator` 进行参数校验（已有部分，需全覆盖）
- Chat message 长度限制（如 16k 字符）
- Conversation title 长度限制
- 文件上传大小限制（知识库文档）
- SQL 注入防护：Prisma 参数化查询已覆盖，需审查原生 SQL（如有）

### Content Safety

- 可选的输入/输出内容过滤（接入 OpenAI Moderation API 或关键词过滤）
- System Prompt 注入防护：检测用户消息中是否包含"忽略上述指令"等 prompt injection 尝试

### 验收标准

- [ ] 全局 Rate Limiting 中间件完成
- [ ] Chat API 特殊 Rate Limiting 完成（更高优先级保护）
- [ ] 所有 POST/PUT/PATCH 路由有 Zod 参数校验
- [ ] 输入长度限制和特殊字符转义
- [ ] Rate Limit 超限时返回标准 `429 Too Many Requests` + Retry-After 头

---

## P1-1 后台任务队列

### 核心目标

将记忆提取、Embedding 生成等耗时操作从 Chat 请求的同步流中解耦，提升首 Token 响应速度。

### 架构

```text
Chat 请求
  ↓
LLM 流式响应完成
  ↓
发送消息到 Job Queue ────→ Worker 异步处理
  ↓                              ↓
立即返回 done 事件          MemoryEngine.extractAndStore()
  ↑                              ↓
前端收到完整响应             Milvus.insert() (非阻塞)
                              ↓
                            知识库文档摄取 (chunk → embed → store)
```

### 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| 消息队列 | BullMQ (Redis) | 可靠的任务队列，支持重试、延迟、优先级 |
| Worker | 独立 tsx 进程 | 消费队列任务 |
| Dashboard | Bull Board | 任务监控 UI |

### 数据流

```typescript
// apps/server/src/jobs/queue.ts
import { Queue } from "bullmq";

export const memoryQueue = new Queue("memory-extraction", {
  connection: { host: "localhost", port: 6379 },
});

export const ingestionQueue = new Queue("knowledge-ingestion", {
  connection: { host: "localhost", port: 6379 },
});

// 在 ChatService.streamChat() 的 done 事件后：
await memoryQueue.add("extract", {
  messages: [...],
  userId,
  conversationId,
  providerName,
}, {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: true,
});
```

### 验收标准

- [ ] Redis 容器添加到 `infra/docker/compose.yml`
- [ ] BullMQ 队列创建完成（memory-extraction + knowledge-ingestion）
- [ ] Worker 进程独立启动（`pnpm server:worker`）
- [ ] ChatService 中记忆提取改为异步投递
- [ ] 知识库文档摄取改为异步投递
- [ ] Bull Board 监控面板集成到 Debug Panel
- [ ] 向后兼容：Worker 不可用时不影响 Chat 主流程（graceful degradation）

---

## P1-2 可观测性：Metrics + Tracing

### 核心目标

知道系统在干什么、有多快、哪里慢。

### Metrics（Prometheus 格式）

```typescript
// apps/server/src/observability/metrics.ts
// 关键指标：
// - http_requests_total{method, path, status}    ← 请求量
// - http_request_duration_ms{method, path}        ← 延迟分位数
// - chat_messages_total{provider, model}          ← LLM 调用量
// - chat_tokens_total{provider, type}             ← Token 消耗（prompt/completion）
// - tool_calls_total{tool_name, status}           ← 工具调用量/成功率
// - memory_extractions_total                      ← 记忆提取量
// - milvus_search_duration_ms                     ← 向量搜索延迟
```

### Tracing（OpenTelemetry）

```typescript
// Chat 请求的全链路追踪：
// HTTP Request
//   ├── MemoryEngine.search()      ← span: 语义搜索
//   ├── KnowledgeService.search()  ← span: 知识库搜索
//   ├── LLM API Call (Round 1)     ← span: LLM 调用
//   │   └── ToolRegistry.execute() ← span: 工具执行
//   ├── LLM API Call (Round 2)     ← span: 第二轮
//   └── MemoryEngine.extract()     ← span: 记忆提取（或入队）
```

### 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| Metrics 库 | prom-client | Prometheus 指标采集 |
| Metrics 端点 | GET /api/metrics | Prometheus scrape |
| Tracing SDK | @opentelemetry/sdk-node | 分布式追踪 |
| Exporter | OTLP → Jaeger / Grafana Tempo | 追踪存储和可视化 |
| 仪表盘 | Grafana | 统一可视化 |

### 验收标准

- [ ] `GET /api/metrics` 端点完成，暴露 Prometheus 格式指标
- [ ] 核心指标埋点完成（HTTP、Chat、Tool、Memory）
- [ ] OpenTelemetry SDK 集成，自动插桩 HTTP + 手动插桩 Chat/Memory
- [ ] Jaeger 容器添加到 infra（可选，或直接用 Grafana Cloud 免费层）
- [ ] Grafana Dashboard JSON 模板创建

---

# 十六、P1 Agent 内核 —— 从 "Chatbot with Tools" 到 "Autonomous Agent"

> **定位说明：** V4 的 Tool Calling 是被动的——LLM 在单次调用中决定是否用工具。
> Agent 内核阶段将引入主动规划、自我反思、工作记忆，让系统从"响应指令"升级为"自主完成任务"。

## P1-3 Agent 推理框架

### 核心目标

引入 ReAct（Reasoning + Acting）模式，让 Agent 能够先思考再行动，观察结果后再思考。

### ReAct 循环设计

```text
┌─────────────────────────────────────────────────┐
│                  Agent Loop                      │
│                                                  │
│  ┌──────────┐     ┌──────────┐     ┌─────────┐ │
│  │ THINK    │ ──→ │ ACT      │ ──→ │ OBSERVE │ │
│  │ 分析现状  │     │ 调用工具  │     │ 观察结果 │ │
│  │ 制定计划  │     │ 或回复    │     │ 评估进展 │ │
│  └──────────┘     └──────────┘     └─────────┘ │
│        ↑                                    │    │
│        └──────────── 循环 ─────────────────┘    │
│                                                  │
│  终止条件：                                       │
│  - Agent 决定 respond（任务完成）                  │
│  - 达到最大迭代次数（默认 10 轮）                    │
│  - Agent 决定 ask_user（需要澄清）                  │
└─────────────────────────────────────────────────┘
```

### 决策输出格式（Structured Decision）

替代自由文本，Agent 每轮输出结构化决策：

```typescript
// packages/shared-types/src/agent-decision.ts
type AgentDecision =
  | { action: "tool_call"; tool: string; args: Record<string, unknown>; reason: string }
  | { action: "respond"; content: string; summary: string }
  | { action: "ask_user"; question: string; context: string }
  | { action: "delegate"; agent: string; task: string; context: string };  // V9 Multi-Agent
```

### System Prompt 模板（ReAct 风格）

```text
You are an AI Agent with access to tools. For each step, you MUST output a JSON decision:

{
  "observation": "What I see right now...",
  "analysis": "What this means and what I need to do...",
  "plan": "Step 1: ..., Step 2: ...",
  "decision": { "action": "tool_call" | "respond" | "ask_user", ... }
}

Rules:
1. ALWAYS think before acting — fill observation/analysis/plan first
2. If you have enough information to answer, respond directly
3. If you're unsure, ask the user instead of guessing
4. Break complex tasks into smaller steps
```

### AgentService 设计

```typescript
// apps/server/src/services/agent.ts
class AgentService {
  async *run(
    conversationId: string,
    task: string,
    options: {
      model?: string;
      maxIterations?: number;
      tools?: string[];
      requireApproval?: boolean;  // P1-5 Human-in-the-loop
    }
  ): AsyncGenerator<AgentStreamEvent> {
    let iteration = 0;
    const scratchpad: AgentStep[] = [];  // 工作内存

    while (iteration < (options.maxIterations || 10)) {
      // 1. 构建上下文（system prompt + scratchpad + task）
      // 2. 调用 LLM 获取结构化决策
      // 3. 根据决策执行：
      //    - tool_call → 执行工具 → 记录到 scratchpad → 继续
      //    - respond → 流式输出文本 → 结束
      //    - ask_user → 暂停等待用户输入 → 继续
      // 4. yield AgentStreamEvent
      iteration++;
    }
  }
}
```

### 验收标准

- [ ] AgentService 实现完成，支持 ReAct 循环
- [ ] 结构化决策 JSON 输出 + Zod 校验
- [ ] System Prompt 模板注册到 `shared-prompts`
- [ ] 前端流式渲染适配 Agent 事件类型（think/act/observe/respond）
- [ ] Debug Panel 展示 Agent 推理步骤（observation → analysis → plan → decision）
- [ ] 向后兼容：无 tools 参数时回退到普通 Chat 模式

---

## P1-4 Agent 工作内存 + 任务 Scratchpad

### 核心目标

不同于 V2 的长期记忆（跨会话），Agent 需要一个当前任务的 scratchpad：
- 存储中间推理步骤
- 存储工具调用的中间结果
- 任务完成后可归档为长期记忆或丢弃

### 数据模型

```sql
-- agent_sessions 表
CREATE TABLE agent_sessions (
  id              UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  task            TEXT NOT NULL,               -- 用户最初的任务描述
  status          ENUM('running', 'paused', 'completed', 'failed') DEFAULT 'running',
  scratchpad      JSONB DEFAULT '[]',          -- 中间步骤记录
  final_summary   TEXT,                        -- 任务完成后的总结
  started_at      TIMESTAMP,
  completed_at    TIMESTAMP
);

-- scratchpad 条目结构 (JSONB)
[
  {
    "step": 1,
    "observation": "...",
    "analysis": "...",
    "plan": "...",
    "decision": { "action": "tool_call", ... },
    "result": "...",
    "timestamp": "..."
  },
  ...
]
```

### 工作内存生命周期

```text
Task Start
  ↓
[Scratchpad 初始化]
  ↓
Step 1: observe → analyze → plan → act → result → append to scratchpad
  ↓
Step 2: observe (reads scratchpad[0..n-1]) → analyze → act → result → append
  ↓
...
  ↓
Task Complete
  ↓
[Optional] Archive to Long-term Memory (summary + key findings)
  ↓
[Scratchpad 可丢弃或保留 N 天用于审计]
```

### 验收标准

- [ ] `agent_sessions` 数据模型 + Prisma 迁移完成
- [ ] AgentService 每步自动追加 scratchpad
- [ ] 每轮推理时自动注入 scratchpad 到上下文
- [ ] API: `GET /api/agent-sessions` 列出历史 Agent 任务
- [ ] API: `GET /api/agent-sessions/:id` 查看任务详情和推理步骤
- [ ] 前端：Agent Session 面板展示推理链（类似 Debug Panel 的 Agent 视图）

---

## P1-5 Human-in-the-Loop 审批门

### 核心目标

对于高风险操作（发邮件、调用外部 API、修改数据、大额交易等），Agent 必须暂停并请求人类审批。

### 审批流程

```text
Agent 决定执行高风险工具
  ↓
暂停 Agent 循环
  ↓
SSE 事件: { type: "approval_request", tool: "send_email", args: {...} }
  ↓
前端展示审批卡片：[批准] [拒绝] [修改参数]
  ↓
用户操作 → POST /api/agent/approve 或 /reject
  ↓
Agent 循环恢复（继续执行 或 跳过该工具）
```

### 工具风险等级定义

```typescript
// tools/registry.ts 扩展
interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
  riskLevel: "safe" | "read_only" | "mutation" | "destructive";
  requireApproval: boolean;  // true = 必须审批
  approvalMessage?: (args: Record<string, unknown>) => string;  // 审批提示
}
```

### API 设计

```http
POST /api/agent/approval/:agent_session_id/:decision_id
Body: { "action": "approve" | "reject" | "modify", "modified_args": {...} }
```

### 验收标准

- [ ] 工具注册扩展 `riskLevel` 和 `requireApproval` 字段
- [ ] Agent 循环中的审批暂停/恢复机制
- [ ] SSE 协议扩展 `approval_request` / `approval_result` 事件
- [ ] 前端审批卡片 UI（显示工具名、参数、风险等级）
- [ ] 审批超时处理（默认 5 分钟无响应自动拒绝）
- [ ] 审批历史记录审计日志

---

## P1-6 工具生态深化

### 核心目标

从 3 个玩具级工具（time、calculator、web_search stub）扩展为具备实际生产力的工具集。

### 新增内置工具

| 工具 | 类别 | 描述 | 风险等级 |
|------|------|------|----------|
| `file_read` | 文件系统 | 读取指定路径的文件内容 | safe |
| `file_write` | 文件系统 | 写入内容到文件 | destructive |
| `file_search` | 文件系统 | 按文件名/内容搜索 | read_only |
| `code_execute` | 沙箱 | 在 Docker 沙箱中执行 Python/JS 代码 | mutation |
| `http_request` | 网络 | 发送 HTTP 请求（GET/POST） | mutation |
| `db_query` | 数据库 | 执行只读 SQL 查询 | read_only |
| `web_search` | 搜索 | 真实在线搜索（SerpAPI/Tavily） | read_only |
| `web_fetch` | 网络 | 抓取指定 URL 内容 | read_only |
| `send_email` | 通信 | 发送邮件（需审批） | destructive |
| `calendar_query` | 日程 | 查询日历事件 | read_only |
| `github_issue` | 集成 | 创建/查询 GitHub Issue | mutation |

### 工具执行沙箱

```text
┌─────────────────────────────────────┐
│         Tool Execution Sandbox       │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  Timeout (per-tool config)   │   │
│  │  - safe: 5s                  │   │
│  │  - read_only: 15s            │   │
│  │  - mutation: 30s             │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  Code Execution (Docker)     │   │
│  │  - Isolated container        │   │
│  │  - Network: none (default)   │   │
│  │  - Memory limit: 256MB       │   │
│  │  - CPU limit: 0.5 core       │   │
│  │  - Auto-destroy after 60s    │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  Circuit Breaker             │   │
│  │  - 5 consecutive failures →  │   │
│  │    pause tool for 60s        │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### 验收标准

- [ ] 工具注册扩展：`timeout`、`riskLevel`、`requireApproval`、`sandbox` 字段
- [ ] 至少 6 个新工具实现并注册
- [ ] Docker 沙箱集成完成（code_execute 工具）
- [ ] 工具超时机制完成（每个工具独立 timeout）
- [ ] 熔断器完成（连续失败自动暂停）
- [ ] Web Search 真实实现（SerpAPI 或 Tavily 集成）
- [ ] 工具执行指标记录（调用次数、成功率、平均延迟）


# 十七、V5 Voice Agent 语音交互

## 1. 核心目标

为 AgentForge 添加语音输入（ASR）和语音输出（TTS）能力，支持实时语音对话。

## 2. 系统架构

```text
┌───────────────────────────────────────────────────┐
│                   React Web                        │
│  ┌─────────────────────────────────────────────┐  │
│  │  Voice Panel                                 │  │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────┐ │  │
│  │  │ 麦克风按钮    │  │ 音频波形  │  │ 状态    │ │  │
│  │  │ (唤醒词检测)  │  │ (可视化)  │  │ (听/说) │ │  │
│  │  └─────────────┘  └──────────┘  └────────┘ │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────┬────────────────────────────┘
                       │ WebSocket (双向音频流)
                       ▼
┌───────────────────────────────────────────────────┐
│              Hono Server                           │
│  ┌────────────── ─┬──────────────────┬──────────┐ │
│  │  VoiceService  │   ChatService    │ Provider │ │
│  │  ┌───────────┐ │                  │  Layer   │ │
│  │  │ ASR Engine│ │  Agent Loop +   │          │ │
│  │  │ (Whisper) │ │  Tool Calling   │          │ │
│  │  ├───────────┤ │                  │          │ │
│  │  │ TTS Engine│ │                  │          │ │
│  │  │ (Edge TTS │ │                  │          │ │
│  │  │  / OpenAI)│ │                  │          │ │
│  │  └───────────┘ │                  │          │ │
│  └────────────────┴──────────────────┴──────────┘ │
└───────────────────────────────────────────────────┘
```

## 3. 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| ASR (语音识别) | OpenAI Whisper API | 高精度多语言语音转文字 |
| TTS (语音合成) | OpenAI TTS API / Edge TTS | 文字转语音，多种音色 |
| 实时通信 | WebSocket | 音频流双向传输（替代 HTTP SSE） |
| 音频采集 | MediaRecorder API (浏览器) | 前端麦克风采集 |
| 音频播放 | Web Audio API | 前端播放 TTS 音频流 |
| VAD (语音活动检测) | @ricky0123/vad-web | 检测用户是否在说话 |

## 4. 打断机制

```text
AI 正在说话 (TTS 播放中)
  ↓
用户开始说话 (VAD 检测到语音)
  ↓
前端发送 interrupt 信号 → WebSocket
  ↓
服务器停止当前 LLM 生成 → 中断 TTS → 切换到聆听模式
  ↓
处理用户新的语音输入
```

## 5. 数据模型扩展

```sql
-- voice_sessions 表
CREATE TABLE voice_sessions (
  id              UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  status          ENUM('active', 'ended') DEFAULT 'active',
  audio_duration  INT,                  -- 总音频时长（秒）
  asr_tokens      INT,                  -- 语音识别 token 数
  tts_tokens      INT,                  -- 语音合成字符数
  created_at      TIMESTAMP
);
```

## 6. API 设计

### WebSocket 端点

```text
WS /api/voice/stream
  → Client: { type: "audio", data: <base64 PCM> }
  ← Server: { type: "transcript", text: "用户说了什么" }
  ← Server: { type: "response_text", text: "AI 文本回复" }
  ← Server: { type: "audio", data: <base64 MP3> }
  ← Server: { type: "interrupted" }
  ← Server: { type: "done" }
```

### HTTP 端点（非实时备选）

```http
POST /api/voice/transcribe    # 上传音频 → 返回文字
POST /api/voice/synthesize    # 提交文字 → 返回音频
```

## 7. 验收标准

- [ ] WebSocket 端点 `/api/voice/stream` 完成
- [ ] ASR 集成完成（Whisper API，支持中英文）
- [ ] TTS 集成完成（至少 3 种音色可选）
- [ ] VAD 语音活动检测集成（前端）
- [ ] 打断机制完成（AI 说话时可被用户打断）
- [ ] 前端 Voice Panel 完成（麦克风按钮 + 波形可视化 + 状态指示）
- [ ] 向后兼容：文本聊天模式不受影响
- [ ] 语音对话历史可回看（自动保存 transcript）


# 十八、V6 Workflow Engine 工作流引擎

## 1. 核心目标

从单次 Agent 任务执行演进为多步骤、可编排、可恢复的工作流引擎。支持 DAG 编排、条件分支、并行执行、人工审批节点。

## 2. 系统架构

```text
┌─────────────────────────────────────────────────┐
│              Workflow Engine                     │
│                                                  │
│  ┌──────────┐    ┌──────────────┐               │
│  │ Workflow │───→│ DAG Executor │               │
│  │  Editor  │    │              │               │
│  │ (JSON    │    │ ┌──────────┐ │               │
│  │  DSL)    │    │ │ Scheduler│ │               │
│  └──────────┘    │ └────┬─────┘ │               │
│                  │      ↓       │               │
│  ┌──────────┐    │ ┌──────────┐ │               │
│  │ Workflow │    │ │ Parallel │ │               │
│  │ Templates│    │ │ Executor │ │               │
│  └──────────┘    │ └────┬─────┘ │               │
│                  │      ↓       │               │
│                  │ ┌──────────┐ │               │
│  ┌──────────┐    │ │ State    │ │               │
│  │ Checkpoint│←──│ │ Manager  │ │               │
│  │ & Resume │    │ └──────────┘ │               │
│  └──────────┘    └──────────────┘               │
└─────────────────────────────────────────────────┘
```

## 3. 工作流 DSL（JSON 格式）

```json
{
  "name": "Customer Onboarding",
  "version": "1.0",
  "variables": {
    "customer_name": { "type": "string", "required": true },
    "company_size": { "type": "number", "default": 1 }
  },
  "steps": [
    {
      "id": "greet",
      "type": "agent",
      "prompt": "Welcome {{customer_name}}! Generate a personalized greeting.",
      "model": "gpt-4o",
      "tools": ["get_current_time"],
      "timeout": 30
    },
    {
      "id": "decision",
      "type": "condition",
      "expression": "{{company_size}} > 50",
      "then": "enterprise_flow",
      "else": "smb_flow"
    },
    {
      "id": "enterprise_flow",
      "type": "parallel",
      "branches": [
        {
          "id": "check_slack",
          "type": "tool",
          "tool": "slack_invite",
          "args": { "email": "{{customer_email}}" },
          "require_approval": true
        },
        {
          "id": "create_ticket",
          "type": "tool",
          "tool": "jira_create",
          "args": { "project": "ONBOARD", "summary": "..." }
        }
      ]
    },
    {
      "id": "smb_flow",
      "type": "agent",
      "prompt": "Generate self-serve onboarding guide for a small team."
    },
    {
      "id": "summary",
      "type": "agent",
      "prompt": "Summarize the onboarding results. Steps taken: {{steps}}",
      "depends_on": ["enterprise_flow", "smb_flow"]
    }
  ]
}
```

## 4. 工作流状态机

```text
                    ┌──────────┐
                    │  Draft   │
                    └────┬─────┘
                         ↓
                    ┌──────────┐
                    │  Ready   │
                    └────┬─────┘
                         ↓
              ┌──────────────────────┐
              │      Running         │
              │  ┌────┐ ┌────┐ ┌──┐ │
              │  │Step│→│Step│→│..│ │
              │  └────┘ └────┘ └──┘ │
              └──┬──────┬──────┬────┘
                 ↓      ↓      ↓
            ┌──────┐ ┌──────┐ ┌────────┐
            │ Done │ │Paused│ │Failed  │
            └──────┘ └──┬───┘ └───┬────┘
                        ↓          ↓
                   ┌────────┐ ┌──────────┐
                   │Resumed │ │ Retrying │
                   └────────┘ └──────────┘
```

## 5. 检查点与恢复

```typescript
// 每个步骤完成后自动保存检查点
interface WorkflowCheckpoint {
  workflowId: string;
  completedSteps: string[];       // 已完成的步骤 ID
  currentStep: string | null;     // 正在执行的步骤 ID
  stepResults: Record<string, unknown>;  // 每个步骤的输出
  variables: Record<string, unknown>;    // 累积变量快照
  savedAt: Date;
}

// 恢复时从最近检查点继续
async function resumeWorkflow(workflowId: string): Promise<void> {
  const checkpoint = await loadCheckpoint(workflowId);
  // 从 checkpoint.currentStep 继续执行
  // 已完成步骤的结果从 checkpoint.stepResults 读取
}
```

## 6. 重试与超时策略

```typescript
interface StepConfig {
  retry: {
    maxAttempts: number;       // 最大重试次数（默认 3）
    backoff: "fixed" | "exponential" | "linear";
    initialDelay: number;      // 初始延迟（ms）
    maxDelay: number;          // 最大延迟（ms）
    retryOn: string[];         // 可重试的错误类型
  };
  timeout: number;             // 步骤超时（秒）
  onTimeout: "fail" | "skip" | "fallback";
  fallbackStep?: string;       // 超时后的回退步骤
}
```

## 7. 数据模型

```sql
-- workflows 表
CREATE TABLE workflows (
  id              UUID PRIMARY KEY,
  user_id         UUID REFERENCES users(id),
  name            VARCHAR(200),
  description     TEXT,
  definition      JSONB NOT NULL,          -- 工作流 DSL (JSON)
  version         INT DEFAULT 1,
  status          ENUM('draft', 'ready', 'archived') DEFAULT 'draft',
  created_at      TIMESTAMP,
  updated_at      TIMESTAMP
);

-- workflow_runs 表
CREATE TABLE workflow_runs (
  id              UUID PRIMARY KEY,
  workflow_id     UUID REFERENCES workflows(id),
  status          ENUM('running', 'paused', 'completed', 'failed', 'cancelled'),
  input           JSONB,                   -- 输入变量
  output          JSONB,                   -- 最终输出
  checkpoint      JSONB,                   -- 当前检查点
  started_at      TIMESTAMP,
  completed_at    TIMESTAMP
);

-- workflow_step_logs 表
CREATE TABLE workflow_step_logs (
  id              UUID PRIMARY KEY,
  run_id          UUID REFERENCES workflow_runs(id),
  step_id         VARCHAR(100),
  step_type       VARCHAR(50),
  status          ENUM('pending', 'running', 'completed', 'failed', 'skipped'),
  input           JSONB,
  output          JSONB,
  error           TEXT,
  retry_count     INT DEFAULT 0,
  duration_ms     INT,
  started_at      TIMESTAMP,
  completed_at    TIMESTAMP
);
```

## 8. API 设计

```http
POST   /api/workflows              # 创建工作流
GET    /api/workflows              # 列出工作流
GET    /api/workflows/:id          # 获取工作流详情（含 DSL）
PUT    /api/workflows/:id          # 更新工作流定义
DELETE /api/workflows/:id          # 删除工作流

POST   /api/workflows/:id/run      # 执行工作流
GET    /api/workflows/:id/runs     # 列出运行历史
GET    /api/workflows/runs/:run_id # 获取运行详情（含步骤日志）
POST   /api/workflows/runs/:run_id/pause   # 暂停
POST   /api/workflows/runs/:run_id/resume  # 恢复
POST   /api/workflows/runs/:run_id/cancel  # 取消

GET    /api/workflows/runs/:run_id/stream  # SSE 实时流（步骤执行事件）
```

## 9. 验收标准

- [ ] Workflow DSL 规范定义完成（JSON Schema）
- [ ] DAG 执行器完成（支持串行、并行、条件分支、依赖等待）
- [ ] 步骤类型：agent、tool、condition、parallel、human_approval
- [ ] 检查点自动保存 + 恢复机制完成
- [ ] 每步骤独立重试策略 + 超时处理
- [ ] 工作流 CRUD API 完成
- [ ] 工作流运行 SSE 实时流完成
- [ ] 前端：工作流编辑器（JSON 模式，初版可用代码编辑器）
- [ ] 前端：工作流运行监控面板（DAG 可视化 + 步骤日志）
- [ ] 至少 3 个内置工作流模板


# 十九、V9 Multi-Agent 多智能体协作

## 1. 核心目标

从单一 Agent 演进为多 Agent 协作系统。多个 Agent 各自承担不同角色，通过消息总线通信，协作完成复杂任务。

## 2. 角色模型

```text
┌─────────────────────────────────────────────────────────┐
│                    Multi-Agent System                     │
│                                                          │
│  ┌──────────────┐                                        │
│  │ Orchestrator │  ← 任务分解、分配、协调、汇总            │
│  └──────┬───────┘                                        │
│         │                                                │
│    ┌────┼────────┬────────────┬────────────┐             │
│    ↓    ↓        ↓            ↓            ↓             │
│  ┌────┐ ┌────┐ ┌──────┐ ┌────────┐ ┌──────────┐       │
│  │Plan│ │Exec│ │Review│ │Research│ │Specialist│  ...   │
│  │ner │ │utor│ │er    │ │er      │ │(Domain)  │       │
│  └────┘ └────┘ └──────┘ └────────┘ └──────────┘       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Message Bus (Shared Context)             │   │
│  │  - Agent → Agent 直接消息                          │   │
│  │  - Broadcast 广播                                  │   │
│  │  - Shared Memory 共享工作内存                       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 默认角色定义

| 角色 | 职责 | 工具权限 | 典型 Prompt |
|------|------|----------|-------------|
| **Planner** | 分析任务，制定执行计划，分解子任务 | 无工具（纯推理） | "Break this task into steps..." |
| **Executor** | 执行具体步骤，调用工具 | 全部工具 | "Execute step N: ..." |
| **Reviewer** | 审查执行结果，发现遗漏和错误 | 只读工具 | "Review the output for errors..." |
| **Researcher** | 信息搜集，网页搜索和分析 | search/fetch 工具 | "Research the topic: ..." |
| **Orchestrator** | 整体协调，决定何时委派给谁 | 委派工具 | "Decide who handles this..." |

## 3. Agent 间通信协议

```typescript
// 消息总线上的消息格式
interface AgentMessage {
  id: string;
  from: string;          // 发送 Agent 名称
  to: string | "broadcast";  // 接收方
  type: "task" | "result" | "question" | "feedback" | "handoff";
  payload: {
    task?: string;
    result?: unknown;
    question?: string;
    feedback?: { approved: boolean; comments: string };
    context?: Record<string, unknown>;
  };
  timestamp: Date;
  replyTo?: string;      // 回复的消息 ID
}
```

## 4. 协作模式

### 模式 1：Orchestrator 模式（层级式）
```
User Task → Orchestrator
              ├→ Planner (制定计划)
              ├→ Executor (执行步骤 1)
              ├→ Reviewer (审查步骤 1)
              ├→ Executor (执行步骤 2，含修正)
              └→ Orchestrator (汇总回复)
```

### 模式 2：Peer-to-Peer 模式（对等式）
```
Agent A (前端) ←→ Agent B (后端)
  "这个 API 怎么调？"  "需要 userId 参数"
  "明白了，在这改..."   "检查一下这里..."
```

### 模式 3：Debate 模式（辩论式）
```
Question → Agent A (Pro) + Agent B (Con) + Agent C (Judge)
              ↓                  ↓                ↓
           论证支持            论证反对          评估双方
              ↓                  ↓                ↓
              └──────────────────┴────────────────┘
                               ↓
                          Final Verdict
```

## 5. 数据模型

```sql
-- agent_teams 表
CREATE TABLE agent_teams (
  id              UUID PRIMARY KEY,
  user_id         UUID REFERENCES users(id),
  name            VARCHAR(200),
  description     TEXT,
  agents          JSONB,              -- Agent 配置列表
  collaboration   ENUM('orchestrator', 'peer', 'debate') DEFAULT 'orchestrator',
  created_at      TIMESTAMP
);

-- agent_team_runs 表
CREATE TABLE agent_team_runs (
  id              UUID PRIMARY KEY,
  team_id         UUID REFERENCES agent_teams(id),
  task            TEXT,
  status          ENUM('running', 'completed', 'failed'),
  messages        JSONB DEFAULT '[]',  -- Agent 间通信记录
  result          TEXT,
  started_at      TIMESTAMP,
  completed_at    TIMESTAMP
);
```

## 6. 验收标准

- [ ] Multi-Agent 消息总线完成
- [ ] 5 个默认 Agent 角色实现完成（Planner/Executor/Reviewer/Researcher/Orchestrator）
- [ ] 3 种协作模式完成（Orchestrator / Peer / Debate）
- [ ] Agent Team CRUD API 完成
- [ ] Agent Team Run SSE 流（展示各 Agent 的思考过程）
- [ ] 前端：Multi-Agent 可视化面板（Agent 卡片 + 消息流）
- [ ] 复杂任务 demo 验证（如：研究一个主题 → 写报告 → 审查修改）


# 二十、V10 MCP Ecosystem Model Context Protocol

## 1. 核心目标

实现 MCP (Model Context Protocol) 的 Client 和 Server 两端，让 AgentForge 既能调用外部 MCP 工具，也能将自身能力暴露给其他 MCP Client。

## 2. 架构

```text
┌─────────────────────────────────────────────────────────┐
│                  AgentForge MCP Layer                     │
│                                                          │
│  ┌─────────────────────┐    ┌─────────────────────────┐ │
│  │   MCP Server        │    │    MCP Client            │ │
│  │                     │    │                          │ │
│  │  Expose:            │    │  Consume:                │ │
│  │  - Memory Search    │    │  - Filesystem Server     │ │
│  │  - Knowledge Search │    │  - GitHub Server         │ │
│  │  - Agent Execute    │    │  - Slack Server          │ │
│  │  - Tool Call        │    │  - Database Server       │ │
│  │                     │    │  - Custom MCP Servers    │ │
│  │  Protocol:          │    │                          │ │
│  │  - stdio            │    │  Protocol:               │ │
│  │  - SSE (HTTP)       │    │  - stdio (子进程)         │ │
│  │                     │    │  - SSE (远程)             │ │
│  └─────────────────────┘    └─────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           MCP Tool Registry                       │   │
│  │  - 动态发现：自动扫描 MCP Server 提供的工具        │   │
│  │  - 热加载：无需重启即可注册新 MCP 工具             │   │
│  │  - 命名空间：mcp/github/issues → github_issues     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 3. MCP Server 实现

暴露 AgentForge 核心能力为标准 MCP 工具：

```typescript
// AgentForge MCP Server 暴露的工具
const exposedTools = [
  {
    name: "agentforge_memory_search",
    description: "Search user's long-term memory for relevant facts",
    inputSchema: { query: "string", topK: "number" }
  },
  {
    name: "agentforge_knowledge_search",
    description: "Search knowledge base for reference documents",
    inputSchema: { query: "string", kbId: "string?", topK: "number" }
  },
  {
    name: "agentforge_agent_execute",
    description: "Execute an AI agent task with tool access",
    inputSchema: { task: "string", tools: "string[]?", model: "string?" }
  },
  {
    name: "agentforge_conversation_history",
    description: "Retrieve conversation history",
    inputSchema: { conversationId: "string", limit: "number" }
  },
];
```

## 4. MCP Client 实现

连接到外部 MCP Server 并自动注册其工具：

```typescript
// apps/server/src/mcp/client.ts
class MCPClientManager {
  private clients: Map<string, Client> = new Map();

  async connect(config: MCPServerConfig): Promise<void> {
    const client = new Client({ name: "agentforge", version: "1.0.0" });
    if (config.transport === "stdio") {
      // 启动子进程通信
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
      });
      await client.connect(transport);
    } else if (config.transport === "sse") {
      // HTTP SSE 通信
      const transport = new SSEClientTransport(new URL(config.url));
      await client.connect(transport);
    }

    // 列出 MCP Server 的工具并自动注册到 ToolRegistry
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      toolRegistry.registerMCPTool(config.name, tool);
    }

    this.clients.set(config.name, client);
  }
}
```

## 5. 工具命名空间

为避免冲突，MCP 工具使用命名空间前缀：

```text
内置工具:    calculator, get_current_time, web_search
MCP 工具:    mcp:github/create_issue, mcp:slack/send_message
AgentForge:  agentforge:memory/search, agentforge:agent/execute
```

## 6. 验收标准

- [ ] MCP Server 完成（暴露 AgentForge 核心能力为 MCP 工具）
- [ ] MCP Client 完成（连接外部 MCP Server，自动注册工具）
- [ ] stdio Transport 支持（子进程通信）
- [ ] SSE Transport 支持（HTTP 远程通信）
- [ ] 工具热加载：添加 MCP Server 配置后无需重启
- [ ] MCP Server 配置管理 API + 前端管理界面
- [ ] 至少 3 个 MCP Server 集成验证（如 filesystem、github、postgres）
- [ ] MCP 工具在 Debug Panel 中展示来源标注


# 二十一、持续演进 —— Beyond V10

V1-V10 完成后，AgentForge 已经是一个功能完备的 Agent 平台。以下是更高阶的演进方向：

## Agent 评估与基准测试

- **Eval Framework**：建立 Agent 评估框架（任务成功率、工具选择准确率、响应质量）
- **Benchmark 套件**：常见 Agent 任务基准测试集（WebArena、GAIA、SWE-bench 适配）
- **A/B 测试**：不同 Prompt、模型、工具配置的效果对比
- **回归测试**：每次变更后自动运行 Eval 套件，防止 Agent 能力退化

## Fine-tuning 管线

- **数据收集**：从用户反馈和人工修正中收集高质量训练数据
- **SFT 微调**：针对特定领域（客服、编程、写作）微调模型
- **RLHF/DPO**：基于人类偏好对齐 Agent 的决策行为
- **工具调用专项微调**：提升 Function Calling 的准确率和参数正确性

## 多模态 Agent

- **Vision**：支持图片理解和生成（GPT-4V / DALL-E）
- **Video**：视频内容分析和摘要
- **Audio**：语音之外的音乐、环境音理解
- **File**：PDF、Excel、PPT 等文件格式的深度解析

## 部署与运维

- **Docker Compose → Kubernetes**：生产级容器编排
- **Helm Chart**：一键部署到 K8s 集群
- **Horizontal Scaling**：后端水平扩展（无状态 + Redis 会话）
- **Database HA**：PostgreSQL 主从复制 + 自动故障转移
- **Multi-Region**：跨区域部署，降低 LLM API 延迟
- **Cost Tracking**：按用户/部门/项目维度的 Token 消耗账单

## 企业功能

- **SSO 集成**：SAML/OIDC 企业单点登录
- **Audit Log**：完整的操作审计日志（合规需求）
- **Data Retention**：数据保留策略和自动清理
- **Private Deployment**：VPC 内部署，数据不出企业网络
- **Custom Terms & Policies**：自定义使用条款和 AI 策略


# 二十二、执行路线图总览

## 优先级矩阵

```text
                    高影响
                      │
         P0-1 认证    │    P1-3 Agent 推理框架
         P0-2 日志    │    P1-4 工作内存
         P0-3 测试    │    P1-6 工具生态
         P0-4 CI/CD   │
         P0-5 安全    │    V6  Workflow Engine
                      │    V9  Multi-Agent
    ──────────────────┼──────────────────
         低紧急       │       高紧急
                      │
         P1-1 后台队列│
         P1-2 可观测  │    V5  Voice Agent
         P1-5 审批门  │    V10 MCP Ecosystem
                      │
                    低影响
```

## 建议执行顺序

| 批次 | 阶段 | 预估工期 | 关键产出 |
|------|------|----------|----------|
| **Batch 1** | P0-1 认证 + P0-2 日志 + P0-3 测试 | 2-3 周 | 多用户可以注册登录，结构化日志，vitest 测试套件 |
| **Batch 2** | P0-4 CI/CD + P0-5 安全加固 | 1 周 | GitHub Actions 流水线，Rate Limiting，参数校验 |
| **Batch 3** | P1-3 Agent 推理框架 + P1-4 工作内存 | 2 周 | ReAct 循环，Agent Scratchpad，本质从 chatbot → agent |
| **Batch 4** | P1-6 工具生态 + P1-5 审批门 | 2-3 周 | 6+ 个生产工具，代码沙箱，人工审批 |
| **Batch 5** | P1-1 后台队列 + P1-2 可观测性 | 1-2 周 | BullMQ 解耦，Prometheus + Grafana |
| **Batch 6** | V5 Voice Agent | 2 周 | WebSocket 音频流，ASR/TTS，打断机制 |
| **Batch 7** | V6 Workflow Engine | 3-4 周 | DAG 执行器，检查点恢复，工作流模板 |
| **Batch 8** | V9 Multi-Agent | 3-4 周 | 多角色 Agent，消息总线，协作模式 |
| **Batch 9** | V10 MCP Ecosystem | 2-3 周 | MCP Server/Client，工具热加载 |

> **总计预估：** 18-25 周（约 4-6 个月，1 人全职）。可根据实际人力并行推进。

---

## 健壮性说明

本文档中所有带 `✅` 标记的阶段表示已完成并通过自我验证。P0/P1/P2 和 V5-V10 阶段的验收标准均为待完成状态。每个阶段的验收标准设计为可独立验证——任意阶段完成后即可合并到 main 分支，不依赖后续阶段。
