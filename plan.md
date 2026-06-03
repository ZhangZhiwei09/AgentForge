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
│              FastAPI                 │
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

```python
class MemoryEngine:
    async def store(memory: MemoryCreate) -> Memory
        """存储记忆到 PG + Milvus"""

    async def search(query: str, user_id: str, top_k: int) -> list[Memory]
        """语义搜索相关记忆"""

    async def extract_and_store(messages: list, user_id: str,
                                 conversation_id: str) -> list[Memory]
        """LLM 提取关键信息并存储"""

    async def list(user_id: str, type: str | None) -> list[Memory]
        """列出用户记忆"""

    async def delete(memory_id: str) -> None
        """删除记忆"""
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

☐ Milvus 容器化部署完成

☐ Memory 数据模型 + 迁移完成

☐ Memory Engine 抽象层完成

☐ 语义搜索 API 完成

☐ 对话后自动记忆提取完成

☐ 对话前记忆注入上下文完成

☐ 前端记忆管理面板完成

☐ 记忆 Debug 信息展示完成

---

# 十三、V3 预留能力

V2 必须提前预留以下扩展点：

```text
RAG Engine（复用 Memory Engine 的向量检索能力）
Tool Registry（Tool 定义可视为特殊记忆）
Knowledge Base（文档记忆 → RAG 自然过渡）
```

V3 开始接入：

```text
RAG System（文档上传 → 切片 → Embedding → 检索增强生成）
```
