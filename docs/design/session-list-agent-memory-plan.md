# 会话列表 & Agent 历史记忆 — 实现方案 V2

## Context

**问题**：customer-service 前端已有 SessionList UI 骨架，但 Python 后端的会话/消息 API 全部返回空数据（stub），导致：
- 侧边栏总是显示"暂无历史对话"
- 刷新页面后聊天记录丢失（纯内存）
- Agent 每次请求无上下文记忆

**目标**：在 Python 后端实现完整的会话持久化、历史消息加载、Agent 记忆注入，前端增加消息分页滚动加载。

**约束**：
- 未登录用户强制跳转登录页
- 分页大小：每页 5 条消息
- 消息实时写入
- 长对话自动摘要压缩，防 Token 爆炸

---

## 核心架构决策

### 标识体系：conversation_id 而非 session_id

```
❌ 旧（Node 遗留）:
   session_id → 查找 Conversation → conversation_id

✅ 新:
   conversation_id 作为唯一标识

原因:
  - session_id 是客户端连接生命周期（浏览器刷新 = 新 session_id）
  - conversation_id 是数据生命周期（持久不变）
  - 生产系统不暴露 session_id 作为核心标识
```

前端 `localStorage` 存储 `agent_chat_conversation_id`（UUID），直接作为 API 参数。不再有 `session_id` 概念。

### 数据模型：三张核心表

```
Conversation ──1:N──▶ Message
     │
     └──1:1──▶ ConversationMemory
```

---

## 涉及文件

| 层级 | 文件 | 改动类型 |
|------|------|----------|
| **Python 模型** | `apps/server-py/src/models/chat.py` | **新建** — Conversation + Message + ConversationMemory ORM |
| **Python API** | `apps/server-py/src/api/v1/chat.py` | **重写** — stub 端点接入 DB |
| **Python 上下文** | `apps/server-py/src/agent/context_builder.py` | **新建** — Token Budget + 滑动窗口 + 摘要注入 |
| **Python 压缩** | `apps/server-py/src/agent/summary_compressor.py` | **新建** — LLM 摘要生成，入队 Redis |
| **Python Executor** | `apps/server-py/src/agent/executor.py` | **修改** — 使用 ContextBuilder 组装上下文 |
| **Python 依赖** | `apps/server-py/src/api/deps.py` | **修改** — 添加必需认证依赖 |
| **Prisma Schema** | `packages/database/prisma/schema.prisma` | **修改** — Message 增加 type + metadata 字段 |
| **前端 Hook** | `apps/customer-service/src/hooks/useAgentChatStream.ts` | **修改** — conversation_id 体系 + 分页加载 |
| **前端组件** | `apps/customer-service/src/components/agent-chat/AgentChatPage.tsx` | **修改** — IntersectionObserver 滚动加载 |
| **前端组件** | `apps/customer-service/src/components/agent-chat/SessionList.tsx` | **修改** — 适配 conversation_id，移除匿名分支 |

---

## 1. 数据模型

### 1.1 Conversation

```
Table: conversations（已有，无需改 schema）
Columns: id (UUID PK), user_id, title, type(=agent_chat), status, metadata(JSONB), created_at, updated_at

说明:
  - id 就是 conversation_id，前端直接使用
  - session_id 字段保留但不再使用（向后兼容）
  - metadata = { "compressed_summary": null, "compressed_until_message_id": null, ... }
    注意：compressed_summary 仅用于快速判断是否有摘要，
          实际摘要内容存 ConversationMemory 表
```

### 1.2 Message（增强）

```
Table: messages（需新增 type + metadata 列）
Columns:
  id            UUID PK
  conversation_id  FK → conversations
  role          VARCHAR(16)   -- user | assistant | system | tool
  type          VARCHAR(20)   -- text | tool_call | tool_result  [新增]
  content       TEXT
  metadata      JSONB         -- { tool_name, tool_args, tokens, ... }  [新增]
  model         VARCHAR(64)
  created_at    TIMESTAMPTZ

Indexes:
  ix_messages_conversation_created (conversation_id, created_at DESC, id DESC)
  -- 复合索引支持游标分页: WHERE (created_at, id) < (cursor_time, cursor_id)
```

**为什么加 type + metadata**：
- Agent 工具调用链：`user → assistant(tool_call) → tool(result) → assistant(final)`
- 没有 type 区分，前端无法正确渲染工具调用卡片
- metadata 存储 tool_name、tool_args、token 消耗等，避免后续改表

### 1.3 ConversationMemory（新建）

```
Table: conversation_memory
Columns:
  id                        UUID PK
  conversation_id           FK → conversations (UNIQUE, 1:1)
  summary                   TEXT         -- LLM 生成的对话摘要
  covered_until_message_id  VARCHAR(36)  -- 摘要覆盖到哪条消息（message id，非 index）
  token_count               INT          -- 摘要的 token 数
  memory_type               VARCHAR(20) DEFAULT 'summary'  -- summary | entity | preference | fact（未来扩展）
  created_at                TIMESTAMPTZ
  updated_at                TIMESTAMPTZ

Indexes:
  ix_conversation_memory_conv_id (conversation_id)
  ix_conversation_memory_type (memory_type)
```

**为什么用 message_id 而非 index**：
- 消息可被删除，index 不稳定
- message_id 是 immutable 的，`covered_until_message_id = "msg_xxx"` 语义明确："这条消息之前的内容已摘要"

---

## 2. ContextBuilder — Token Budget 管理

这是本次设计的核心抽象。解决"不是按条数，而是按 token 预算组装上下文"的问题。

### 2.1 Pipeline

```
输入: conversation_id + user_message
  │
  ▼
Collect ─── 从 DB 加载候选消息
  │
  ▼
Rank ────── 按相关性和时间排序
  │
  ▼
Budget ──── 统计 token，超出预算 → 截断
  │
  ▼
Compress ── 如有 ConversationMemory 摘要，注入到 System Prompt
  │
  ▼
Assemble ── 输出最终的 messages 列表
```

### 2.2 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `MAX_CONTEXT_TOKENS` | 4000 | Agent 上下文总 token 预算（不含 system prompt） |
| `MAX_SYSTEM_TOKENS` | 800 | System Prompt 最大 token |
| `RAW_WINDOW` | 10 | 最近保持原始的消息条数 |
| `SUMMARY_MAX_TOKENS` | 300 | 压缩摘要最大 token |
| `COMPRESSION_THRESHOLD` | 20 | 总消息数超过此值触发压缩检查 |

### 2.3 上下文组装逻辑

```python
class ContextBuilder:
    def build(self, conversation_id: str, user_message: str) -> list[BaseMessage]:
        # 1. 加载 Conversation + ConversationMemory
        conv = await db.get(Conversation, conversation_id)
        memory = await db.get(ConversationMemory, conversation_id)

        # 2. 加载最近消息（用于 raw window）
        recent = await load_recent_messages(conversation_id, limit=RAW_WINDOW * 2)

        # 3. 组装 System Prompt
        system_parts = [BASE_SYSTEM_PROMPT]

        if memory and memory.summary:
            # 摘要作为 System Prompt 的背景知识，不是对话消息
            system_parts.append(f"\n## 历史对话摘要\n{memory.summary}")

        # 4. 注入 AgentForge Persona（如果有）
        system_parts.append(AGENTFORGE_PERSONA)

        system_msg = SystemMessage(content="\n\n".join(system_parts))

        # 5. Token 预算检查
        budget = MAX_CONTEXT_TOKENS
        selected = []

        # 先计入当前用户消息的 token
        budget -= estimate_tokens(user_message)

        # 从最近的消息倒序取，直到 budget 用完
        for msg in reversed(recent):
            tokens = estimate_tokens(msg.content)
            if budget - tokens < 0:
                break
            selected.insert(0, msg)  # 保持时间顺序
            budget -= tokens

        # 6. 组装最终消息列表
        history_msgs = [to_langchain_message(m) for m in selected]
        current_msg = HumanMessage(content=user_message)

        return [system_msg] + history_msgs + [current_msg]
```

### 2.4 为什么摘要放在 SystemMessage 而不是单独消息

```
❌ 错误:
   SystemMessage("你是客服助手")
   HumanMessage("历史摘要: 用户讨论退款...")  ← 模型可能认为这是用户说的
   HumanMessage("帮我查订单")

✅ 正确:
   SystemMessage("你是客服助手。\n\n历史对话摘要:\n用户讨论退款...\n\n请结合以上信息回答。")
   HumanMessage("帮我查订单")

原因: 摘要是背景上下文，不是对话参与者。放在 SystemMessage 中模型理解这是"已知信息"而非"对话内容"。
```

---

## 3. API 层

### 3.1 认证

所有 `/api/agent/chat/*` 端点统一添加 `Depends(get_required_user)`。

```python
# deps.py 新增
async def get_required_user(...) -> User:
    user = await get_current_user(...)
    if user is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return user
```

### 3.2 `POST /api/agent/chat` — 核心流程

```
1. get_or_create_conversation(user_id, conversation_id)
   - 有 conversation_id → 查 DB，验证 ownership
   - 无 → 新建 Conversation(title="新对话", type="agent_chat", user_id=...)
             返回 conversation_id 给前端（前端存入 localStorage）

2. 保存用户消息
   INSERT INTO messages (conversation_id, role='user', type='text', content=...)

3. 并发控制
   Redis lock: conversation:{id}（防止同一会话并发消息乱序）

4. ContextBuilder.build(conversation_id, user_message)
   → 返回组装好的 [SystemMessage, ...history, HumanMessage]

5. AgentExecutor.execute(context)
   → SSE 流式输出

6. 保存助手消息
   INSERT INTO messages (conversation_id, role='assistant', type='text', content=...)

7. 异步触发压缩检查
   入队 Redis: arq.enqueue("compress_conversation", conversation_id)
```

### 3.3 `GET /api/agent/chat/conversations`

```sql
-- 返回当前用户所有 agent_chat 会话
SELECT id, title, updated_at, created_at,
       (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at ASC LIMIT 1) AS first_message
FROM conversations c
WHERE user_id = :user_id AND type = 'agent_chat'
ORDER BY updated_at DESC
```

### 3.4 `GET /api/agent/chat/history?conversation_id=X&before_time=...&before_id=...&limit=5`

游标分页，使用复合游标避免同时间戳数据丢失：

```sql
-- 首页（无游标）
SELECT * FROM messages
WHERE conversation_id = :conv_id
ORDER BY created_at DESC, id DESC
LIMIT :limit + 1  -- 多取 1 条判断 has_more

-- 翻页（带游标）
SELECT * FROM messages
WHERE conversation_id = :conv_id
  AND (created_at, id) < (:cursor_time, :cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT :limit + 1
```

PostgreSQL 的 row value comparison `(a, b) < (c, d)` 天然支持这种分页。

返回格式：

```json
{
  "conversation_id": "...",
  "messages": [...],
  "has_more": true,
  "next_cursor": { "before_time": "...", "before_id": "..." }
}
```

### 3.5 `DELETE /api/agent/chat/conversations/:id`

- 验证 ownership → 级联删除（CASCADE 已定义）

---

## 4. 会话摘要压缩

### 4.1 架构：Redis Queue 异步处理

```
POST /api/agent/chat
  │
  ▼
SSE 流结束
  │
  ▼
arq.enqueue("compress_conversation", conversation_id)  ← 入队，不阻塞
  │
  ▼
Redis Queue (job:compress_conversation)
  │
  ▼
Worker（独立进程/协程）
  │
  ├─ 判断是否需要压缩（消息数 > COMPRESSION_THRESHOLD）
  ├─ 首次压缩：取最旧的 N 条 → LLM → 生成摘要
  ├─ 增量压缩：取 "已有摘要 + 新消息" → LLM → 合并摘要
  └─ 写入 ConversationMemory 表
```

**为什么用 Redis Queue 而非 asyncio.create_task**：
- 多 worker 部署（uvicorn --workers=4）时，create_task 可能丢失
- Redis Queue 持久化，worker 重启后继续执行
- 项目已有 Redis 基础设施

### 4.2 压缩逻辑

```python
async def compress_conversation(conversation_id: str):
    conv = await db.get(Conversation, conversation_id)
    memory = await db.get(ConversationMemory, conversation_id)

    total_count = await count_messages(conversation_id)
    if total_count <= COMPRESSION_THRESHOLD:
        return  # 不需压缩

    if memory and memory.summary:
        # 增量压缩：旧摘要 + 上次压缩之后的新消息
        new_msgs = await get_messages_after(conversation_id, memory.covered_until_message_id)
        prompt = f"""以下是一段对话历史的已有摘要和新消息，请将它们合并为一段简洁的更新摘要。

已有摘要：
{memory.summary}

新消息：
{format_messages(new_msgs)}

请保留关键信息：用户核心问题、AI 重要结论、未解决事项。
控制在 {SUMMARY_MAX_TOKENS} token 以内。"""
    else:
        # 首次压缩：取超出 RAW_WINDOW 的旧消息
        old_msgs = await get_old_messages(conversation_id, skip_last=RAW_WINDOW)
        prompt = f"""将以下对话历史压缩为一段简洁摘要：
{format_messages(old_msgs)}

请保留关键信息：用户核心问题、AI 重要结论、未解决事项。
控制在 {SUMMARY_MAX_TOKENS} token 以内。"""

    summary = await llm.invoke(prompt)

    # Upsert ConversationMemory
    await db.merge(ConversationMemory(
        conversation_id=conversation_id,
        summary=summary,
        covered_until_message_id=latest_covered_message_id,
        token_count=estimate_tokens(summary),
        memory_type="summary",
    ))
    await db.commit()
```

### 4.3 存储位置：ConversationMemory 表

不再使用 `Conversation.customerMeta`，独立表的好处：
- 结构清晰，不和其他业务字段混在一起
- 可扩展 `memory_type`（summary / entity / preference / fact）—— 这就是长期记忆的基础
- 独立的索引和查询

---

## 5. 前端

### 5.1 标识体系切换

```
旧: localStorage "agent_chat_session_id" → sessionId
新: localStorage "agent_chat_conversation_id" → conversationId

API 调用:
  旧: GET /api/agent/chat/history?session_id=X
  新: GET /api/agent/chat/history?conversation_id=X&limit=5
```

### 5.2 `useAgentChatStream.ts`

```typescript
// conversationId 替代 sessionId
const [conversationId, setConversationId] = useState<string>(() => {
  return localStorage.getItem("agent_chat_conversation_id") || "";
});

// 发送消息时，后端返回 conversation_id
// 前端存入 localStorage
sendMessage → SSE "meta" 事件 → setConversationId(event.conversation_id)

// 分页加载
loadHistory: async () => {
  if (!conversationId) return;
  const res = await fetch(
    `/api/agent/chat/history?conversation_id=${conversationId}&limit=5`
  );
  // data.has_more + data.next_cursor
}

loadMoreHistory: async () => {
  const res = await fetch(
    `/api/agent/chat/history?conversation_id=${conversationId}&limit=5` +
    `&before_time=${cursor.before_time}&before_id=${cursor.before_id}`
  );
  // 插入到消息列表头部，保持滚动位置
}
```

### 5.3 `AgentChatPage.tsx` — IntersectionObserver

```
❌ 旧: onScroll + scrollTop === 0（容易重复触发）
✅ 新: IntersectionObserver

<div ref={topTriggerRef} className="py-4 text-center">
  {isLoadingMore ? (
    <span className="text-xs text-muted-foreground">加载更多...</span>
  ) : hasMore ? (
    <span className="text-xs text-muted-foreground">向上滚动加载更多</span>
  ) : (
    <span className="text-xs text-muted-foreground">已加载全部消息</span>
  )}
</div>

// useEffect
const observer = new IntersectionObserver(
  ([entry]) => { if (entry.isIntersecting && hasMore && !isLoadingMore) loadMoreHistory(); },
  { threshold: 0.1 }
);
observer.observe(topTriggerRef.current);
```

### 5.4 `SessionList.tsx`

- 移除匿名用户分支
- `conversation.id` 替代 `conversation.session_id` 用于切换会话

---

## 6. 并发控制

同一会话的多个请求必须串行化，防止消息乱序。

```python
# chat.py
import asyncio

_conversation_locks: dict[str, asyncio.Lock] = {}

async def _acquire_conversation_lock(conversation_id: str):
    if conversation_id not in _conversation_locks:
        _conversation_locks[conversation_id] = asyncio.Lock()
    return _conversation_locks[conversation_id]

# 在 _handle_chat 中使用
lock = await _acquire_conversation_lock(conversation_id)
async with lock:
    # ... 整个消息处理流程
```

生产环境可升级为 Redis 分布式锁（多 worker 场景）。

---

## 7. 实现顺序（按 PR）

| PR | 内容 | 文件 | 依赖 |
|----|------|------|------|
| **PR1** | Conversation + Message + ConversationMemory ORM 模型 | `models/chat.py` + Prisma schema 修改 | 无 |
| **PR2** | Auth Required 依赖 | `api/deps.py`（添加 `get_required_user`） | 无 |
| **PR3** | Chat API 持久化（创建会话、保存消息、并发锁） | `api/v1/chat.py` | PR1, PR2 |
| **PR4** | 游标分页 API（history 端点） | `api/v1/chat.py` | PR3 |
| **PR5** | ContextBuilder 抽象（Token Budget + 滑动窗口） | `agent/context_builder.py` | PR1 |
| **PR6** | Agent 记忆注入（Executor 使用 ContextBuilder） | `agent/executor.py` | PR5 |
| **PR7** | 摘要压缩（ConversationMemory + Redis Queue Worker） | `agent/summary_compressor.py` + `api/v1/chat.py`（入队调用） | PR1, PR6 |
| **PR8** | 前端分页 + IntersectionObserver 滚动加载 | `useAgentChatStream.ts` + `AgentChatPage.tsx` | PR4 |
| **PR9** | 前端标识体系切换 + SessionList 适配 | `useAgentChatStream.ts` + `SessionList.tsx` | PR3 |

---

## 8. 验证方案

1. **启动基础设施**：PostgreSQL + Redis + Python Server + Frontend
2. **PR1-2**：模型创建 + 认证 → 单元测试
3. **PR3-4**：
   - 登录 → 发送消息 → 刷新 → 消息仍在（持久化）
   - 创建多个会话 → 列表显示 → 切换加载历史
   - 游标分页：发 10 条消息 → 只显示 5 条 → 滚动加载更多
   - 同时间戳消息：验证不丢数据
4. **PR5-6**：
   - 多轮对话 → Agent 引用之前的上下文
   - 超长消息（>4000 token）→ ContextBuilder 截断不爆
5. **PR7**：
   - 发 25+ 条消息 → 检查 `conversation_memory` 表是否有摘要
   - Agent 基于摘要回答早期问题
   - Redis worker 宕机 → 压缩失败不阻塞主流程
6. **PR8-9**：
   - IntersectionObserver 触发加载更多
   - 加载后滚动位置不跳动
   - conversation_id 存储到 localStorage
   - 未登录 → 跳转 /login
