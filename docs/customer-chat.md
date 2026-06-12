# CustomerChatService（客服聊天服务）

**源文件：** `apps/server/src/services/customer-chat.ts`
**类：** `CustomerChatService`
**所属模块：** 聊天服务（核心编排层）

---

## 一、概览

客服聊天变体，与 `ChatService` 独立实现（不共享基类）。核心差异：

- 不需要记忆注入/提取（匿名用户无长期记忆）
- 每次用户消息自动搜索知识库获取参考答案
- 基于 `sessionId` 管理匿名对话生命周期

**被调用方：** `apps/server/src/routes/customer-chat.ts` → `POST /api/customer-chat`
**调用方：** `KnowledgeService.search()`（知识库检索）、`LLMProvider.streamChat()`（LLM 流式调用）

**关键常量：**

| 常量                      | 值                                     | 说明                                 |
| ------------------------- | -------------------------------------- | ------------------------------------ |
| `CUSTOMER_USER_ID`        | `00000000-0000-0000-0000-000000000002` | 客服系统专用匿名用户                 |
| `MAX_HISTORY_MESSAGES`    | `20`                                   | 只取最近 20 条历史，控制 token 消耗  |
| `CUSTOMER_SERVICE_PROMPT` | 中文客服 prompt 模板                   | `{knowledge_context}` 占位符动态替换 |

---

## 二、请求/响应概览

```
前端 POST /api/customer-chat
  Body: { session_id?: string | null, message: string }
      │
      ▼
路由层 (customer-chat.ts)
  - Zod 校验：session_id 可选为 null，message 至少 1 个字符
  - 创建 CustomerChatService 实例
  - 以 SSE 流式响应（Hono streamSSE）
      │
      ▼
服务层 CustomerChatService.streamChat()
  ┌─────────────────────────────────────────────────────────┐
  │ 步骤 1   获取或创建会话                                    │
  │          → getOrCreateConversation()                    │
  │                                                         │
  │ 步骤 2   解析模型                                        │
  │          → resolveModel() + getProvider()               │
  │                                                         │
  │ 步骤 3   加载历史消息（最近 20 条）                       │
  │          → prisma.message.findMany()                    │
  │                                                         │
  │ 步骤 4   保存用户消息到 PG                               │
  │          → prisma.message.create({ role: "user" })      │
  │                                                         │
  │ 步骤 5   搜索知识库                                      │
  │          → fetchKnowledge() → KnowledgeService.search() │
  │                                                         │
  │ 步骤 6   构建消息列表 + LLM provider 调用                │
  │          → provider.streamChat(messages, model, prompt) │
  │                                                         │
  │ 步骤 7   逐 token yield → SSE → 前端                    │
  │                                                         │
  │ 步骤 8   流结束后保存助手消息到 PG                        │
  │          → prisma.message.create({ role: "assistant" }) │
  └─────────────────────────────────────────────────────────┘
```

### SSE 事件类型

| 事件  | type      | 携带字段                                                     | 触发时机             |
| ----- | --------- | ------------------------------------------------------------ | -------------------- |
| meta  | `"meta"`  | `message_id`, `session_id`, `model`, `provider`, `knowledge` | 流开始前，一次性     |
| token | `"token"` | `content`, `message_id`                                      | LLM 每输出一个 token |
| done  | `"done"`  | `message_id`, `usage`                                        | LLM 流结束           |

### SSE 事件 JSON 示例

**meta：**

```json
{
  "type": "meta",
  "message_id": "msg-uuid",
  "session_id": "anon-session-abc",
  "model": "gpt-4o",
  "provider": "openai",
  "knowledge": [
    {
      "content": "产品退款政策：7天内可全额退款...",
      "score": 0.87,
      "docTitle": "退款政策.md"
    }
  ]
}
```

**token：**

```json
{ "type": "token", "content": "您好", "message_id": "msg-uuid" }
```

**done：**

```json
{
  "type": "done",
  "message_id": "msg-uuid",
  "usage": {
    "prompt_tokens": 1500,
    "completion_tokens": 200,
    "total_tokens": 1700
  }
}
```

---

## 三、逐步骤数据流

### 步骤 1：获取或创建会话 `getOrCreateConversation()`

**入参：** `sessionId: string | null`

**逻辑：**

```
有 sessionId？
  ├─ YES → 查 PG 找 type="customer_service" 且 sessionId 匹配的 conversation
  │        prisma.conversation.findFirst({
  │          where: { sessionId, type: "customer_service" }
  │        })
  │        找到 → 复用该会话（匿名用户回来继续对话）
  │        没找到 → 继续新建（sessionId 可能已过期）
  │
  └─ NO (或没找到) → 新建匿名会话
     prisma.conversation.create({
       id: randomUUID(),           // 服务端生成
       title: "客服会话",          // 固定标题
       userId: CUSTOMER_USER_ID,   // 固定为客服用户
       type: "customer_service",   // 区分类型
       sessionId,                  // 前端传入的 sessionId
     })
```

**返回的 Conversation 对象：**

```typescript
{
  id: string; // UUID v4，如 "a1b2c3d4-..."
  title: string; // "客服会话"
  userId: string; // "00000000-0000-0000-0000-000000000002"（客服专用用户）
  type: string; // "customer_service"
  sessionId: string; // 前端传来的 sessionId（如 localStorage 中的匿名 ID）
  createdAt: Date;
  updatedAt: Date;
}
```

**为什么这么设计：**

- **`type: "customer_service"`** 把客服会话和主聊天会话隔离，防止两个系统的对话互相污染。`conversations` 表同时存两种会话，用 `type` 字段区分。
- **固定 `userId = CUSTOMER_USER_ID`**：客服场景没有"注册用户"概念，所有匿名对话都挂在同一个系统用户下。这样不需要为每个匿名访客创建 User 记录。
- **`sessionId` 不唯一**：允许多个会话共用同一个 sessionId（前端 localStorage 不变，但后端可能因过期等原因重建）。

---

### 步骤 2：解析模型

```typescript
const [providerName, resolvedModel] = resolveModel(this.modelId);
const provider = getProvider(providerName);
```

**`resolveModel()` 做的事：**

```
this.modelId 是什么？
  ├─ null/undefined → 取 settings.DEFAULT_MODEL → 拆成 ["openai", "gpt-4o"]
  ├─ "deepseek-chat" → 拆成 ["deepseek", "deepseek-chat"]
  └─ "gpt-4o"       → 拆成 ["openai", "gpt-4o"]
```

**返回格式：** `[providerName: string, modelId: string]`，如 `["openai", "gpt-4o"]`

**为什么这么设计：**

- `CustomerChatService` 不硬编码模型，从构造函数传入的 `modelId` 动态解析，方便未来扩展（比如不同客服场景用不同模型）。
- `resolveModel` 集中管理模型→Provider 的映射，改配置只需改一处。

---

### 步骤 3：加载历史消息

```typescript
const history = await prisma.message.findMany({
  where: { conversationId: conversation.id },
  orderBy: { createdAt: "desc" }, // 倒序取最新
  take: MAX_HISTORY_MESSAGES, // 最多 20 条
});
const reversed = history.reverse(); // 反转回正序
```

**查询策略：** 倒序取最新 20 条 → 反转回正序。一次查询就能拿到最近的消息，不需要先 count 再 offset。

**返回的 Message[]（正序排列）：**

```typescript
[
  {
    id: "msg-uuid-1",
    conversationId: "conv-uuid",
    role: "user", // "user" | "assistant"
    content: "上次问的问题...",
    model: "gpt-4o",
    createdAt: Date,
  },
  {
    id: "msg-uuid-2",
    role: "assistant",
    content: "上次的回答...",
    model: "gpt-4o",
    createdAt: Date,
  },
  // ...最多 20 条
];
```

**为什么这么设计：**

- **限制 20 条**：控制 token 消耗。客服对话可以很长，但 LLM 上下文窗口有限，只传最近 20 条（约 10 轮对话）是经验值，平衡上下文相关性和成本。
- **倒序取 + 反转**：SQL 层面 `ORDER BY created_at DESC LIMIT 20` 比 `ORDER BY created_at ASC` 再加子查询高效，因为不需要先知道总数。

---

### 步骤 4：保存用户消息

```typescript
await prisma.message.create({
  data: {
    id: randomUUID(), // 服务端生成 UUID
    conversationId: conversation.id,
    role: "user",
    content: userMessage,
    model: resolvedModel,
  },
});
```

**写入 PG 的数据格式：**

```sql
INSERT INTO messages (id, conversation_id, role, content, model, created_at)
VALUES ('<uuid>', '<conversation_id>', 'user', '用户的原始消息文本', 'gpt-4o', NOW());
```

**为什么先保存用户消息再调 LLM：**

1. **持久化优先**：即使 LLM 调用失败，用户的消息也不会丢失。
2. **前端刷新后能看到**：在 SSE 流过程中如果前端断连重连，历史里已有用户消息。
3. **`model` 字段记录**：方便后续分析——知道这条消息是哪个模型处理的。

---

### 步骤 5：搜索知识库 `fetchKnowledge()`

这是客服版与主聊天版最大的区别——每次用户发消息，自动搜索知识库。

**调用链：**

```
fetchKnowledge(userMessage)
  │
  ├─ 1. 动态 import KnowledgeService（避免循环依赖）
  │
  ├─ 2. new KnowledgeService().search(userMessage, undefined, 3)
  │     │
  │     ├─ 用户查询 → OpenAI Embedding API → 1536 维 dense 向量
  │     ├─ Milvus dense 搜索（余弦相似度，weight=0.6）
  │     ├─ BM25 稀疏向量搜索（关键词匹配，weight=0.4）[当前 stub]
  │     ├─ 合并分数：finalScore = 0.6 × dense + 0.4 × sparse
  │     └─ 返回 top 3 KnowledgeSearchResult[]
  │
  ├─ 3. 遍历结果，构建两样东西：
  │     ┌─────────────────────────────────────────────┐
  │     │ context (string):                            │
  │     │   【知识库参考资料】                          │
  │     │   1. 知识库文档的完整 chunk 内容...          │
  │     │   2. 另一个 chunk 的完整内容...              │
  │     │   3. 第三个 chunk 的完整内容...              │
  │     │                                              │
  │     │ results (KnowledgeChunkResult[]):             │
  │     │   [{ content: "截断 300 字符...",            │
  │     │      score: 0.87,                            │
  │     │      docTitle: "产品手册.md" }]              │
  │     └─────────────────────────────────────────────┘
  │
  └─ 4. 返回 { context, results }
       - 如果搜索失败 → catch 异常 → 返回 { context: "", results: [] }
```

---

### 混合搜索打分机制详解

`KnowledgeService.search()` 使用**混合搜索**（Hybrid Search），融合两种互补的检索方式。核心代码在 `knowledge.ts:187`：

```typescript
const hybridScore = DENSE_WEIGHT * denseScore + SPARSE_WEIGHT * sparseScore;
// 即：hybridScore = 0.6 × denseScore + 0.4 × sparseScore
```

**为什么需要混合两种搜索？**

| 搜索方式 | Dense（语义搜索）                                      | Sparse（关键词搜索）                           |
| -------- | ------------------------------------------------------ | ---------------------------------------------- |
| 原理     | 文本 → Embedding 向量 → 余弦相似度                     | 词汇在语料库中的 TF-IDF 加权匹配               |
| 优势     | 理解**语义**——"怎么退款"和"退货流程"能匹配             | 精确匹配**术语**——"SKU-1234"这类专有名词不会漏 |
| 劣势     | 对专有名词、编号不敏感，可能召回语义相关但不精确的内容 | 不理解同义词——"退款"搜不到"退货"               |
| 权重     | **0.6**（主力）                                        | 0.4（辅助）                                    |

**为什么是 0.6 : 0.4 而不是 0.5 : 0.5？**

`weight=0.6` 意味着**语义搜索为主，关键词搜索为辅**。原因：

1. **客服场景更依赖语义理解**：用户问"这东西不好用怎么退"和知识库里"退款申请流程"语义高度相关，但关键词几乎没有重叠。完全靠关键词匹配会漏掉大量正确答案。

2. **语义搜索覆盖面广**：即使知识库用不同措辞描述同一件事，dense 向量通过余弦相似度仍然能匹配上。

3. **关键词搜索仍是必要的补充**：当用户提到精确的产品型号、错误代码、订单号时（如 `ERR_5001`），语义 embedding 可能"没见过"这种冷门词，但 BM25 能精确命中。0.4 的权重确保精确术语匹配能提升分数，但不会主导排序。

4. **0.6/0.4 是经验值**：不是公式推导出来的，而是在实践中调整的。语义为主（>0.5），关键词为辅（<0.5），既不会让关键词匹配被淹没，也不会让语义匹配失去主导权。

**打分流程完整拆解：**

```
查询："如何申请退款"
  │
  ├─ Dense 路径（权重 0.6）
  │   ├─ 查询文本 → text-embedding-ada-002 → [0.012, -0.034, ..., 0.078] (1536维)
  │   ├─ Milvus 在 knowledge_collection 中搜索 dense_vector 字段
  │   │   params: { nprobe: 16 }  — 搜索 16 个聚类中心
  │   ├─ Milvus 对每个候选 chunk 计算余弦相似度 → denseScore ∈ [0, 1]
  │   └─ 结果示例：chunk A denseScore=0.82, chunk B=0.75, chunk C=0.68
  │
  ├─ Sparse 路径（权重 0.4）
  │   ├─ BM25 已在知识库语料上 fit() 训练过（惰性，首次搜索时执行）
  │   ├─ 查询 → encodeQueries() → 稀疏向量 { term_id: weight, ... }
  │   ├─ 每个候选 chunk → encodeDocuments() → 稀疏向量
  │   ├─ 点积 → 除以 L2 范数 → 归一化到 [0, 1] → sparseScore
  │   └─ 结果示例：chunk A sparseScore=0.30, chunk B=0.55, chunk C=0.10
  │       （注意：A 的语义分高但关键词分低，B 的语义分低但关键词分高）
  │
  └─ 混合打分
      chunk A: 0.6 × 0.82 + 0.4 × 0.30 = 0.492 + 0.12 = 0.612
      chunk B: 0.6 × 0.75 + 0.4 × 0.55 = 0.450 + 0.22 = 0.670  ← B 反超 A！
      chunk C: 0.6 × 0.68 + 0.4 × 0.10 = 0.408 + 0.04 = 0.448

      最终排序：B(0.67) > A(0.61) > C(0.45)
      → math.round(score * 10000) / 10000  — 保留 4 位小数
```

注意上面的例子：A 的语义分最高（0.82），但 B 同时匹配了语义和关键词，**混合后 B 反超 A 排到第一**。这就是两种搜索互补的价值——单一维度可能漏掉的，双维度能捞回来。

**当前实际情况：BM25 为 stub**

`bm25.ts` 中的 `BM25SparseEncoder` 当前是 stub 实现，返回空向量，所以 `sparseScore` 恒为 0。此时：

```
hybridScore = 0.6 × denseScore + 0.4 × 0 = 0.6 × denseScore
```

实际排序完全由 dense 语义搜索主导，等同于纯语义搜索。等 BM25 正式实现后，混合搜索才会真正生效。

**`KnowledgeSearchResult`（knowledge.ts 内部）→ `KnowledgeChunkResult`（暴露给前端）：**

| 字段       | KnowledgeSearchResult | KnowledgeChunkResult | 说明                       |
| ---------- | --------------------- | -------------------- | -------------------------- |
| chunkId    | ✅                    | ❌                   | 内部用的，不暴露           |
| docId      | ✅                    | ❌                   | 内部用的，不暴露           |
| kbId       | ✅                    | ❌                   | 内部用的，不暴露           |
| chunkIndex | ✅                    | ❌                   | 内部用的，不暴露           |
| content    | 完整原文              | 截断 300 字符        | 前端展示用，不占用太多带宽 |
| score      | 0.0~1.0               | 0.0~1.0              | Milvus 混合分数            |
| docTitle   | ✅                    | ✅                   | 前端显示"来源：XXX"        |

**为什么这么设计：**

- **两种输出，两种用途**：`context` 是完整内容，注入 system prompt 给 LLM 参考；`results` 是截断+结构化的，给前端展示"参考来源"卡片。分开处理避免了前端收到不必要的大段文本。
- **`content.slice(0, 300)`**：前端只需要展示摘要，完整内容在 LLM 的 system prompt 中。减少 SSE 传输量。
- **`docTitle || docId` 回退**：优先用人类可读的文档标题（如"产品手册.md"），没有标题时回退到 docId。
- **优雅降级**：搜索失败只是 warn 日志 + 返回空，不阻塞正常对话。客户不会因为知识库出问题而得不到回复。

---

### 步骤 6 & 7：构建消息列表 + 流式调用 LLM

**构建 chatMessages（OpenAI 兼容格式）：**

```typescript
const chatMessages = reversed.map((msg) => ({
  role: msg.role, // "user" | "assistant"
  content: msg.content, // 完整消息文本
}));
chatMessages.push({ role: "user", content: userMessage });
// 结果：[{ role: "user", content: "..." }, { role: "assistant", content: "..." }, ...]
```

**构建 System Prompt（模板 + 替换）：**

```
你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。

## 回答规则
1. 如果下方提供了【知识库参考资料】，请优先基于参考资料回答问题，确保信息准确。
2. 如果参考资料中找不到答案，请诚实告知客户你暂时无法回答，并建议其联系人工客服。
3. 保持礼貌、专业和耐心的态度。
4. 回答要简洁明了，直接回应客户问题，不要添加无关信息。

【知识库参考资料】
1. 某文档中的 chunk 内容...
2. 另一个 chunk 内容...
```

`{knowledge_context}` 占位符被替换为实际检索结果。知识库为空时替换为空字符串，LLM 仅靠 prompt 中的"诚实告知无法回答"规则处理。

**LLM Provider 调用：**

```typescript
provider.streamChat(chatMessages, resolvedModel, systemPrompt);
```

所有 Provider 实现统一的 `LLMProvider` 接口：

```typescript
interface LLMProvider {
  streamChat(
    messages: { role: string; content: string }[],
    model: string,
    systemPrompt?: string,
  ): AsyncGenerator<StreamChunk>;
}
```

**StreamChunk → yield 转换：**

| Provider 返回                      | 服务层 yield                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `{ type: "token", content: "你" }` | `{ type: "token", content: "你", message_id }`                                            |
| `{ type: "done", usage: {...} }`   | `{ type: "done", message_id, usage: { prompt_tokens, completion_tokens, total_tokens } }` |

**为什么这么设计：**

- **meta 事件最先发送**：在第一个 token 之前就告诉前端知识库检索结果，前端可以立即渲染"参考来源"卡片，不用等 LLM 回答完。
- **`message_id` 贯穿所有事件**：前端用这个 ID 关联 meta/token/done 到同一条消息，方便状态管理。
- **System prompt 使用模板 + 占位符**：`{knowledge_context}` 保持 prompt 骨架不变，知识内容动态注入。比每次拼接字符串更清晰。
- **不注入记忆**：客服场景是匿名用户，没有长期记忆。如果注入"用户偏好"反而会产生幻觉。

---

### 步骤 8：流结束后保存助手消息

```typescript
await prisma.message.create({
  data: {
    id: assistantMsgId, // 和 meta/token/done 事件中的 message_id 一致
    conversationId: conversation.id,
    role: "assistant",
    content: fullContent, // 所有 token 拼接后的完整回答
    model: resolvedModel,
  },
});
```

**为什么放在流结束之后：**

- 代码中 `prisma.message.create` 在 `for await` 循环结束后执行——此时已经 yield 了 done 事件。
- 前端收到 `done` 后立即结束加载状态，不需要等 DB 写入完成。
- 如果 DB 写入失败（极端情况），前端已经拿到了完整回答，不影响用户体验。

---

## 四、关键数据结构

```typescript
// 暴露给前端的知识库检索结果
export interface KnowledgeChunkResult {
  content: string; // chunk 文本（截断 300 字符）
  score: number; // Milvus 相似度分数（0.0~1.0）
  docTitle: string; // 所属文档标题
}

// 来自 knowledge.ts 的内部搜索结果（本文件不定义，但通过 search() 获取）
interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string; // 完整原文（未截断）
  score: number;
  chunkIndex: number;
  docTitle: string;
}
```

---

## 五、设计要点

- **独立实现，不共享基类**：`CustomerChatService` 和 `ChatService` 业务逻辑差异大（记忆 vs 知识库），共享基类会导致大量条件分支
- **动态 import 避免循环依赖**：`fetchKnowledge()` 中 `await import("./knowledge.js")` 而非顶层 import
- **两种输出分离**：`context`（完整内容→LLM）和 `results`（截断→前端）互不干扰
- **优雅降级贯穿全程**：知识库搜索失败不阻塞对话，LLM 仍然能给出基础客服回复
- **model 字段贯穿**：每条 Message 都记录 model，方便分析回复质量

---

## 六、数据流全景图

```
streamChat(sessionId, userMessage)
  │
  ├─ 1. getOrCreateConversation(sessionId)
  │     查询/创建 → Conversation { id, sessionId, type, userId }
  │     为什么：sessionId 管理匿名会话生命周期
  │
  ├─ 2. resolveModel(this.modelId) → [providerName, modelId]
  │     getProvider(providerName) → LLMProvider 实例
  │     为什么：不硬编码模型，集中管理映射
  │
  ├─ 3. prisma.message.findMany({ conversationId, take: 20, desc })
  │     → Message[]（倒序→反转为正序）
  │     为什么：限制 20 条控制 token，倒序取更高效
  │
  ├─ 4. prisma.message.create({ role: "user", content })
  │     为什么：持久化优先，即使 LLM 失败也不丢消息
  │
  ├─ 5. fetchKnowledge(userMessage)
  │     └─ KnowledgeService.search(query, *, 3)
  │        └─ Embedding → Milvus dense(0.6) + BM25(0.4) → top 3
  │        → { context: string, results: KnowledgeChunkResult[] }
  │        为什么：自动搜索知识库，context→LLM, results→前端
  │
  ├─ 6. yield { type: "meta", knowledge, session_id, model, ... }
  │     为什么：最早通知前端，可立即渲染参考来源卡片
  │
  ├─ 7. provider.streamChat(chatMessages, model, systemPrompt)
  │     for each chunk:
  │       token → yield { type: "token", content, message_id }
  │       done  → yield { type: "done", message_id, usage }
  │     为什么：message_id 贯穿，前端关联状态
  │
  └─ 8. prisma.message.create({ role: "assistant", content: fullContent })
        为什么：流结束后写入，不阻塞 done 事件
```

---

## 七、与 ChatService 的对比

| 维度       | ChatService                            | CustomerChatService                       |
| ---------- | -------------------------------------- | ----------------------------------------- |
| 用户       | 注册用户（default UUID）               | 匿名（固定客服 UUID）                     |
| 会话管理   | 依赖 `conversation_id`                 | 依赖 `session_id`                         |
| 记忆注入   | ✅ MemoryEngine 搜记忆 → system prompt | ❌ 无记忆                                 |
| 记忆提取   | ✅ LLM 提取事实 → 存向量库             | ❌ 无提取                                 |
| 知识库检索 | ❌ 不检索                              | ✅ 自动搜索 top 3                         |
| 历史消息数 | 40 条                                  | 20 条（含知识库 token 更多）              |
| 标题生成   | ✅ 自动从首条消息生成                  | ❌ 固定"客服会话"                         |
| Model 来源 | `requestBody.model` → `resolveModel()` | `constructor(modelId)` → `resolveModel()` |
