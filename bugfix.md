# 智能客服模块 —— 修复方案

> 基于 2026-06-14 代码审查，覆盖 P0/P1 问题和工程改进建议。

---

## P0-1: CitationVerifier 未集成到主流程

**问题**: `citation-verifier.ts`（530行）实现了 embedding 语义引证校验，但 `CustomerChatService.streamChat()` 从未调用它。L4 校验层始终回退到旧版关键词重叠检测，`cs_citation_coverage` 指标无数据。

**影响**: 无法检测 LLM 编造事实（幻觉），引证质量保障形同虚设。

**修复文件**:
- `apps/server/src/services/customer-chat.ts`
- `apps/server/src/services/customer-chat/tool-agent.ts`

**方案**:

```typescript
// tool-agent.ts —— 在 agent_respond 处理后，对最终回复做引证校验

import { getCitationVerifier } from "./citation-verifier.js";
import { csCitationCoverage } from "../../observability/metrics.js";

// 在 ToolAgent.execute() 中，agent_done 之后、发送 done 事件之前：

// ── Citation 引证校验 ──
let citationReport = null;
if (finalAnswer && context.kbChunks.length > 0) {
  try {
    const verifier = getCitationVerifier();
    citationReport = await verifier.verify(finalAnswer, context.kbChunks);
    csCitationCoverage.observe(
      { level: citationReport.level },
      citationReport.coverageRate,
    );
  } catch (e) {
    logger.warn(e, "Citation verification skipped");
  }
}

// 将 citationReport 传入 validateBusinessResponse（当前缺失此参数）
const validationResult = validateBusinessResponse(
  finalAnswer,
  context.kbChunks,
  citationReport, // ← 当前代码从未传入
);
```

同时修改 `customer-chat.ts` 的 `streamChat()`，在 ToolAgent 返回的 done 事件中透传 `citationReport` 到 eval 日志：

```typescript
// customer-chat.ts —— done 事件处理
if (event.type === "done" && event.citation) {
  // 写入 eval 日志，供 Feedback 面板展示引证分析
}
```

---

## P0-2: satisfaction_ratings 写入失败静默吞错

**问题**: `customer-chat.ts:129-132` 的 catch 块仅 `logger.warn`，表不存在时所有评价数据永久丢失。

**影响**: 数据闭环断裂 —— 满意度评价是客服运营的核心 KPI 来源。

**修复文件**: `apps/server/src/routes/customer-chat.ts`

**方案**: 三层防御

```typescript
// 第1层：启动时检查表存在性（加在 server 启动逻辑中）
async function ensureSatisfactionRatingsTable(): Promise<void> {
  try {
    const result = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'satisfaction_ratings'
      )`,
    );
    if (!result[0]?.exists) {
      logger.error(
        "satisfaction_ratings table does not exist! Run: pnpm db:migrate"
      );
    }
  } catch (e) {
    logger.error(e, "Failed to check satisfaction_ratings table existence");
  }
}

// 第2层：写入失败时记录到 Redis 死信队列 + 结构化错误日志
// customer-chat.ts rate route:
try {
  await prisma.satisfactionRating.create({ data: { ... } });
} catch (e) {
  // 区分错误类型
  const errorMessage = e instanceof Error ? e.message : "unknown";
  const isTableMissing =
    errorMessage.includes("does not exist") ||
    errorMessage.includes("undefined table");

  logger.error(
    {
      session_id,
      rating,
      errorType: isTableMissing ? "TABLE_MISSING" : "DB_ERROR",
      error: errorMessage,
    },
    "Failed to persist satisfaction rating"
  );

  // 写入死信（异步，不阻塞响应）
  try {
    const ratingQueue = getRatingDeadLetterQueue(); // BullMQ
    await ratingQueue.add("persist-rating", {
      session_id,
      message_id,
      rating,
      comment,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // 死信队列也失败 → 写本地文件兜底
    logger.error("Dead letter queue also failed, rating permanently lost");
  }
}
```

---

## P0-3: 匿名会话并发控制产生无意义内存抖动

**问题**: `customer-chat.ts:222` 为每个匿名请求创建 `anonymous-${randomUUID()}` 锁，每个匿名请求独占一个锁无串行化效果，且持续触发 LRU 淘汰。

**修复文件**: `apps/server/src/services/customer-chat.ts`

**方案**:

```typescript
// streamChat() 方法开头，替换现有的 lockKey 逻辑：

async *streamChat(
  sessionId: string | null,
  userMessage: string,
): AsyncGenerator<Record<string, unknown>> {
  // ── 0. 会话级并发控制 ──
  // 匿名用户无会话状态，跳过锁机制
  if (sessionId) {
    yield* this.executeWithLock(sessionId, userMessage);
  } else {
    yield* this.executeStreamChat(null, userMessage);
  }
}

// 抽取带锁执行逻辑
private async *executeWithLock(
  sessionId: string,
  userMessage: string,
): AsyncGenerator<Record<string, unknown>> {
  const lockKey = sessionId;
  // ... 原有锁逻辑（LRU + 超时 + finally 释放）
  yield* this.executeStreamChat(sessionId, userMessage);
}

// 核心执行逻辑（无锁管理代码）
private async *executeStreamChat(
  sessionId: string | null,
  userMessage: string,
): AsyncGenerator<Record<string, unknown>> {
  // ... 原有 1-8 步骤的编排逻辑
}
```

---

## P1-1: Feedback 查询使用 `$queryRawUnsafe` 拼接字符串

**问题**: `customer-chat.ts:156-205` 将硬编码的 `ratingFilter` 字符串直接拼入 SQL，模式危险。

**修复文件**: `apps/server/src/routes/customer-chat.ts`

**方案**: 用 Prisma 安全查询替代 raw SQL

```typescript
// 替换 $queryRawUnsafe 为 Prisma findMany
const feedback = await prisma.satisfactionRating.findMany({
  where: {
    conversation: { type: "customer_service" },
    ...(feedbackType === "negative"
      ? {
          rating: {
            in: ["negative", "star_1", "star_2", "star_3"],
          },
        }
      : {}),
    ...(feedbackType === "positive" ? { rating: "positive" } : {}),
  },
  include: {
    conversation: {
      select: { id: true, sessionId: true, intent: true },
    },
    message: {
      select: { content: true, role: true },
    },
  },
  orderBy: { createdAt: "desc" },
  take: limit,
  skip: (page - 1) * limit,
});

// 如果必须用 raw SQL（性能考量），必须参数化：
const feedback = await prisma.$queryRawUnsafe<...>(
  `SELECT ... WHERE c.type = 'customer_service' AND sr.rating = ANY($1::text[])
   ORDER BY sr.created_at DESC LIMIT $2 OFFSET $3`,
  [allowedRatings, limit, (page - 1) * limit],
);
```

对于 total count 和 intent performance / trends 查询，同样用 Prisma 的 `groupBy` 或参数化 raw SQL。

---

## P1-2: ToolAgent 工具全部标记 parallelizable: false

**问题**: `customer-service-tools.ts` 所有工具并行化被禁用，Router 的 `execution_order: "parallel"` 推荐被无视。

**修复文件**: `apps/server/src/tools/customer-service-tools.ts`

**方案**:

```typescript
export const customerServiceTools: RegisteredTool[] = [
  {
    definition: searchKnowledgeBaseDef,
    execute: searchKnowledgeBaseExecute,
    // ...
    parallelizable: true,  // ← 改为 true：KB 搜索无副作用，可并行
  },
  {
    definition: lookupOrderDef,
    execute: lookupOrderExecute,
    // ...
    parallelizable: true,  // ← 改为 true：只读查询，无依赖
  },
  {
    definition: createSupportTicketDef,
    execute: createSupportTicketExecute,
    // ...
    parallelizable: false, // 保持 false：写操作串行更安全
  },
  {
    definition: checkReturnPolicyDef,
    execute: checkReturnPolicyExecute,
    // ...
    parallelizable: true,  // ← 改为 true：只读查询
  },
  {
    definition: checkShippingStatusDef,
    execute: checkShippingStatusExecute,
    // ...
    parallelizable: true,  // ← 改为 true：只读查询（与 lookup_order 共享 OrderService 时需注意线程安全）
  },
];
```

**注意**: `lookup_order` 和 `check_shipping_status` 并行执行时共享 `OrderService` 实例（单例），但其内部操作是只读的（JSON 文件读取），不存在竞态条件。如果改为并行后出现问题，给 `OrderService` 的方法加读写锁。

---

## P1-3: 记忆提取同步执行拖慢响应

**问题**: `customer-chat.ts:444-471` 在主请求路径中同步执行 `engine.extractAndStore()`，Milvus 慢/挂会导致响应延迟。

**修复文件**: `apps/server/src/services/customer-chat.ts`

**方案**:

```typescript
// ── 8. 提取记忆（异步 fire-and-forget，不阻塞响应）──
if (conversation.sessionId && streamedAnswer) {
  // 使用项目已有的 BullMQ 基础设施（P1-1）
  try {
    const { getMemoryQueue } = await import("../queues/memory.js");
    const queue = getMemoryQueue();
    await queue.add(
      "extract-customer-memory",
      {
        messages: [
          ...historyMessages.map((m) => ({
            role: m.role,
            content: m.content ?? "",
          })),
          { role: "user", content: userMessage },
          { role: "assistant", content: streamedAnswer },
        ],
        userId: CUSTOMER_USER_ID,
        conversationId: conversation.id,
        providerName,
        sessionId: conversation.sessionId,
      },
      {
        // 低优先级任务，不抢占主队列资源
        priority: 10,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
  } catch (e) {
    // 入队失败仅记录，不影响用户响应
    logger.warn(e, "Failed to enqueue memory extraction");
  }
}
```

如果项目尚未有 Memory 专用队列，创建 `apps/server/src/queues/memory.ts`。

---

## P1-4: search_knowledge_base 错误返回格式不一致

**问题**: `customer-service-tools.ts:329-410` 成功时返回 `{ found: true, results: [...] }`，失败/无结果时返回 `{ error: "..." }` 或 `{ found: false, message: "..." }`。LLM Agent 的 system prompt 没有说明如何解析这些变体。

**修复文件**:
- `apps/server/src/tools/customer-service-tools.ts`
- `apps/server/src/services/customer-chat/tool-agent.ts`

**方案**:

统一工具返回格式为 `{ found: boolean, data?: ..., message: string }`：

```typescript
// 所有情况都走统一结构
async function searchKnowledgeBaseExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args.query as string) || "";
  if (!query.trim()) {
    return JSON.stringify({
      found: false,
      message: "请提供搜索查询关键词。",
    });
  }

  try {
    // ... 检索逻辑 ...
    
    if (!rawResults || rawResults.length === 0) {
      return JSON.stringify({
        found: false,
        message: `未找到与"${query}"相关的知识库内容。建议联系人工客服获取准确信息。`,
      });
    }
    
    if (topScore < 0.5) {
      return JSON.stringify({
        found: false,
        message: `知识库中未找到高相关度内容（最高匹配度 ${(topScore * 100).toFixed(0)}%），此信息可能需要人工核实。`,
      });
    }

    return JSON.stringify({
      found: true,
      data: { results: reranked, quality: qualityLabel },
      message: `找到 ${reranked.length} 条相关知识库内容。`,
    });
  } catch (e) {
    logger.error(e, "search_knowledge_base failed");
    return JSON.stringify({
      found: false,
      message: "知识库搜索服务暂时不可用，请基于通用知识回答用户，并建议用户联系人工客服核实。",
    });
  }
}
```

同时在 ToolAgent 的 system prompt 中加入对 `found: false` 情况的处理指引。

---

---

## 前端问题

### P0-FE1: CustomerChat.tsx 与 useCustomerChatStream.ts SSE 解析逻辑重复 ~80%

**问题**: `CustomerChat.tsx`（570行）和 `useCustomerChatStream.ts`（371行）各自实现了一套几乎完全相同的 SSE 流解析逻辑——`data: ` 行分割、`[DONE]` 检测、meta/token/tool_call/tool_result/content_block/error/done 事件分发、`dedupeBlocks` 去重函数。`useCustomerChatStream` 是为 `CustomerChatPage` 抽取的 hook，但 `CustomerChat` 从未被重构为使用该 hook。所有 bug 需要在两处各修一遍。

**影响**: 维护噩梦。任何 SSE 协议的变更需要同时改两个文件，极易出现行为不一致。

**修复文件**:
- `apps/web/src/components/customer-chat/CustomerChat.tsx`
- `apps/web/src/hooks/useCustomerChatStream.ts`

**方案**:

```typescript
// CustomerChat.tsx —— 删除内联 SSE 解析逻辑，改用 useCustomerChatStream

import { useCustomerChatStream } from "@/hooks/useCustomerChatStream";

export function CustomerChat() {
  const {
    messages,
    isStreaming,
    sessionId,
    currentMeta,
    sendMessage,
    loadHistory,
    clearSession,
  } = useCustomerChatStream();

  // 删除所有本地状态：messages, isTyping, suggestions, sessionId
  // 删除整个 sendMessage 函数体
  // 删除 dedupeBlocks 函数

  // 加载历史消息（CustomerChat 之前缺失此逻辑）
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 其余渲染逻辑不变，只需调整变量名：
  // isTyping → isStreaming
  // suggestions → currentMeta?.suggestions
}
```

同时给 `useCustomerChatStream` 补上 AbortController 的 unmount 清理：

```typescript
// useCustomerChatStream.ts —— 补上 cleanup
useEffect(() => {
  return () => abortRef.current?.abort();
}, []);
```

---

### P1-FE1: CustomerChat.tsx 缺少会话历史加载

**问题**: 浮动客服窗口 `CustomerChat.tsx` 不调用 `loadHistory()`。用户关闭窗口后重新打开，虽然 localStorage 保留了 sessionId，但看不到之前的对话。

**修复**: 在 `CustomerChat` 中加 `useEffect(() => { loadHistory(); }, [loadHistory]);`（随 P0-FE1 一并修复）。

---

### P1-FE2: CustomerFeedbackPanel 趋势图 `.reverse()` 变异原数组

**问题**: `CustomerFeedbackPanel.tsx:183`：
```typescript
{data.trends.reverse().map((t) => {
```
`Array.prototype.reverse()` **就地反转原数组**。每次组件 re-render（筛选切换、分页翻页），`data.trends` 被再次反转→趋势图方向反复翻转。

**修复文件**: `apps/web/src/components/customer-chat/CustomerFeedbackPanel.tsx`

**方案**:

```typescript
// 改为不可变反转
{[...data.trends].reverse().map((t) => {
```

---

### P2-FE1: FAQSidebar 所有分类共享同一份文档列表

**问题**: `FAQSidebar.tsx:56-61`：
```typescript
const cats: FAQCategory[] = catList
  .filter((cat: FAQCategory) => cat.count > 0)
  .map((cat: FAQCategory) => ({
    ...cat,
    documents: completedDocs, // ← 所有分类获得全部文档
  }));
```

每个分类展开后显示的是**完全相同的全部已入库文档**，分类过滤形同虚设。

**修复**: 后端 `GET /api/customer-chat/faq/categories` 应该返回每个分类下的文档列表，或者前端按分类名 filter：

```typescript
// 按分类名匹配文档（与后端 category 过滤逻辑保持一致）
const cats: FAQCategory[] = catList
  .filter((cat: FAQCategory) => cat.count > 0)
  .map((cat: FAQCategory) => ({
    ...cat,
    documents: completedDocs.filter((d) =>
      d.title.includes(cat.name.slice(0, 2)),
    ),
  }));
```

---

### P2-FE2: SatisfactionRating 提交失败无用户提示

**问题**: `SatisfactionRating.tsx:37-39`：
```typescript
} catch (err) {
  console.error("Failed to submit rating:", err);
}
```
fetch 失败时组件直接显示"感谢您的反馈！"，用户完全不知道评价没提交成功。

**方案**:

```typescript
} catch (err) {
  console.error("Failed to submit rating:", err);
  // 回退状态，允许重试
  setSubmitted(false);
  setRating(null);
  // 或者显示错误 toast
  setError("提交失败，请重试");
}
```

---

### P2-FE3: fetch 请求缺少超时机制

**问题**: `CustomerChat.tsx:121` 和 `useCustomerChatStream.ts:114` 的 `fetch` 没有超时。如果服务端 SSE 连接建立后卡住不发送数据，前端会无限等待。

**方案**: 使用 `AbortSignal.timeout()` 或在 `AbortController` 上叠加超时：

```typescript
// useCustomerChatStream.ts
abortRef.current?.abort();
abortRef.current = new AbortController();

// 30秒超时（防止连接建立后卡住）
const timeoutId = setTimeout(() => abortRef.current?.abort(), 30_000);

const res = await fetch("/api/customer-chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ session_id: sessionId, message: trimmed }),
  signal: abortRef.current.signal,
});

clearTimeout(timeoutId);
```

---

### P2-FE4: CustomerChat.tsx 流式输入时输入框未禁用

**问题**: `CustomerChat.tsx` 的 input 没有 `disabled={isTyping}` 属性，用户在等待回复时仍可输入并触发多次 send。

**修复**: 给 `<input>` 加 `disabled={isTyping}`，与 `CustomerChatPage.tsx:301` 保持一致。

---

## P2: 工程改进（后端）

### P2-1: SmallTalkAgent 避免不必要的 LLM 调用

**文件**: `apps/server/src/services/customer-chat/customer-chat.ts`

**方案**: 将 `CONVERSATIONAL_RULES` 扩展并移到 SmallTalk 路由之前。当前已有部分规则（你好/谢谢/再见），补充：

```typescript
const CONVERSATIONAL_RULES: ConversationalRule[] = [
  // ... 现有规则 ...
  {
    pattern: /^(你是谁|你叫什么|你的名字|who are you|what are you)[\s!！。.,，?？]*$/i,
    response: {
      answer: "我是 AgentForge 智能客服助手 🤖 我可以帮您查询订单状态、物流进度、退换货政策、会员权益等问题。请问有什么可以帮您的？",
      suggestions: ["查询订单", "退换货政策", "联系人工客服"],
    },
  },
  {
    pattern: /^(你能做什么|你能干什么|你有什么功能|what can you do)[\s!！。.,，?？]*$/i,
    response: {
      answer: "我可以帮您：\n- 📦 查询订单状态与物流进度\n- 🔄 了解退换货政策与流程\n- 🎫 创建客服工单\n- 📋 解答会员权益、支付方式等问题\n\n请问您需要什么帮助？",
      suggestions: ["查询订单", "退换货政策", "会员权益"],
    },
  },
];
```

### P2-2: 移除过时的 try-catch 防御代码

**文件**: `apps/server/src/services/customer-chat.ts:308-317`

```typescript
// 移除这个 try-catch，因为 intent 字段已在 Prisma schema 中：
await prisma.conversation.update({
  where: { id: conversation.id },
  data: { intent },
});
// 直接 await，让真实的 DB 错误抛到外层统一处理
```

### P2-3: FAQ 分类过滤改用 Prisma where

**文件**: `apps/server/src/routes/customer-chat.ts:357-360`

```typescript
// 替换内存过滤为 SQL 过滤
const docs = await prisma.knowledgeDocument.findMany({
  where: {
    knowledgeBaseId: kb.id,
    status: "completed",
    ...(category ? { title: { contains: category } } : {}),
  },
  // ...
});
```

### P2-4: CitationVerifier 补充单元测试

**文件**: 新建 `apps/server/src/__tests__/citation-verifier.test.ts`

```typescript
// 核心逻辑测试（不依赖 embedding provider）
describe("CitationVerifier", () => {
  describe("splitSentences", () => {
    it("正确分割中英文混合句子");
    it("合并过短片段到前一句");
    it("处理纯标点行");
  });

  describe("isFactualSentence", () => {
    it("含数字+单位的句子判定为事实性");
    it("问候语判定为非事实性");
    it("表达遗憾/同理心的句子判定为非事实性");
  });

  describe("keyword fallback: keywordCitationScore", () => {
    it("数字完全匹配时得分接近1.0");
    it("数字完全不匹配时得分较低");
    it("政策术语匹配时加分");
  });

  describe("emptyReport", () => {
    it("无 KB 时所有句子标记为 uncited");
    it("coverageRate 为 0");
  });
});
```

### P2-5: 增加集成测试

**文件**: 新建 `apps/server/src/__tests__/customer-chat-integration.test.ts`

覆盖路径：
1. `CustomerChatService.streamChat()` 完整流程（Mock LLM）
2. ToolAgent `execute()` 的 SSE 事件序列验证
3. `QueryRouter.classify()` 的 LLM → fallback 降级链
4. `validateBusinessResponse` 五层校验的每个 Layer 至少一个 case

---

## 优先级和修复顺序

| 顺序 | 编号 | 层级 | 修复内容 | 预计工时 |
|------|------|------|----------|----------|
| 1 | P0-2 | 后端 | satisfaction_ratings 写入失败处理 | 2h |
| 2 | P0-1 | 后端 | CitationVerifier 集成 | 3h |
| 3 | P0-FE1 | 前端 | CustomerChat.tsx 改用 useCustomerChatStream 消除重复 | 2h |
| 4 | P0-3 | 后端 | 匿名会话锁优化 | 1h |
| 5 | P1-4 | 后端 | 工具返回格式统一 | 1.5h |
| 6 | P1-FE2 | 前端 | 趋势图 reverse() 变异原数组 | 0.25h |
| 7 | P1-FE1 | 前端 | CustomerChat 缺少历史加载（随 P0-FE1 一并修复） | 0h |
| 8 | P1-1 | 后端 | Feedback 查询安全化 | 2h |
| 9 | P1-2 | 后端 | 工具并行化启用 | 1h |
| 10 | P1-3 | 后端 | 记忆提取异步化 | 2h |
| 11 | P2-FE1 | 前端 | FAQSidebar 分类文档过滤修正 | 0.5h |
| 12 | P2-FE2 | 前端 | SatisfactionRating 提交失败提示 | 0.5h |
| 13 | P2-FE3 | 前端 | fetch 超时机制 | 0.5h |
| 14 | P2-FE4 | 前端 | CustomerChat 输入框流式时禁用 | 0.25h |
| 15 | P2-1~P2-5 | 后端 | 工程改进 | 4h |

**总估算**: ~20.5 工时（后端 14h + 前端 6.5h）
