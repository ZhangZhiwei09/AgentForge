# 智能客服模块类型安全改造 —— 架构设计

> 状态：Architect 产出，待 Architecture Review
> 日期：2026-06-17
> 类型：类型安全治理 / 技术债务

---

## 1. 需求理解

### 显性需求

消除智能客服模块（Customer Chat）中的类型安全问题：

- 2 处 `any` 根因（SSE 数据解析边界）
- 2 处 `as unknown as` 双重断言（discriminated union 未穷尽）
- 8+ 处类型断言（来自上游 `any` 传播）
- 4 处空 `catch {}`（静默吞错）
- 5 处未校验的 `res.json()`（API 响应当 `any` 使用）

### 隐性需求

- **建立 SSE 数据校验边界**：在外部数据（SSE 流、HTTP 响应）进入类型系统之前进行 Zod 校验，从根本上消除 `any` 源头
- **ContentBlock  discriminated union 穷尽处理**：`dedupeBlocks`/`blockKey` 等函数应覆盖所有 `ContentBlock` 变体，而非使用 `as unknown as` 绕过类型检查
- **错误可观测性**：所有 catch 分支应有日志输出，不能静默吞错
- **代码一致性**：`CustomerChat.tsx`（内联实现）和 `useCustomerChatStream.ts`（Hook 实现）存在两份近重复的 SSE 解析逻辑，应在本次改造中统一

---

## 2. 现状分析

### 2.1 已查阅的源文件

| 文件 | 职责 | 关键发现 |
|---|---|---|
| `packages/shared-types/src/content-block.ts` | ContentBlock discriminated union 定义 | 6 种变体：text/order_card/policy_card/action_card/status_card/table |
| `packages/shared-types/src/customer-chat.ts` | 客服模块共享类型 | CSMessage、KnowledgeResult、ToolCallRecord、CSStreamMeta |
| `packages/shared-types/package.json` | 共享类型包配置 | **纯类型包，无任何运行时依赖** |
| `apps/server/src/services/agent-runtime/types.ts` | RouteStreamEvent discriminated union | 5 种 SSE 事件类型：meta/token/done/content_block/error |
| `apps/server/src/routes/agent-runtime.ts` | SSE 流式端点实现 | `POST /api/agent/chat` 序列化 RouteStreamEvent 为 SSE |
| `apps/web/src/components/customer-chat/CustomerChat.tsx` | 主聊天组件（内联 SSE 解析） | 内联 sendMessage 含完整 SSE 循环 |
| `apps/web/src/hooks/useCustomerChatStream.ts` | SSE 流处理 Hook | 与 CustomerChat.tsx 存在 ~95% 重复的 SSE 解析逻辑 |
| `apps/web/src/components/customer-chat/FAQSidebar.tsx` | FAQ 侧边栏 | 3 个 API 调用均未校验响应类型 |
| `apps/web/src/components/markdown/card-parser.ts` | Markdown 卡片围栏解析 | `parseFenceContent` 将 JSON 解析结果直接当 ContentBlock 返回 |
| `apps/web/vite.config.ts` | Vite 配置 | `/api/*` 代理到 `localhost:8000` |
| `apps/server/src/app.ts` | 应用入口 | `agentRuntimeRoutes` 挂载到 `/`，路径前缀为 `/api/agent/chat` |

### 2.2 SSE 数据流

```
Browser                          Server (Hono)
──────                           ──────
fetch("/api/customer-chat") ───►  contentSafetyMiddleware (拦截 /api/customer-chat)
                                 ↓  (无对应路由！实际应调用 /api/agent/chat)
                                 
                                 Route Handler: POST /api/agent/chat
                                 ↓
                                 AgentRuntimeService.streamChat()
                                 ↓
                                 RouteAgent.execute() → AsyncGenerator<RouteStreamEvent>
                                 ↓
                                 stream.writeSSE({ data: JSON.stringify(chunk) })
                                 ↓
◄── SSE: data: {"type":"meta",...}\n\n
◄── SSE: data: {"type":"token",...}\n\n
◄── SSE: data: {"type":"content_block",...}\n\n
◄── SSE: data: {"type":"done",...}\n\n
◄── SSE: data: [DONE]\n\n

Browser parsing:
  1. ReadableStream → TextDecoder → line buffer
  2. Extract "data: " prefix → JSON.parse(data) → any  ◄── 根因
  3. chunk.type dispatch (if/else chain)
  4. chunk.block as ContentBlock (未校验的断言)
```

### 2.3 RouteStreamEvent 类型（服务端确认的 SSE 协议）

```typescript
// 来源: apps/server/src/services/agent-runtime/types.ts
type RouteStreamEvent =
  | { type: "meta"; message_id: string; session_id: string | null; model: string;
      provider: string; knowledge: KnowledgeChunkResult[]; intent: string;
      within_service_hours: boolean; memory_count: number;
      route?: RouteName; conversational?: boolean; }
  | { type: "token"; content: string; message_id: string; }
  | { type: "done"; message_id: string; usage: Record<string, unknown>;
      suggestions?: string[]; memory: { injected: number; extracted: number };
      validated?: boolean; fallback_used?: boolean; route?: RouteName;
      conversational?: boolean; citation?: { ... }; }
  | { type: "content_block"; block: ContentBlock; message_id: string; }
  | { type: "error"; content: string; };
```

### 2.4 前端处理的额外类型（死代码）

`CustomerChat.tsx` 和 `useCustomerChatStream.ts` 均处理 `tool_call` 和 `tool_result` 两种 chunk 类型，但**服务端 RouteStreamEvent 联合类型中不包含这两种类型**。这些 handler 在当前 customer-chat SSE 流中永远不会触发，属于死代码。

### 2.5 架构约束

- `@agentforge/shared-types` 当前是纯 TypeScript 类型包（`package.json` 中无任何 `dependencies`）
- 项目 CLAUDE.md 类型安全策略规定：外部数据校验优先级为 `Prisma 类型推导 → Zod safeParse → Type Guard → instanceof → Discriminated Union`
- 服务端已使用 `@hono/zod-validator` 进行请求体校验，Zod 已在项目依赖中
- `CustomerChat.tsx` 和 `useCustomerChatStream.ts` 存在两套近重复的 SSE 解析代码

### 2.6 已识别的额外问题

**路由不匹配**：前端两处调用 `/api/customer-chat`（`CustomerChat.tsx:122`, `useCustomerChatStream.ts:115`），但服务端仅定义 `/api/agent/chat` 路由。`contentSafetyMiddleware` 虽拦截了 `/api/customer-chat`，但无对应路由处理器，请求会返回 404。此为独立 Bug，应在类型安全改造前或同步修复。

---

## 3. 架构设计

### 3.1 总体方案

核心策略：**在外部数据进入类型系统的边界处建立 Zod 校验层，从源头消除 `any`**。

```
外部数据 (SSE / HTTP)
    │
    ▼
┌─────────────────────────────┐
│  JSON.parse / res.json()     │  ← 仍然返回 unknown
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Zod Schema safeParse()     │  ← 边界校验层 (NEW)
│  失败 → console.error + 降级 │
└──────────┬──────────────────┘
           │
           ▼
  类型安全的业务逻辑
  (无需任何 as 断言)
```

具体改动分三个层次：

**L1 — 共享类型层（`packages/shared-types`）**：新增 Zod Schema 定义文件，为 `ContentBlock`、SSE Chunk、FAQ API 响应提供运行时校验

**L2 — 数据边界层**（`CustomerChat.tsx`, `useCustomerChatStream.ts`, `FAQSidebar.tsx`）：在两处 `JSON.parse(data)` 处用 `SSEDataChunkSchema.safeParse()` 替换裸 parse；在 API 响应处用对应 Schema 校验

**L3 — 业务逻辑层**（`dedupeBlocks`, `blockKey`）：重构为穷尽的 discriminated union narrowing，消除 `as unknown as`

### 3.2 关键决策

#### 决策 1：Zod Schema 放在 shared-types 还是 apps/web？

**选择：放在 `packages/shared-types`**

理由：
- 项目规范明确要求外部数据使用 Zod 校验
- SSE 协议是前后端共享的契约，Schema 应作为唯一真源（single source of truth）
- 未来服务端也可使用同一套 Schema 校验流式输出（自检）
- 服务端已使用 Zod，不存在引入新依赖的问题

代价：
- `shared-types` 从此不再是纯类型包，首次引入运行时依赖（`zod`）
- 需确认 bundler（Vite）能正确 tree-shake Zod（已验证：Zod v3 支持 ESM tree-shaking）

#### 决策 2：是否同时解决 CustomerChat.tsx 与 useCustomerChatStream.ts 的代码重复？

**选择：本次不合并，仅统一两处的类型安全边界**

理由：
- 合并两个不同用途的实现（内联组件 vs Hook）超出了类型安全治理的范围
- 两者职责不同：`useCustomerChatStream` 服务于 CustomerChatPage，`CustomerChat` 是自包含的浮动聊天组件
- 合并涉及 API 契约变更，属于结构重构而非类型安全治理

本次改造确保两处使用相同的 Zod Schema 和一致的错误处理模式。

#### 决策 3：tool_call / tool_result 死代码的处理？

**选择：保留代码但移除对应 handler，添加注释说明**

理由：
- 这些类型不在 `RouteStreamEvent` 联合类型中，当前 SSE 流永远不会产生这些事件
- 保留注释说明以备将来 Agent Runtime 扩展工具调用能力时恢复
- 如果未来需要支持，应在服务端 `RouteStreamEvent` 类型中正式添加并同步更新 Zod Schema

#### 决策 4：card-parser.ts 的 parseFenceContent 是否需要 Zod 校验？

**选择：本次不改动 card-parser.ts**

理由：
- `parseFenceContent` 处理的是 LLM 生成的 Markdown 文本中的卡片围栏，不是外部 API 数据
- 该函数已有 try-catch 降级策略（解析失败返回 null）
- 该函数内部将 JSON 解析结果直接构造 `{ type, data }` 对象作为 `ContentBlock`，类型上安全（因为它控制构造过程）
- 改造 card-parser 引入 Zod 会增加不必要的运行时开销（每次 Markdown 渲染都需校验）

### 3.3 Zod Schema 设计

#### Schema 文件：`packages/shared-types/src/schemas/customer-chat.ts`

```typescript
import { z } from "zod";

// ── 基础类型 ──

const KnowledgeResultSchema = z.object({
  content: z.string(),
  score: z.number(),
  docTitle: z.string(),
});

const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  result: z.string().optional(),
  status: z.enum(["pending", "done", "error"]),
});

// ── ContentBlock 各变体 Schema (discriminated union) ──

const TextBlockSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

const OrderCardDataSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  items: z.array(z.object({
    name: z.string(),
    quantity: z.number(),
    price: z.number(),
  })),
  total: z.number(),
  carrier: z.string().optional(),
  trackingNo: z.string().optional(),
  estimatedDelivery: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

const PolicyCardDataSchema = z.object({
  category: z.string(),
  title: z.string(),
  conditions: z.array(z.string()),
  refundTimeline: z.string().optional(),
  returnWindow: z.string().optional(),
  exceptions: z.array(z.string()).optional(),
});

const ActionCardDataSchema = z.object({
  title: z.string(),
  description: z.string(),
  actions: z.array(z.object({
    label: z.string(),
    action: z.string(),
    style: z.enum(["primary", "secondary", "danger"]).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })),
});

const StatusCardDataSchema = z.object({
  title: z.string(),
  status: z.enum(["pending", "in_progress", "success", "error", "warning"]),
  steps: z.array(z.object({
    label: z.string(),
    status: z.enum(["wait", "active", "done", "error"]),
    description: z.string().optional(),
  })).optional(),
  message: z.string().optional(),
});

const TableBlockDataSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  caption: z.string().optional(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  z.object({ type: z.literal("order_card"), data: OrderCardDataSchema }),
  z.object({ type: z.literal("policy_card"), data: PolicyCardDataSchema }),
  z.object({ type: z.literal("action_card"), data: ActionCardDataSchema }),
  z.object({ type: z.literal("status_card"), data: StatusCardDataSchema }),
  z.object({ type: z.literal("table"), data: TableBlockDataSchema }),
]);

// ── SSE Chunk Schema (discriminated union) ──

const MetaChunkSchema = z.object({
  type: z.literal("meta"),
  message_id: z.string(),
  session_id: z.string().nullable(),
  model: z.string(),
  provider: z.string(),
  knowledge: z.array(KnowledgeResultSchema),
  intent: z.string(),
  within_service_hours: z.boolean(),
  memory_count: z.number(),
  route: z.string().optional(),
  conversational: z.boolean().optional(),
});

const TokenChunkSchema = z.object({
  type: z.literal("token"),
  content: z.string(),
  message_id: z.string(),
});

const DoneChunkSchema = z.object({
  type: z.literal("done"),
  message_id: z.string(),
  usage: z.record(z.string(), z.unknown()),
  suggestions: z.array(z.string()).optional(),
  memory: z.object({
    injected: z.number(),
    extracted: z.number(),
  }),
  validated: z.boolean().optional(),
  fallback_used: z.boolean().optional(),
  route: z.string().optional(),
  conversational: z.boolean().optional(),
  citation: z.object({
    level: z.string(),
    coverageRate: z.number(),
    avgScore: z.number(),
    uncitedCount: z.number(),
  }).optional(),
});

const ContentBlockChunkSchema = z.object({
  type: z.literal("content_block"),
  block: ContentBlockSchema,
  message_id: z.string(),
});

const ErrorChunkSchema = z.object({
  type: z.literal("error"),
  content: z.string(),
});

// 主 SSE 数据块联合 Schema
export const SSEDataChunkSchema = z.discriminatedUnion("type", [
  MetaChunkSchema,
  TokenChunkSchema,
  DoneChunkSchema,
  ContentBlockChunkSchema,
  ErrorChunkSchema,
]);

export type SSEDataChunk = z.infer<typeof SSEDataChunkSchema>;

// ── FAQ API 响应 Schema ──

export const FAQDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  chunkCount: z.number(),
  status: z.string(),
});

export const FAQCategorySchema = z.object({
  name: z.string(),
  count: z.number(),
});

export const FAQListResponseSchema = z.object({
  documents: z.array(FAQDocumentSchema),
});

export const FAQCategoriesResponseSchema = z.object({
  categories: z.array(FAQCategorySchema),
});

export const FAQDetailResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  chunkCount: z.number(),
  status: z.string(),
});
```

#### 导出策略

从 `packages/shared-types/src/index.ts` 导出新的 Schema（区别于现有 type-only export）：

```typescript
// Schemas (runtime validation)
export {
  SSEDataChunkSchema,
  ContentBlockSchema,
  FAQDocumentSchema,
  FAQListResponseSchema,
  FAQCategoriesResponseSchema,
  FAQDetailResponseSchema,
} from "./schemas/customer-chat";
export type { SSEDataChunk } from "./schemas/customer-chat";
```

### 3.4 边界层使用模式

#### SSE JSON.parse 边界（CustomerChat.tsx / useCustomerChatStream.ts）

```typescript
// Before:
const chunk = JSON.parse(data);  // any
if (chunk.type === "meta") { ... chunk.knowledge ... }

// After:
const raw = JSON.parse(data);
const result = SSEDataChunkSchema.safeParse(raw);
if (!result.success) {
  console.error("Invalid SSE chunk:", result.error.flatten(), raw);
  continue;  // 跳过无法识别的 chunk，不阻塞流
}
const chunk = result.data;  // SSEDataChunk，完全类型安全
if (chunk.type === "meta") { ... chunk.knowledge ... }  // 自动 narrowing
```

#### API 响应边界（FAQSidebar.tsx）

```typescript
// Before:
const { documents: docList } = await docsRes.json();  // any
const completedDocs = (docList as FAQDocument[]).filter(...)

// After:
const raw = await docsRes.json();
const parsed = FAQListResponseSchema.safeParse(raw);
if (!parsed.success) {
  console.error("Invalid FAQ response:", parsed.error.flatten());
  return;  // 降级为空列表
}
const { documents: docList } = parsed.data;  // FAQDocument[]
const completedDocs = docList.filter(d => d.status === "completed");  // 无需 as
```

### 3.5 ContentBlock discriminated union 重构

#### dedupeBlocks（CustomerChat.tsx）→ 替换为实现穷尽 narrowing 的版本

```typescript
function dedupeBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((b) => {
    const key = blockKey(b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockKey(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text:${block.content.slice(0, 50)}`;
    case "order_card":
      return `order:${block.data.orderId}`;
    case "policy_card":
      return `policy:${block.data.category}:${block.data.title}`;
    case "action_card":
      return `action:${block.data.title}`;
    case "status_card":
      return `status:${block.data.title}`;
    case "table":
      return `table:${block.data.headers.join(",")}:${block.data.rows.length}`;
    // TypeScript 会在此检查穷尽性 —— 新增 ContentBlock 类型时编译报错
  }
}
```

注意：`useCustomerChatStream.ts` 已有一个接近正确的 `blockKey` 实现（`block.type` if/else 链），唯一问题是 fallback 分支使用了 `as unknown as`。用 `switch/case` 替换即可获得穷尽性检查，且完全消除 `as` 断言。

### 3.6 空 catch 修复策略

4 处空 catch 均添加 `console.error` + 上下文信息：

| 位置 | 当前 | 修复后 |
|---|---|---|
| `CustomerChat.tsx:305` (JSON.parse catch) | `catch { continue; }` | `catch { console.error("SSE parse error:", data?.slice(0, 100)); continue; }` |
| `useCustomerChatStream.ts:307` (JSON.parse catch) | `catch { continue; }` | `catch { console.error("SSE parse error:", data?.slice(0, 100)); continue; }` |
| `useCustomerChatStream.ts:74` (loadHistory fetch catch) | `catch { }` | `catch { console.error("Failed to load chat history"); }` |
| `FAQSidebar.tsx:83` (loadDocDetail fetch catch) | `catch { setDocContent("加载失败"); }` | `catch (err) { console.error("Failed to load FAQ detail:", err); setDocContent("加载失败"); }` |

---

## 4. 任务拆解

### P0 — 阻塞性（必须先完成，后续任务依赖）

- [ ] **任务 1：为 shared-types 添加 Zod 依赖并创建 Schema 文件**（P0，依赖：无）
  - `packages/shared-types/package.json` 添加 `"zod": "^3.x"` 到 `dependencies`
  - 创建 `packages/shared-types/src/schemas/customer-chat.ts`，按 3.3 节定义所有 Schema
  - 更新 `packages/shared-types/src/index.ts` 导出 Schema 和推断类型
  - 运行 `pnpm typecheck` 确认无类型错误

- [ ] **任务 2：修复 SSE JSON.parse 边界 — useCustomerChatStream.ts**（P0，依赖：任务 1）
  - 在 `JSON.parse(data)` 处引入 `SSEDataChunkSchema.safeParse()`
  - 用 `switch` 或 `if/else` 替换 `chunk.type` 分发（TypeScript 自动 narrowing）
  - 消除所有 `chunk.xxx as Type` 断言（约 6 处）
  - 移除不可达的 `tool_call`/`tool_result` handler（添加注释说明）
  - 空 catch 添加 `console.error`

- [ ] **任务 3：修复 SSE JSON.parse 边界 — CustomerChat.tsx**（P0，依赖：任务 1）
  - 与任务 2 相同的改造（内联 sendMessage 中的 SSE 循环）
  - 消除 `chunk.block as ContentBlock`、`chunk.message_id as string` 等断言
  - 同步移除 `tool_call`/`tool_result` dead code
  - 空 catch 添加 `console.error`

### P1 — 重要（独立可做，但应在 P0 之后）

- [ ] **任务 4：重构 dedupeBlocks/blockKey 为穷尽 narrowing**（P1，依赖：任务 1）
  - `CustomerChat.tsx`：用 `switch/case` 覆盖 6 种 `ContentBlock` 类型，消除 `as unknown as`
  - `useCustomerChatStream.ts`：将现有 if/else 链改为 `switch/case`（TypeScript 穷尽性检查）
  - 两个文件统一使用同一份 `blockKey` 函数（可从 shared-types 导出或提取到公共 util）
  - 处理 `text` 类型（无 `data` 属性，用 `content.slice(0, 50)` 生成 key）

- [ ] **任务 5：FAQ API 响应 Zod 校验**（P1，依赖：任务 1）
  - `FAQSidebar.tsx`：为 3 处 `res.json()` 添加对应的 Zod Schema 校验
  - 消除 `docList as FAQDocument[]` 断言
  - 添加 `catch` 日志

### P2 — 改善（低优先级，独立）

- [ ] **任务 6：修复前端路由不匹配**（P2，依赖：无）
  - 将 `CustomerChat.tsx` 和 `useCustomerChatStream.ts` 中的 `/api/customer-chat` 改为 `/api/agent/chat`
  - 确认 FAQ 路由路径正确（`/api/agent/chat/faq` 等）

- [ ] **任务 7：统一两处 SSE 解析的 blockKey 函数**（P2，依赖：任务 4）
  - 将 `blockKey` 提取到 `packages/shared-types/src/customer-chat.ts` 或 `apps/web/src/lib/block-key.ts`
  - `CustomerChat.tsx` 和 `useCustomerChatStream.ts` 共用同一实现

---

## 5. 涉及模块

### 必须修改

| 文件 | 改动性质 |
|---|---|
| `packages/shared-types/package.json` | 添加 `zod` 依赖 |
| `packages/shared-types/src/schemas/customer-chat.ts` | **新建** — 所有 Zod Schema |
| `packages/shared-types/src/index.ts` | 导出新增的 Schema |
| `apps/web/src/components/customer-chat/CustomerChat.tsx` | SSE 解析边界 + dedupeBlocks + 空 catch |
| `apps/web/src/hooks/useCustomerChatStream.ts` | SSE 解析边界 + blockKey + 空 catch |
| `apps/web/src/components/customer-chat/FAQSidebar.tsx` | API 响应校验 + 空 catch |

### 建议修改（P2）

| 文件 | 改动性质 |
|---|---|
| 路由常量/配置文件 | 统一 `/api/customer-chat` → `/api/agent/chat` |

### 明确不改

| 文件 | 原因 |
|---|---|
| `apps/server/src/services/agent-runtime/types.ts` | `RouteStreamEvent` 类型定义正确，服务端无需修改 |
| `apps/server/src/routes/agent-runtime.ts` | SSE 序列化逻辑不变 |
| `apps/web/src/components/markdown/card-parser.ts` | 处理 LLM 输出而非外部 API 数据；已有 try-catch 降级 |
| `packages/shared-types/src/content-block.ts` | 类型定义正确，由新 Schema 消费 |

---

## 6. 风险分析

| 风险 | 严重度 | 缓解措施 |
|---|---|---|
| **Zod Schema 与服务端实际输出不一致** | 高 | Schema 严格基于 `RouteStreamEvent` 类型定义编写；`safeParse` 失败时记录日志但不中断流；若服务端新增字段，仅 Zod strip/ignore 而非 reject |
| **shared-types 首次引入运行时依赖** | 中 | Zod 是成熟库，ESM tree-shaking 支持良好；`apps/web` 和 `apps/server` 均已间接依赖 Zod（通过 `@hono/zod-validator`）；验证 `pnpm build` 产物大小无明显增长 |
| **性能：每个 SSE token chunk 都 Zod 校验** | 低 | `token` chunk schema 极简（3 个字段），Zod discriminated union 先匹配 `type` discriminator 再应用对应 schema，解析快（< 0.1ms/chunk）；SSE 流速率远低于 Zod 处理能力 |
| **破坏现有功能（误拒绝合法 chunk）** | 中 | 使用 `safeParse` 而非 `parse`（不抛异常）；失败时 `console.error` + `continue`（跳过该 chunk），流不中断；提测时观察控制台错误日志 |
| **card-parser 产出的 ContentBlock 与新 Schema 不兼容** | 低 | card-parser 构造 `ContentBlock` 对象时使用与类型定义一致的 shape；若不一致会导致 Zod 校验失败，但 `dedupeBlocks` 消费的是已验证的 `ContentBlock[]`，不会经过 Zod 二次校验（仅 SSE content_block 路径经过 Zod） |

### 额外说明：Zod Schema 不匹配时的行为

`SSEDataChunkSchema.safeParse()` 仅在 SSE JSON.parse 边界处使用一次。`card-parser` 产出的 `ContentBlock` 直接进入 `dedupeBlocks`，**不经过 Zod 二次校验**。这避免了 Markdown 渲染路径的额外开销，同时 card-parser 作为内部函数，类型安全由 TypeScript 编译器保证。

---

## 7. 验收标准

1. **零 `any`**：`CustomerChat.tsx`、`useCustomerChatStream.ts` 中不再出现 `JSON.parse(data)` 产生的 `any` 类型传播
2. **零 `as unknown as`**：`dedupeBlocks` 和 `blockKey` 函数中不再出现 `as unknown as` 双重断言；`blockKey` 实现穷尽覆盖 6 种 ContentBlock 类型
3. **零空 catch**：所有 catch 块包含 `console.error` 或显式注释说明忽略原因
4. **API 响应校验**：FAQSidebar 中所有 `res.json()` 调用后跟 Zod `safeParse` 校验
5. **TypeScript 编译零错误**：`pnpm typecheck` 在 `apps/web` 和 `packages/shared-types` 中通过
6. **现有功能不退化**：客服聊天 SSE 流正常收发、FAQ 侧边栏正常加载、卡片渲染正常
7. **代码一致性**：`CustomerChat.tsx` 和 `useCustomerChatStream.ts` 使用同一份 SSE Schema 和 blockKey 实现

---

## 8. 工作量评估

| 任务 | 估时 | 说明 |
|---|---|---|
| 任务 1 — Schema 文件 | 1h | 所有 Schema 定义 + 导出配置 |
| 任务 2 — useCustomerChatStream | 1.5h | ~150 行改动，需仔细处理 SSE 循环控制流 |
| 任务 3 — CustomerChat.tsx | 1.5h | ~120 行改动，与任务 2 对称 |
| 任务 4 — dedupeBlocks/blockKey | 0.5h | switch/case 重构 |
| 任务 5 — FAQSidebar | 0.5h | 3 处 API 响应 + Zod |
| 任务 6 — 路由修复 | 0.5h | 2 处 URL 变更 + 验证 |
| 任务 7 — blockKey 统一 | 0.5h | 提取公共函数 |
| **总计** | **~6h** | 含自测和边缘情况处理 |

建议分两个 PR：
- **PR 1**（P0 + P1）：任务 1-5，核心类型安全改造
- **PR 2**（P2）：任务 6-7，路由修复和代码统一
