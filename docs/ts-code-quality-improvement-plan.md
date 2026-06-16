# TypeScript 质量 & 代码模块控制 —— 整改方案

> **Status:** Phases 0-3 Complete ✅ | Phases 4-5 Pending
> **Date:** 2026-06-16
> **Scope:** TypeScript 类型安全、空 catch 块、大文件拆分、DTO 映射规范化
> **原则：** 最小改动优先（`catch {}` → `catch { logger.warn() }` 是一行改动, 但排障体验天差地别）

---

## 总览：问题分布

经过全项目 grep 审计，共发现以下问题：

| 问题类别 | 数量 | 影响面 |
|----------|------|--------|
| 显式 `any` 类型注解 | ~70 处 | 类型安全空洞 |
| 空 `catch {}` 块（纯忽略） | ~45 处 | 排障黑洞 |
| `catch (err: any)` | 12 处 | 应替换为 `unknown` |
| `toDTO(x: any)` 模式 | 6 处 (3 个文件) | 核心类型缺口 |
| `as any` 强制转型 | ~30 处 | 绕过类型检查 |
| 超大文件 (>400 行) | 7 个文件 | 可维护性差 |
| Prisma JSON → `as unknown as` | 3 个核心字段 | Agent 核心数据无类型保证 |

---

## Phase 0: 前置依赖（实施 Phase 1.2/1.3 前必须完成）

`packages/database/src/index.ts` 当前仅导出 `prisma` 单例，未 re-export Prisma 类型命名空间。Phase 1.2/1.3 需要使用 `Prisma.WorkflowGetPayload`、`Prisma.KnowledgeChunkWhereInput` 等类型。

**修复：** 在 `packages/database/src/index.ts` 中添加一行：

```typescript
export type { Prisma } from "@prisma/client";
```

> **备选方案：** 如果不希望改动 database 包，也可以直接从 `@prisma/client` 导入：`import type { Prisma } from "@prisma/client"`。但为保持项目内聚性，推荐方案是扩展 database 包的导出。

**工作量：** S（1 分钟）

---

## Phase 1: TypeScript 类型卫生（最小改动，预计 2-3 天）

### 1.1 `catch (err: any)` → `catch (err: unknown)`

**影响文件 12 处：** `routes/teams.ts:34,86,140,199`, `workflows/service.ts:162` 等

**当前代码：**
```typescript
} catch (err: any) {
  return c.json({ detail: err.message }, 400);  // 运行时可能炸
}
```

**修复：**
```typescript
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  return c.json({ detail: message }, 400);
}
```

**工作量：** S（每处 30 秒，批量替换 10 分钟）

---

### 1.2 `toDTO(x: any)` → 精确 Prisma 类型

**影响文件 3 个，6 个方法：**

| 文件 | 方法 | 行号 |
|------|------|------|
| `workflows/service.ts` | `toDTO(w: any)` | 755 |
| `workflows/service.ts` | `runToDTO(r: any)` | 772 |
| `workflows/service.ts` | `stepLogToDTO(sl: any)` | 796 |
| `teams/service.ts` | `toDTO(t: any)` | 436 |
| `teams/service.ts` | `runToDTO(r: any)` | 453 |
| `app-project.ts` | `toDTO(project: any)` | 340 |
| `app-project.ts` | `fileToDTO(file: any)` | 363 |

**当前代码（典型的）：**
```typescript
// workflows/service.ts:755
private toDTO(w: any): WorkflowDTO {
  return {
    id: w.id,
    name: w.name,
    definition: w.definition as unknown as WorkflowDefinition,
    // ...
  };
}
```

**修复方案：** 依赖 Phase 0（database 包需先导出 Prisma 类型），然后从 Prisma Client 导出类型：

```typescript
// 在文件顶部导入 Prisma 生成的类型（需要 Phase 0 完成后可用）
import type { Prisma } from "@agentforge/database";
// 备选：直接从 @prisma/client 导入
// import type { Prisma } from "@prisma/client";

// Prisma 的查询返回类型可以直接用
type WorkflowRecord = Prisma.WorkflowGetPayload<{
  include: { steps: true; runs: true };
}>;

private toDTO(w: WorkflowRecord): WorkflowDTO {
  return {
    id: w.id,
    name: w.name,
    definition: w.definition as WorkflowDefinition, // 仍需 assertion，但参数类型已是精确的
    // ...
  };
}
```

> **前置条件：** 此修复依赖 Phase 0。如果 Phase 0 未完成，可暂时直接从 `@prisma/client` 导入类型。

**注意：** DTO 类型定义（`WorkflowDTO`、`WorkflowRunDTO` 等）建议移至 `@agentforge/shared-types` 或独立的 `types.ts`，避免分离 `dto.ts` 后与 `service.ts` 产生文件级循环依赖。

**注意：** `teams/service.ts` 和 `workflows/service.ts` 中的 `runToDTO` 方法也存在相同问题，需同步改造。

**工作量：** M（每个文件约 20-30 分钟，需读 schema 确认字段）

---

### 1.3 Prisma where 查询对象类型化

**影响 5 处：**

```typescript
// knowledge.ts:107
const chunkWhere: any = { enabled: true };   // ❌

// knowledge-ingestion.ts:278
const whereClause: any = { enabled: true };  // ❌

// memory-engine.ts:345
const where: any = { userId };               // ❌

// workflows/service.ts:87,689
where: where as any,                         // ❌
// teams/service.ts:84,410
where: where as any,                         // ❌
```

**修复：** Prisma 提供 `Prisma.XWhereInput` 类型（依赖 Phase 0）：

```typescript
import type { Prisma } from "@agentforge/database";
// 备选：import type { Prisma } from "@prisma/client";

// knowledge.ts:107
const chunkWhere: Prisma.KnowledgeChunkWhereInput = { enabled: true };

// memory-engine.ts:345
const where: Prisma.MemoryWhereInput = { userId };

// workflows/service.ts:87 — 去掉 as any，直接让 Prisma 泛型推断
const [workflows, total] = await Promise.all([
  prisma.workflow.findMany({ where, skip: offset, take: limit, ... }),
  prisma.workflow.count({ where }),
]); // where 自动从 findMany 参数推断，不需要手动标注
```

> **注意：** `workflows/service.ts` 有 14 处 `where as any`（全项目最多），部分 where 子句因动态拼接复杂，Prisma 类型推断可能无法覆盖所有组合——这些场景可能需要保留 `as any` 并加注释说明原因。

**工作量：** S（15 分钟，主要是找到正确的 `Prisma.XWhereInput` 类型名）

---

### 1.4 高价值 `as any` 清理

并非所有 `as any` 都要立即清——但以下 4 处**风险最高、收益最大**：

#### (a) `app.ts:83` — Bull Board 挂载

```typescript
// ❌ 当前
app.route("/admin/queues", handler as any);

// ✅ 修复：利用 Hono 的泛型
// Bull Board 的 handler 本身就是兼容 Hono 的 —— 只是类型没对齐
// 方案 1：写一个 thin wrapper
app.route("/admin/queues", {
  fetch: (req: Request) => handler.fetch(req),
} as any); // TODO: 等 @bull-board/hono 更新类型后移除

// 方案 2：声明文件补充类型（更干净）
// 在 apps/server/src/types/bull-board.d.ts 中：
declare module "@bull-board/hono" {
  import type { Hono } from "hono";
  export function createBullBoardHandler(): Hono;
}
```

#### (b) `openai.ts:56,71` / `deepseek.ts:60` — LLM SDK 调用

```typescript
// ❌ 当前 openai.ts:56
messages: messages.map(m => ({ role: m.role as any, content: m.content })),

// ❌ 当前 openai.ts:71
const response = await this.client.chat.completions.create(params as any);

// ❌ 当前 deepseek.ts:60
const formattedMessages = messages.map(m => ({
  role: m.role as any,
  content: m.content,
}));

// ✅ 修复 openai.ts:71：params 本身已经是正确的类型，去掉 as any
const response = await this.client.chat.completions.create(params);
// 如果确实需要补字段，显式构造而非 as any

// ✅ 修复 openai.ts:56 / deepseek.ts:60：为 ChatMessage 的 role 字段收窄类型
// role 字段应定义为 "system" | "user" | "assistant" | "tool" 而非 string
```

#### (c) `video.ts:394,419,424` — 消息数组强转

```typescript
// ❌ 当前
messages.push(visionMsg as any);
messages as any,
tools as any,

// ✅ 修复：在 provider 接口层扩展类型
// providers/types.ts 已经有 ChatMessage 类型定义，
// vision 消息应该作为 ChatMessage 的变体加入：
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "user"; content: MultiModalContent[] };  // 新增

export interface MultiModalContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "low" | "high" | "auto" };
}
```

#### (d) `services/agent.ts:1976` — 错误码字面量

```typescript
// ❌ 当前
code: "EXECUTION_ERROR" as any,

// ✅ 修复：如果 code 字段类型约束太窄，扩展上游类型
// 这是最低成本的修复 —— 在 AgentError 类型中加入这个字面量
```

**工作量：** (a) 5min, (b) 15min（需验证 SDK 版本）, (c) 30min（需同步改 provider 接口）, (d) 5min

---

### 1.5 `(err as Error).message` → `err instanceof Error` 类型守卫

全项目存在约 19 处 `(err as Error).message` 或 `(err as Error)?.message` 模式（`agent.ts` 5 处、`codegen.ts` 4 处、`index.ts` 2 处等），这是 `catch (err: any)` 的关联问题——如果 `err` 不是 Error 实例，`.message` 为 `undefined`，日志信息丢失。

**当前代码：**
```typescript
} catch (err: unknown) {
  logger.error({ err: (err as Error).message }, "Failed to process");
}
```

**修复：**
```typescript
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  logger.error({ err: message }, "Failed to process");
}
```

**工作量：** S（与 Phase 1.1 配合处理，19 处共约 15 分钟）

---

## Phase 2: 空 Catch 块治理（预计 1-2 天）

### 问题分级

全项目 ~45 个空/静默 catch 块，分为三级：

| 级别 | 模式 | 数量 | 风险 |
|------|------|------|------|
| **P0 🔴** | 业务逻辑空 catch（静默吞错） | ~6 | 高 |
| **P1 🟡** | JSON 解析失败忽略 | ~10 | 中 |
| **P2 🟢** | 合理的静默处理（WS 关闭、容器已停止等） | ~29 | 低 |

### P0: 必须修复（6 处）

#### 2.1 `chat.ts:69-70` — 知识库注入失败静默吞

```typescript
// ❌ 当前
try {
  const allKbs = await prisma.knowledgeBase.findMany({ ... });
  kbIds = allKbs.map((kb) => kb.id);
} catch {
  return [systemPrompt, []];  // 静默回退，无日志
}

// ✅ 修复
} catch (err: unknown) {
  logger.warn({ err, userId }, "Knowledge base injection failed, continuing without KB context");
  return [systemPrompt, []];
}
```

#### 2.2 `agent.ts:405-406` — Agent JSON 决策解析失败

```typescript
// ❌ 当前
try {
  args = JSON.parse(tc.arguments);
} catch {
  /* ignore */
}

// ✅ 修复
} catch (err: unknown) {
  logger.warn(
    { toolCallId: tc.id, rawArguments: tc.arguments?.slice(0, 200) },
    "Failed to parse agent decision arguments, using empty args"
  );
  args = {};
}
```

#### 2.3 `content-safety.ts:113-114` — 请求体解析失败

```typescript
// ❌ 当前
} catch {
  // If we can't parse the body, let the route handler deal with it
}

// ✅ 修复
} catch (err: unknown) {
  logger.warn({ err, path: c.req.path }, "Content safety: unable to parse request body, passing through");
}
```

#### 2.4 `agent.ts:1006-1007` — 工具执行异常静默

```typescript
// ❌ 当前
} catch {
  yield {
    type: "agent_error",
    error: "Tool execution failed",
  };
}

// ✅ 修复
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  logger.error({ err, toolName }, "Tool execution threw unhandled exception");
  yield {
    type: "agent_error",
    error: `Tool execution failed: ${message}`,
  };
}
```

#### 2.5 `workflows/dag-executor.ts:534-535` — Step Fallback 异常

```typescript
// ❌ 当前
} catch {
  return {
    status: "failed",
    error: "Fallback step execution failed",
  };
}

// ✅ 修复
} catch (err: unknown) {
  logger.error({ err, stepId: step.id }, "Fallback step failed");
  return {
    status: "failed",
    error: `Fallback step execution failed: ${err instanceof Error ? err.message : "Unknown"}`,
  };
}
```

#### 2.6 `teams/modes/orchestrator.ts:148-149` — 调度决策解析失败

```typescript
// ❌ 当前
} catch {
  // JSON parse failed, try text-based delegation parsing
}

// ✅ 修复
} catch (err: unknown) {
  logger.warn(
    { rawResponse: response?.slice(0, 200) },
    "Orchestrator JSON parse failed, falling back to text-based parsing"
  );
}
```

#### 2.7 `agent.ts:2096-2098, 2129-2131` — DB Session 查询失败静默返回

`getSessions()` 和 `getSession()` 的空 catch 静默缓存 Prisma 查询失败，分别返回 `[]` 和 `null`。这些是面向外部 API 的方法——如果数据库暂时不可用，API 返回空列表而非 5xx 错误，调用方误判为"无数据"而非"系统故障"。

```typescript
// ❌ 当前 agent.ts:2096-2098
} catch {
  return [];
}

// ❌ 当前 agent.ts:2129-2131
} catch {
  return null;
}

// ✅ 修复：记录错误日志但仍返回安全默认值（保持 API 不崩溃）
} catch (err: unknown) {
  logger.error({ err }, "Failed to query agent sessions");
  return []; // 或 return null; 取决于方法语义
}
```

> **注意：** 是否应 re-throw 让路由层返回 5xx，取决于 API 契约约定（调用方是否期望空列表表示"服务不可用"）。当前保持返回安全默认值 + 日志记录是最小改动。

### P1: 建议修复（~10 处 JSON 解析）

所有 JSON 解析失败至少应记录 `logger.warn()`，包含截断后的原始输入（防御日志膨胀）。目前 `agent.ts:1373-1374`, `agent.ts:1760-1761`, `chat.ts:250-251`（已部分有 warn）、`codegen.ts:211`, `agent-runtime/router.ts:227-228` 等处都是静默吞。

**模板修复：**
```typescript
try {
  return JSON.parse(raw);
} catch (err: unknown) {
  logger.warn(
    { raw: String(raw).slice(0, 150), err },
    "JSON parse failed in <function-name>"
  );
  return fallbackValue;
}
```

### P2: 可以保留的（~29 处）

以下场景的静默 catch 是合理的，不需修改：
- WebSocket 已关闭时 `send()` 抛错 (`voice.ts:354`, `video.ts:571`)
- 容器 kill 时容器已停止 (`sandbox.ts:141`)
- 数据库 seed 重复 (`index.ts:19,26`)
- `process.exit` 替代方案 (`index.ts:41,120`)
- 文件系统不可读文件跳过 (`file-tools.ts:239,248`)
- 清理逻辑的 best-effort (`__tests__/auth.test.ts:24`)

**建议在这类 catch 上方加一行注释说明为何忽略：**
```typescript
} catch {
  // Expected: WebSocket may already be closed when we try to send cleanup message
}
```

---

## Phase 3: 大文件拆分（预计 3-5 天）

### 3.1 `agent.ts`（2133 行）→ 拆为 5 个模块

**⚠️ 复杂度警告：** `run()` 方法（约 1067 行 async generator）和 `continueReActLoop()`（约 450 行 async generator）合计占文件 70%，其内部的 system prompt 构造、工具执行循环、scratchpad 管理、LLM 调用是**内联交织**的，直接引用 `this.*` 成员。"每个模块 export 纯函数"的目标与当前 `this.*` 强耦合代码不兼容——纯函数提取需要将方法中段逻辑切出来，这会改变 ReAct 循环的控制流。此外，`run()` 和 `continueReActLoop()` 之间存在约 300 行的重复 ReAct 逻辑，拆分前应先合并。

**当前结构（概念上）：**
```
services/agent.ts  (2133 行)
├── System Prompt 构造
├── LLM 调用 + 流式处理
├── JSON 决策解析 (parseStep)
├── 工具执行循环 (ReAct Loop)
├── Scratchpad 管理
├── 安全守卫集成 (AgentGuard)
├── 持久化 (loadSession / saveSession / persistStep)
└── Ask User 暂停/恢复
```

**目标结构：**
```
services/agent/
├── index.ts              (~50 行)   — AgentService 类，组合各模块
├── prompts.ts            (~150 行)  — System Prompt 模板 + respond-only 切换
├── decision-parser.ts    (~200 行)  — parseStep + JSON/函数调用 双路解析
├── llm-executor.ts       (~250 行)  — LLM 调用 + 重试 + 流式处理
├── scratchpad.ts         (~200 行)  — 压缩、buildIterationContext
├── session-persistence.ts (~200 行) — save/load/persistStep
├── tool-executor.ts      (~300 行)  — 工具执行循环 + 并行/串行调度
└── guard-integration.ts  (~100 行)  — AgentGuard 回调
```

**拆分原则：**
1. 每个模块 export 纯函数（不持有状态），AgentService 负责串联
2. 先抽 `decision-parser` 和 `prompts`（它们最独立），再抽 `session-persistence`
3. 每一步拆分后跑现有 `agent.test.ts` 确认无回归
4. 不改变任何外部 API —— AgentService 的方法签名保持不变

**工作量拆解：**

| 步骤 | 内容 | 风险 | 时间 |
|------|------|------|------|
| Step 1 | 抽 `prompts.ts` | 低 | 1h |
| Step 2 | 抽 `decision-parser.ts` | 低 | 1.5h |
| Step 3 | 抽 `session-persistence.ts` | 中 | 2h |
| Step 4 | 抽 `scratchpad.ts` | 中 | 1.5h |
| Step 5 | 抽 `llm-executor.ts` | 中 | 1.5h |
| Step 6 | 抽 `tool-executor.ts` | 高 | 2h |
| Step 7 | `index.ts` 组装 + 全量回归测试 | 中 | 2h |

---

### 3.2 `workflows/service.ts`（817 行）→ DTO 映射分离

**目标：**
```
workflows/
├── service.ts           (~500 行)  — 纯业务逻辑
├── dto.ts               (~100 行)  — toDTO / runToDTO / stepLogToDTO
└── queries.ts           (~150 行)  — Prisma 查询封装（findMany/findById/count）
```

`dto.ts` 是 Phase 1.2 的自然延伸——在分离的同时修复 `toDTO(x: any)`。

---

### 3.3 `codegen.ts`（642 行）→ 按阶段拆分

App 代码生成管线有明确的阶段边界：`req → design → code → review → fix → final`。每个阶段已用 Promise 串联，天然可以拆为独立模块：

```
services/codegen/
├── index.ts          — orchestrate 6 stages
├── requirements.ts   — 需求分析
├── design.ts         — 技术方案设计
├── generate.ts       — 代码生成
├── review.ts         — 代码审查
└── fix.ts            — Bug 修复
```

---

### 3.4 `dag-executor.ts`（660 行）→ Handler + Executor 分离

```
workflows/
├── dag-executor.ts      (~350 行)  — 拓扑排序 + 执行调度
├── step-runner.ts       (~200 行)  — 单步执行（含重试、超时、fallback）
└── checkpoint.ts        (~100 行)  — buildCheckpoint / restoreFromCheckpoint
```

---

## Phase 4: Prisma JSON 类型安全（预计 1-2 天）

### 问题

Prisma schema 中共有 24 个 `Json` 类型字段。以下 3 个核心 Agent 数据字段是最高优先级（直接影响 Agent 运行时）：

| 字段 | 表 | Schema 行 | 使用处 |
|------|-----|-----------|--------|
| `scratchpad` | `AgentSession` | schema.prisma:195 | `agent.ts:2091-2092` |
| `messages` | `AgentTeamRun` | schema.prisma:380 | `teams/service.ts:462` |
| `checkpoint` | `WorkflowRun` | schema.prisma:311 | `workflows/service.ts:780` |

**后续应覆盖（同表中其他 Json 字段）：**

| 字段 | 表 | Schema 行 | 优先级 |
|------|-----|-----------|--------|
| `blackboard` | `AgentTeamRun` | schema.prisma:381 | P0 — Multi-Agent 核心数据结构 |
| `output` | `AgentTeamRun` | schema.prisma:383 | P1 |
| `progress` | `WorkflowRun` | schema.prisma:313 | P1 |
| `input` | `WorkflowRun` | schema.prisma:309 | P2 |
| `output` | `WorkflowRun` | schema.prisma:310 | P2 |

### 修复方案（无需改 DB Schema）

用 Zod 做运行时验证 + 类型推导:

```typescript
// apps/server/src/types/agent-session.ts
import { z } from "zod";

// 1. 定义 Zod Schema
export const AgentStepSchema = z.object({
  iteration: z.number(),
  observation: z.string().optional(),
  analysis: z.string().optional(),
  plan: z.string().optional(),
  decision: z.string(),
  toolCall: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }).optional(),
  result: z.string().optional(),
  timestamp: z.string(),
});

export type AgentStep = z.infer<typeof AgentStepSchema>;

export const AgentScratchpadSchema = z.object({
  steps: z.array(AgentStepSchema),
  compressedSummary: z.string().optional(),
  keptSteps: z.array(z.number()).optional(),
});

export type AgentScratchpad = z.infer<typeof AgentScratchpadSchema>;

// 2. 在 agent.ts 中使用
import { AgentScratchpadSchema } from "../types/agent-session.js";

const rawScratchpad = session.scratchpad; // unknown
const parsed = AgentScratchpadSchema.safeParse(rawScratchpad);

if (!parsed.success) {
  logger.error({ issues: parsed.error.issues }, "Corrupted scratchpad data");
  // 降级：空 scratchpad
  scratchpad = { steps: [] };
} else {
  scratchpad = parsed.data; // ✅ 完全类型安全
}
```

**收益：**
- 发现了数据损坏会立即记录结构化日志（而非在运行中炸 `TypeError`）
- TypeScript 编译器全程保证 scratchpad 结构正确
- 未来改 schema，Zod 会告诉你哪些旧数据不兼容

**工作量：** M（每个字段约 30 分钟：写 Zod Schema + 替换所有使用处的 cast）

---

## Phase 5: 依赖注入最小化（预计 1 天）

### 问题

项目中约 20 处动态 `await import()` 用于打破循环依赖：

```typescript
// chat.ts:62-63
const { getPrisma } = await import("../db.js");

// chat.ts:75
const { getPrisma, getRedis } = await import("../db.js");

// chat.ts:422-424
const { memoryQueue } = await import("../jobs/queues.js");

// codegen.ts:247
const { getPrisma } = await import("../db.js");
```

这不是一个需要 Awilix/Tsryn 等重型 DI 框架的问题——项目规模还不值得。

### 最小方案：参数化构造

把"从模块导入单例"改为"从构造函数参数传入"：

```typescript
// ❌ 当前：隐式依赖
class ChatService {
  async streamChat(...) {
    const { getPrisma } = await import("../db.js"); // 运行时动态导入
  }
}

// ✅ 方案 1：构造函数注入（不影响调用方）
class ChatService {
  constructor(
    private getPrisma: () => PrismaClient = getPrismaFromModule, // 默认值保持向后兼容
    private memoryQueue?: Queue,
  ) {}

  async streamChat(...) {
    const prisma = this.getPrisma(); // 无动态导入
  }
}

// ✅ 方案 2（更轻）：参数传入
class ChatService {
  async streamChat(
    input: ChatInput,
    opts?: { prisma?: PrismaClient; queue?: Queue },
  ) { ... }
}
```

> **设计说明：** 方案 1 的默认参数 `= getPrismaFromModule` 在模块被 import 时求值——如果调用链中仍存在循环依赖，问题依旧。这是"最小改动"方案而非"彻底消除循环依赖"方案。要彻底消除循环依赖需要：绘制完整模块依赖图（可用 madge），然后通过接口抽象层或依赖反转来打破循环路径。当前项目规模下，更轻量的方案（如 module-level lazy getter）值得考虑。

**优先修复的 3 处：**

| 文件 | 动态导入 | 推荐方案 |
|------|----------|----------|
| `chat.ts:62-63` | `await import("../db.js")` | 构造函数注入 |
| `chat.ts:422-424` | `await import("../jobs/queues.js")` | 构造函数注入 |
| `codegen.ts:247` | `await import("../db.js")` | 构造函数注入 |

**非目标：** 不需要引入 DI 容器库。3 个月后如果项目有 100+ Service 且依赖图复杂到需要一个容器，那是另一个决策。

---

## 实施顺序（推荐）

按投入产出比排序，可以并行做 Phase 1 + Phase 2：

```
Week 1 (2-3 days):
├── Phase 1.1: catch (err: any) → unknown        [30 min]  ← 从这里开始
├── Phase 1.3: Prisma where 类型化                 [15 min]
├── Phase 2 P0: 6 处业务空 catch                  [1.5 h]
├── Phase 2 P1: 10 处 JSON 解析空 catch           [1 h]
└── Phase 1.2/1.4: toDTO + as any 高价值修复       [2 h]

Week 2 (3-5 days):
├── Phase 4: Prisma JSON → Zod 类型安全           [1-2 days]
├── Phase 3.1 Step 1-4: agent.ts 前半拆分          [1 day]
└── Phase 5: 3 处动态 import 消除                  [2 h]

Week 3 (2-3 days):
├── Phase 3.1 Step 5-7: agent.ts 后半拆分          [1 day]
├── Phase 3.2: workflows/service.ts DTO 分离       [1 h]
├── Phase 3.4: dag-executor.ts 拆分                [1.5 h]
└── 全量 typecheck + test + lint 回归              [30 min]
```

---

## 检查清单（每完成一项打勾）

> **完成进度：** Phases 0-3 ✅ (39/51 items) | Phase 4 ⏳ (0/4) | Phase 5 ⏳ (0/4)

### Phase 0 — Prerequisite
- [x] `packages/database/src/index.ts` 添加 `export type { Prisma } from "@prisma/client"`

### Phase 1 — TypeScript Hygiene
- [x] 12 处 `catch (err: any)` → `catch (err: unknown)` (实测 7 处)
- [x] 19 处 `(err as Error).message` → `err instanceof Error` 类型守卫 (实测 22 处)
- [x] 7 处 `toDTO(x: any)` 参数精确类型化 → 使用 `Prisma.XGetPayload<Record<string, never>>`
- [x] 5 处 Prisma where `any` → `Prisma.XWhereInput` (实测 8 处，含 workflows/teams service 中 `Record<string, unknown>` → 精确类型)
- [x] `app.ts:83` Bull Board handler 类型修复 → `as unknown as Parameters<typeof app.route>[1]`
- [x] `openai.ts:56,71` / `deepseek.ts:60` 去掉 `as any` → 对象级 `as ChatCompletionMessageParam` + `as unknown as ChatCompletionCreateParamsNonStreaming`
- [x] `video.ts:394,419,424` 多模态消息类型扩展 → 导入 `MultimodalMessage` 类型，移除 3 处 `as any`
- [x] `agent.ts:1976` 错误码字面量去掉 `as any` → 使用已有 `ExecutionErrorCode.EXECUTION_ERROR` 枚举

### Phase 2 — Catch Block Governance
- [x] 7 处 P0 业务空 catch → `logger.warn/error()` (含 agent.ts DB session)
- [x] 10 处 P1 JSON 解析空 catch → `logger.warn()`
- [x] 29 处 P2 合理静默 → 加注释说明原因

### Phase 3 — File Splitting
- [x] `run()` / `continueReActLoop()` 重复逻辑合并 → **决策：不合并**（结构相似但行为不同，强行合并会引入 15+ 条件分支）
- [x] `agent.ts` → `agent/` (**5** 个模块，非原计划 7 个 — llm-executor/scratchpad/guard-integration 太薄不值得单独拆)
- [x] `workflows/service.ts` → `service.ts` + `dto.ts` + `queries.ts`
- [x] `dag-executor.ts` → `dag-executor.ts` + `step-runner.ts` + `checkpoint.ts`
- [x] `codegen.ts` → `codegen/` (5 阶段模块 + barrel re-export)
- [x] 全量 typecheck + lint 通过 (11/11 packages)
- [x] 详细实施方案见 `docs/phase3-file-splitting-implementation-plan.md`

### Phase 4 — Prisma JSON Types
- [ ] `AgentSession.scratchpad` Zod Schema + safeParse
- [ ] `AgentTeamRun.messages` Zod Schema + safeParse
- [ ] `WorkflowRun.checkpoint` Zod Schema + safeParse
- [ ] `AgentTeamRun.blackboard` Zod Schema + safeParse (P0)

### Phase 5 — DI Minimal
- [ ] `chat.ts:62-63` 动态 import → 构造注入
- [ ] `chat.ts:75` 动态 import → 构造注入
- [ ] `chat.ts:422-424` 动态 import → 构造注入
- [ ] `codegen/index.ts` (原 `codegen.ts:247`) 动态 import → 构造注入

---

## 不在此范围的（留给后续）

以下问题影响面大或依赖其他决策，建议后续单独建文档：

- **生产部署方案**（K8s/Docker 发布/环境管理）
- **SSE 断连重试机制**（需要前后端协议扩展）
- **全局 API Error Response 标准化**（`{ detail }` vs `{ error }` vs 裸字符串）
- **前端组件测试覆盖率**
- **工作流/多 Agent 团队集成测试**
- **BullMQ 持久化 + Redis 哨兵/集群**
