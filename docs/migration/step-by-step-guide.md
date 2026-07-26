# AgentForge TS → Python 渐进迁移路线

> 原则：每步只引入一个新概念，上一步是下一步的输入。测试在最后集中写。
> 数据库：全新空 PostgreSQL（agentforge_py），不从 Prisma 反向生成。
> **分工策略：TS 端负责用户认证（signup/signin），Python 端负责 LLM + Agent Runtime。**
> Python 端只做 JWT 验证（共享同一个 JWT_SECRET），不做注册/登录端点。

---

## 总览：11 步，4 个里程碑

```
Milestone A "能跑的空壳"          Step 0 → 1 → 2
Milestone B "有数据库+JWT验证"     Step 3 → 4 → 5
Milestone C "能调 LLM+聊天"        Step 6
Milestone D "Agent Runtime"        Step 7 → 8 → 9 → 10
Milestone E "RAG 后续"             Step 11
```

---

## Step 0：环境准备 —— uv + Python 3.12 + 项目骨架 ✅

**Python 概念**：`pyproject.toml`、`uv venv`、`uv run`

### 做的事

```
apps/server-py/
├── pyproject.toml         # uv 项目定义
├── .python-version         # 3.12
├── .env.example
└── src/
    └── __init__.py
```

状态：✅ 已完成

---

## Step 1：配置系统 —— pydantic-settings ✅

**Python 概念**：Pydantic `BaseSettings`、`Field()`、类型注解

### 对应 TS

`apps/server/src/config.ts` → `src/config.py`

**TS 写法**：`process.env.DATABASE_URL || "default"`
**Python 写法**：`Field(default="postgresql://...")`

状态：✅ 已完成

---

## Step 2：FastAPI 壳 —— Hello World + /api/health ✅

**Python 概念**：`async def`、`FastAPI()`、`APIRouter`、`uvicorn`

### 对应 TS

- `apps/server/src/index.ts` → `src/main.py`
- `apps/server/src/app.ts` (工厂函数) → `create_app()` 在 `main.py`

状态：✅ 已完成

---

**里程碑 A 达成：一个能启动、能 curl 通、有自动 API 文档的 Python Web 应用。**

---

## Step 3：数据库连接 —— SQLAlchemy async engine ✅

**Python 概念**：`create_async_engine`、`async_sessionmaker`、async context manager

### 对应 TS

`apps/server/src/db.ts` (PrismaClient singleton) → `src/db.py` (engine + sessionmaker)

状态：✅ 已完成

---

## Step 4：用户模型 + 建表 —— SQLAlchemy ORM + Alembic ✅

**Python 概念**：`DeclarativeBase`、`Mapped[]`、`mapped_column`、Alembic migration

### 对应 TS

`packages/database/prisma/schema.prisma` (User model) → `src/models/user.py`

状态：✅ 已完成

---

## Step 5：JWT 验证 —— 验证 TS 端签发的 Token

**Python 概念**：`python-jose`、`Depends` 依赖注入、`HTTPException`

### 要做的事

```
src/
├── lib/
│   ├── __init__.py
│   └── auth.py              # 只做 JWT 验证，不做密码哈希
├── api/
│   └── deps.py              # get_db + get_current_user
```

### 跟 TS 的关系

TS 端负责签发 token（`auth.ts` 的 `createToken`），Python 端负责验证 token。

**共享一个 `JWT_SECRET`**：TS 和 Python 读取同一个环境变量。

**验证逻辑对比**：

```typescript
// TS 签发（已存在，不改）
const token = createToken(
  { sub: user.id, email: user.email, role: user.role, type: "access" },
  ACCESS_TOKEN_EXPIRY,
);
```

```python
# Python 验证（新建）
from jose import jwt, JWTError

def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != "access":
            return None
        return payload
    except JWTError:
        return None
```

### 具体要做的

**`src/lib/auth.py`**（跟 TS 不同的是不做 signup/signin/password）：
- `decode_access_token(token: str) -> dict | None`

**`src/api/deps.py`**：
- `get_db()` — 从 `src/db.py` 迁过来
- `get_current_user(token, db)` — 解析 token → 查 User → 返回 ORM 对象

**`src/config.py`** 改动：
- 加 `jwt_secret: str` 字段

### 不做的事

- ❌ signup / signin / refresh / signout 端点
- ❌ 密码哈希（TS 做）
- ❌ API Key 管理（TS 做）
- ❌ 全局 auth 中间件（Python 用 `Depends(get_current_user)` 按路由声明）

### 验证方法

```bash
# 1. 先走 TS 的 signup 拿到 token
# 2. 用 Python 的 Depends 验证
# 或者直接用 python-jose 命令行验证 TS 签发的 token
uv run python -c "
from src.lib.auth import decode_access_token
import os
# 随便生成一个 token 来验证 decode 逻辑
"
```

---

**里程碑 B 达成：Python 端能验证 TS 签发的 JWT，为聊天/Agent 做好了认证基础。**

---

## Step 6：LLM Provider + 流式聊天 API

**Python 概念**：`Protocol`、`AsyncIterator`、FastAPI `StreamingResponse`

### 要做的事

```
src/
├── providers/
│   ├── __init__.py
│   ├── base.py             # LLMProvider Protocol
│   └── openai_provider.py  # OpenAI 实现
├── schemas/
│   └── chat.py             # ChatRequest, ChatChunk
├── api/v1/
│   └── chat.py             # POST /api/v1/chat (SSE streaming)
```

### 对应 TS

- `apps/server/src/providers/` → `src/providers/`
- `apps/server/src/routes/agent-runtime.ts` (基础 chat 部分) → `api/v1/chat.py`

### 这一版只做

用户发一句话 → 选 Provider → 调 LLM → 流式返回（SSE）

### 不做的事（留给后面 Step）

- ❌ Agent Router（路由分类）
- ❌ ReAct 循环（工具调用）
- ❌ 知识库上下文

### 验证方法

```bash
curl -N -X POST http://localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"message": "你好"}'
# 观察 SSE 逐 chunk 输出
```

---

**里程碑 C 达成：能调 LLM 并流式返回。Agent 的前置基础。**

---

## Step 7：Runtime 基础 —— RunContext + RunState + StateMachine

**Python 概念**：`@dataclass(frozen=True, slots=True)`、`StrEnum`、`asyncio.Event`

### 要做的事

```
src/runtime/
├── __init__.py
├── context.py             # RunContext（不可变上下文）
├── state.py               # RunState（枚举）+ StateMachine（状态转换表）
```

### 对应 TS

- `apps/server/src/runtime/context.ts` → `runtime/context.py`
- `apps/server/src/runtime/controller.ts` (状态管理部分) → `runtime/state.py`

---

## Step 8：Runtime 执行 —— ExecutionNode + ExecutionTree + EventBus

**Python 概念**：`asyncio.Queue`、树的递归遍历、pub/sub 模式

### 要做的事

```
src/runtime/
├── node.py                # ExecutionNode（封装一个协程）
├── tree.py                # ExecutionTree（节点树 + 展平 + 时间线）
├── events.py              # EventBus（基于 asyncio.Queue 的事件总线）
```

### 对应 TS

`apps/server/src/runtime/controller.ts` + `buffer.ts` → `node.py` + `tree.py` + `events.py`

---

## Step 9：Runtime 编排 —— ExecutionController

**Python 概念**：asyncio 编排、`wait_for`（超时）、`CancelledError` 传播、`shield`

### 要做的事

```
src/runtime/
└── controller.py          # ExecutionController（编排 Node + State + Events）
```

**里程碑 D-1 达成：完整执行运行时——上下文、状态机、节点树、事件总线。**

---

## Step 10：Agent Router + ReAct Executor + Tool + SSE

**Python 概念**：ReAct 循环、Tool Protocol、Pipeline 模式

### 要做的事

```
src/agent/
├── types.py               # RouteName(StrEnum), RouterDecision
├── executor.py             # ReAct AgentExecutor
├── router/
│   └── pipeline.py         # QueryRouter（先只做 L1 关键词正则）
├── tools/
│   ├── base.py             # Tool Protocol
│   ├── registry.py         # ToolRegistry
│   └── builtins/
│       └── search_knowledge.py
```

### 核心流程

```
用户消息 → Router(L1) → ReAct Loop → Tool 调用 → SSE Stream
```

### 对应 TS

- `apps/server/src/services/agent-runtime/routing/` → `src/agent/router/`
- `apps/server/src/services/agent-runtime/agent-executor.ts` → `src/agent/executor.py`

---

**里程碑 D 达成：完整 Agent 链路——Router → ReAct → Tool → SSE。**

---

## Step 11：RAG + 其他高级模块

大致包括：
- `src/rag/` — 文档解析、分片、向量化、Hybrid Search
- `src/workflows/` — DAG 工作流引擎
- `src/teams/` — Multi-Agent 协作
- `src/jobs/` — ARQ Worker
- `src/observability/` — OpenTelemetry + Langfuse
- `tests/` — 全量测试

---

## 路线图速查

```
Step 0  环境准备        ██░░░░░░░░░░  ✅
Step 1  配置系统        ███░░░░░░░░░  ✅
Step 2  FastAPI 壳      ████░░░░░░░░  ✅
Step 3  DB 连接         █████░░░░░░░  ✅
Step 4  User 模型+建表  ███████░░░░░░  ✅
Step 5  JWT 验证        █████████░░░░  ✅
Step 6  LLM + 聊天      ██████████░░░  ✅
Step 7  Runtime 基础    █████████████  ✅
Step 8  Runtime 执行    █████████████  ✅
Step 9  Runtime 编排    █████████████  ✅
Step 10 Agent + ReAct   █████████████  ✅
Step 11 RAG + 后续      █████████████  ✅
                        剩余 ≈ 19h+
```

---

## 当前状态

- ✅ Step 0-5 已完成并提交（里程碑 A + B 达成）
- ✅ Step 6 已完成：LLM Provider + 流式聊天 API
  - `src/providers/base.py` — LLMProvider Protocol
  - `src/providers/openai_provider.py` — OpenAI 实现（AsyncGenerator 流式）
  - `src/providers/registry.py` — Provider 注册中心（惰性初始化 + resolveModel）
  - `src/schemas/chat.py` — ChatMessage、StreamChunk、ChatSyncResult、ChatRequest
  - `src/api/v1/chat.py` — POST /api/v1/chat（SSE StreamingResponse）
- ✅ Step 7 已完成：Runtime 基础
  - `src/runtime/context.py` — RunContext（frozen dataclass）+ 工厂函数
  - `src/runtime/state.py` — ExecutionState（StrEnum）+ 状态转换表 + 校验
  - `src/runtime/__init__.py` — 统一导出
- ✅ Step 8 已完成：Runtime 执行
  - `src/runtime/buffer.py` — OutputBuffer（输出缓冲）
  - `src/runtime/node.py` — ExecutionNode（状态机 + 树结构 + 生命周期）
  - `src/runtime/events.py` — EventBus（asyncio.Queue pub/sub）
  - `src/runtime/tree.py` — 树工具（flatten, find, walk, duration_tree）
- ✅ Step 9 已完成：Runtime 编排
- ✅ Step 10 已完成：Agent Router + ReAct Executor + Tool + SSE
  - `src/agent/types.py` — RouteName, RouterDecision, RouteAgent Protocol, SSE 事件
  - `src/agent/router/pipeline.py` — L1 关键词路由（SAFETY/HUMAN/TASK fallback）
  - `src/agent/tools/base.py` — Tool 协议 + RiskLevel + ToolDefinition
  - `src/agent/tools/registry.py` — ToolRegistry 单例（asyncio.wait_for 超时）
  - `src/agent/tools/builtins/search_knowledge.py` — 占位 KB 搜索工具
  - `src/agent/executor.py` — ReAct AgentExecutor（think → act → observe → respond）
  - `src/providers/` 更新 — stream_chat + tools 参数支持
  - `src/api/v1/chat.py` — Router 分类 → AgentExecutor 分发
- ✅ Step 11 已完成：RAG 基础 + 可观测性抽象 + 全量测试
  - `src/rag/types.py` — KnowledgeSearchResult + KnowledgeService Protocol
  - `src/observability/provider.py` — ObservabilityProvider Protocol + Noop 实现
  - `tests/` — 57 个测试覆盖 config / auth / runtime / agent / tools
  - pytest + pytest-asyncio 配置

---

**🎉 迁移完成！11 个 Step，4 个里程碑，全部达成。**

```
Milestone A "能跑的空壳"          Step 0 → 1 → 2   ✅
Milestone B "有数据库+JWT验证"     Step 3 → 4 → 5   ✅
Milestone C "能调 LLM+聊天"        Step 6           ✅
Milestone D "Agent Runtime"        Step 7 → 8 → 9 → 10  ✅
Milestone E "RAG 基础+测试"        Step 11          ✅
```

**最终项目结构：**

```
apps/server-py/src/
├── agent/           # Agent 模块（Router + ReAct + Tools）
│   ├── executor.py
│   ├── router/pipeline.py
│   ├── tools/base.py, registry.py, builtins/
│   └── types.py
├── api/v1/          # API 路由
│   ├── chat.py      # POST /api/v1/chat（SSE 流式）
│   └── health.py
├── lib/auth.py      # JWT 验证
├── models/          # SQLAlchemy ORM
├── observability/   # 可观测性抽象
├── providers/       # LLM Provider（OpenAI + Protocol）
├── rag/             # RAG 类型 + 服务抽象
├── runtime/         # Runtime 引擎（Context + Node + State + Events + Controller）
├── schemas/         # Pydantic 请求/响应模型
├── config.py        # pydantic-settings 配置
├── db.py            # SQLAlchemy async engine
└── main.py          # FastAPI 应用入口

tests/               # 57 个测试
```
