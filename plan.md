# AgentForge - Phase 1 Foundation（V1）

## 一、项目定位

AgentForge 是一个渐进式演化的 AI Agent 平台项目。

项目不会直接构建 Browser Agent 或 Multi-Agent 系统，而是按照真实产品演进路径逐步迭代：

```text
V1 ChatGPT Clone
↓
V2 Memory System
↓
V3 RAG System
↓
V4 Tool Calling
↓
V5 Voice Agent
↓
V6 Workflow Engine
↓
V7 Browser Extension
↓
V8 Browser Agent
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

未来新增：

* Memory
* RAG
* Voice
* Tool Calling
* Browser Agent

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

* Python
* FastAPI

### ORM

* SQLAlchemy

### Validation

* Pydantic

### Migration

* Alembic

---

## Database

### PostgreSQL

负责：

* User
* Conversation
* Message

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
agent-os/

apps/
├── web/
└── api/

packages/
├── shared-types/
├── shared-prompts/
└── sdk/

infra/
└── docker/

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

## apps/api

FastAPI 服务。

职责：

* Chat API
* SSE Stream
* Conversation API
* Message API

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

模型 SDK 抽象层。

提供：

```python
LLMProvider
```

统一调用接口。

---

# 五、系统架构

```text
┌─────────────────────┐
│      React Web      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│      FastAPI        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    Provider Layer   │
└──────────┬──────────┘
           │
           ▼
 ┌─────────┴─────────┐
 ▼                   ▼

OpenAI          DeepSeek

           │
           ▼

     PostgreSQL
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

```python
class LLMProvider:
    async def stream_chat():
        pass
```

实现：

```python
OpenAIProvider
DeepSeekProvider
```

未来扩展：

```python
QwenProvider
GeminiProvider
ClaudeProvider
```

无需修改业务逻辑。

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
FastAPI
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

✅ React + FastAPI 通信完成

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

---

# 十二、V2 预留能力

V1 必须提前预留以下扩展点：

```text
Memory Engine
RAG Engine
Tool Registry
Voice Engine
Workflow Engine
Browser Agent
```

V2 开始接入：

```text
PostgreSQL + Milvus
```

构建长期记忆系统。
