# Phase 3: 大文件拆分 — 详细实施方案

> **Status:** Ready for Implementation
> **Date:** 2026-06-16
> **Depends on:** Phase 0 (Prisma type export) — already complete ✅
> **Target:** 4 files → 14 new sub-modules（含 2 个 barrel re-export），零 API 变更，无循环依赖

---

## 总览

| 序号 | 源文件 | 行数 | 目标模块数 | 风险 | 外部导入者 | 预计时间 |
|------|--------|------|-----------|------|-----------|----------|
| 1 | `dag-executor.ts` | 660 | 3 | 低 | 1 | 1.5h |
| 2 | `codegen.ts` | 642 | 5 | 低 | 1 | 2h |
| 3 | `workflows/service.ts` | 817 | 3 | 中 | 1 | 2h |
| 4 | `agent.ts` | 2133 | 5 | 高 | 10 | 8-10h |

**关键约束：** 所有拆分不改变外部 API。外部导入者继续 `import { AgentService } from "../services/agent.js"`（通过 barrel re-export 保持兼容）。

---

## 1. dag-executor.ts（660 行）→ 3 个模块

### 1.1 当前结构分析

**文件：** `apps/server/src/workflows/dag-executor.ts`

```
接口/类型:
  DAGExecutionContext  (L23-35)   — extends StepContext, adds definition/emit/pauseForApproval
  CheckpointData       (L37-48)   — 被 workflows/service.ts import
  LevelPlan            (L50-53)   — 私有接口，仅内部使用

类 DAGExecutor:
  handlers             (L58)      — Record<string, StepHandler>，构造函数中初始化
  execute()            (L81-253)  — async generator，主入口
  executeWithSkip()    (L259-419) — async generator，从 checkpoint 恢复
  topologicalSort()    (L425-463) — 纯函数，public
  executeWithRetry()   (L468-556) — private，含重试/超时/fallback
  executeSingleStepWithTimeout() (L561-584) — private
  executeSingleStep()  (L589-611) — public，单个 step 调度到 handler
  buildCheckpoint()    (L616-638) — public，纯函数
  calculateRetryDelay() (L642-659) — private，纯函数
  sleep()              (L661-663) — private，纯函数
```

**依赖链：**
```
execute / executeWithSkip
  → topologicalSort()          [纯函数，无 this]
  → executeWithRetry()         [private]
    → executeSingleStepWithTimeout()
      → executeSingleStep()
        → this.handlers[step.type]  [需要 handlers map]
    → calculateRetryDelay()    [纯函数]
    → sleep()                  [纯函数]
buildCheckpoint()              [纯函数，无 this]
```

### 1.2 拆分方案

**原则：** DAGExecutor 公开 API 不变（`execute`, `executeWithSkip`, `topologicalSort`, `buildCheckpoint`, `executeSingleStep`）。内部实现委托给独立模块的函数。

#### 新文件 1: `workflows/checkpoint.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `CheckpointData` | interface | dag-executor.ts L37-48 |
| `buildCheckpoint()` | 纯函数 | dag-executor.ts L616-638 |

**函数签名（从 private 方法变为导出函数，参数不变）：**
```typescript
export function buildCheckpoint(
  runId: string,
  workflowId: string,
  completedStepIds: string[],
  pendingStepIds: string[],
  stepLogs: StepResult[],
  variables: Record<string, unknown>,
  stepResults: Record<string, unknown>,
  totalSteps: number,
): CheckpointData
```

**Import 需求：**
```typescript
// checkpoint.ts 依赖
import type { StepResult } from "@agentforge/shared-types";
```

**预计行数：** ~30 行

---

#### 新文件 2: `workflows/step-runner.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `executeWithRetry()` | 导出纯函数 | dag-executor.ts L468-556 |
| `executeSingleStepWithTimeout()` | 导出纯函数 | dag-executor.ts L561-584 |
| `executeSingleStep()` | 导出纯函数 | dag-executor.ts L589-611 |
| `calculateRetryDelay()` | 导出纯函数 | dag-executor.ts L642-659 |
| `sleep()` | 导出纯函数 | dag-executor.ts L661-663 |

**关键变更：** 原 `executeSingleStep()` 访问 `this.handlers`。提取后改为接收 `handlers` 参数：

```typescript
// step-runner.ts — 纯函数签名
export async function executeSingleStep(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,  // 新增参数
): Promise<StepResult>

export async function executeWithRetry(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,  // 新增参数
  definition?: WorkflowDefinition,
): Promise<StepResult>

export async function executeSingleStepWithTimeout(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,  // 新增参数
): Promise<StepResult>

export function calculateRetryDelay(
  retry: { backoff: string; initialDelay: number; maxDelay: number },
  attempt: number,
): number

export function sleep(ms: number): Promise<void>
```

**Import 需求：**
```typescript
// step-runner.ts 依赖
import type { WorkflowStep, StepResult, WorkflowDefinition } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import type { StepHandler, StepContext } from "./handlers/index.js";
```

**预计行数：** ~200 行

---

#### 修改: `workflows/dag-executor.ts`

**保留内容：**

| 项目 | 说明 |
|------|------|
| `DAGExecutionContext` interface | 保留（被 service.ts import） |
| `LevelPlan` interface | 保留（私有） |
| `DAGExecutor` class | 保留，但改为委托模式 |
| `handlers` 属性 + `constructor` | 保留 |
| `execute()` | 保留，改为调用 `executeWithRetry()` 函数 |
| `executeWithSkip()` | 保留，改为调用 `executeWithRetry()` 函数 |
| `topologicalSort()` | 保留（它不依赖 other private methods） |
| `buildCheckpoint()` | 改为 thin wrapper，委托给 checkpoint.ts |
| `executeSingleStep()` | 改为 thin wrapper，委托给 step-runner.ts |

**构造函数中的 handlers 初始化逻辑不变，但 `ParallelStepHandler` 回调需要适配：**

```typescript
// 原 constructor
constructor() {
  const parallelHandler = new ParallelStepHandler(
    (step: WorkflowStep, ctx: StepContext) =>
      this.executeSingleStep(step, ctx),  // 原
  );
  // ...
}

// 新 constructor — executeSingleStep 改为接收 handlers 的纯函数
constructor() {
  const parallelHandler = new ParallelStepHandler(
    (step: WorkflowStep, ctx: StepContext) =>
      executeSingleStepFn(step, ctx, this.handlers),  // 新
  );
  // ...
}
```

**新增 import + re-export（保证 workflows/service.ts 的类型导入不受影响）：**
```typescript
import {
  buildCheckpoint as buildCheckpointFn,
  // CheckpointData 类型仍从 dag-executor.ts 导出，因为 workflows/service.ts 从此文件 import 它
} from "./checkpoint.js";
import {
  executeWithRetry as executeWithRetryFn,
  executeSingleStep as executeSingleStepFn,
} from "./step-runner.js";

// Re-export 从子模块移出的类型，确保外部导入者不受影响
export type { CheckpointData } from "./checkpoint.js";
```

**`execute()` / `executeWithSkip()` 中直接调用纯函数：**

`execute()` 和 `executeWithSkip()` 内部原调用 `this.executeWithRetry(step, context, definition)`，改为直接调用 `executeWithRetryFn(step, context, this.handlers, definition)`，消除 thin wrapper 中间层。`buildCheckpoint()` 同理直接调用 `buildCheckpointFn(...)`。

**保留的 thin wrapper（仅公开 API）：**
```typescript
// 公开的 executeSingleStep 保留为 thin wrapper，参数签名与外部调用者兼容
async executeSingleStep(step: WorkflowStep, context: StepContext): Promise<StepResult> {
  return executeSingleStepFn(step, context, this.handlers);
}
```

*设计说明：`executeSingleStep` 是 DAGExecutor 的公开方法，外部 caller（如 workflow handler 的 callback）可能直接调用它。保留 thin wrapper 避免变更公开 API 签名。`executeWithRetry` 改为直接调用纯函数可减少一层不必要的间接调用。*

**预计行数：** ~310 行（原 660 → 移除 ~350 行移至新文件）

---

### 1.3 Import 图谱（拆分后）

```
workflows/service.ts
  → dag-executor.ts         (import { DAGExecutor, type CheckpointData, type DAGExecutionContext })
    → checkpoint.ts          (import { buildCheckpoint } — 仅 dag-executor 内部用)
    → step-runner.ts         (import { executeWithRetry, executeSingleStep } — 仅 dag-executor 内部用)
    → handlers/index.ts      (import type { StepHandler, StepContext })
```

无循环依赖。

### 1.4 执行步骤

| 步骤 | 操作 | 风险 | 验证 |
|------|------|------|------|
| 1.1 | 创建 `checkpoint.ts`，移动 `CheckpointData` + `buildCheckpoint` | 低 | `pnpm typecheck --filter @agentforge/server` |
| 1.2 | 在 `dag-executor.ts` 中 import checkpoint.ts，删除原定义，添加 thin wrapper | 低 | typecheck |
| 1.3 | 创建 `step-runner.ts`，移动 `executeWithRetry` / `executeSingleStepWithTimeout` / `executeSingleStep` / `calculateRetryDelay` / `sleep`，添加 `handlers` 参数 | 中 | typecheck |
| 1.4 | 在 `dag-executor.ts` 中 import step-runner.ts，替换 private methods 为 thin wrappers，修改 constructor 回调 | 中 | typecheck |
| 1.5 | 全量回归 | 低 | `pnpm typecheck && pnpm lint` |

---

## 2. codegen.ts（642 行）→ 5 个模块

### 2.1 当前结构分析

**文件：** `apps/server/src/services/codegen.ts`

```
常量:
  PLAN_SYSTEM_PROMPT       (L24-48)   — 架构设计 prompt
  GENERATE_SYSTEM_PROMPT   (L50-67)   — 代码生成 prompt
  REVIEW_SYSTEM_PROMPT     (L69-75)   — 代码审查 prompt
  MAX_TOKENS_PLAN          (L17)      — 4000
  MAX_TOKENS_FILE          (L18)      — 8000

类 CodeGenService:
  generate()               (L84-238)  — 主编排器，async generator
  getProjectName()         (L240-252) — private utility
  planAppStructure()       (L257-291) — Phase 1：规划
  generateFile()           (L296-360) — Phase 2：生成单个文件
  reviewApp()              (L365-417) — Phase 3：审查
  callLLM()                (L422-455) — 共享 LLM 调用，collect tokens
  extractFilePlan()        (L460-509) — JSON 解析
  detectLang()             (L511-530) — 纯函数，扩展名→语言
  extractFileContent()     (L535-591) — FILE: marker 解析
  getDefaultPlan()         (L596-641) — 默认回退
```

**方法调用关系：**
```
generate()
  → getProjectName()
  → planAppStructure()
    → callLLM()
    → extractFilePlan()
      → detectLang()
  → generateFile()          [在 for 循环中调用]
    → callLLM()
    → extractFileContent()
  → reviewApp()
    → callLLM()
  → getDefaultPlan()        [fallback]
```

**外部导入者：** 仅 `routes/app-project.ts`（`import { codeGenService } from "../services/codegen.js"`）

### 2.2 拆分方案

按照职责边界拆为 5 个模块。每个模块导出纯函数，`index.ts` 中的 `CodeGenService` 类委托调用。

**文件组织策略：** 原 `services/codegen.ts` 将被删除，替换为 `services/codegen/index.ts`。这与 `agent-runtime` 模式一致（`services/agent-runtime/` 目录 + `services/agent-runtime.ts` barrel 并存）。外部导入者 `routes/app-project.ts` 的 import 路径 `"../services/codegen.js"` 在 Node 模块解析下将自然解析到 `codegen/index.ts`（目录优先于文件）。

#### 新文件 1: `services/codegen/prompts.ts`

**内容：**

| 项目 | 说明 |
|------|------|
| `PLAN_SYSTEM_PROMPT` | 常量 |
| `GENERATE_SYSTEM_PROMPT` | 常量 |
| `REVIEW_SYSTEM_PROMPT` | 常量 |
| `MAX_TOKENS_PLAN` | 常量 |
| `MAX_TOKENS_FILE` | 常量 |
| `LANG_GUIDES` | 从 `generateFile()` L303-310 提取的语言指导 map |

**预计行数：** ~80 行

---

#### 新文件 2: `services/codegen/llm.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `callLLM()` | 导出纯函数 | codegen.ts L422-455 |

**函数签名：**
```typescript
export async function callLLM(
  messages: ChatMessage[],
  model: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string>
```

> **注意：** `messages` 参数当前使用 `ChatMessage` 类型（来自 `providers/types.ts`），需要确认是否包含 `tool_calls` 字段 — 当前 codegen 只用简单的 `{ role, content }` 消息。如需更精确的类型，可定义 `CodeGenMessage = { role: string; content: string }`。

**Import 需求：**
```typescript
import { getProvider, resolveModel } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
```

**导出类型别名（DRY — 避免三处重复定义 callLLM 参数签名）：**
```typescript
export type CodeGenLLMCaller = (
  messages: ChatMessage[],
  model: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
) => Promise<string>;
```

**预计行数：** ~55 行

---

#### 新文件 3: `services/codegen/plan.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `planAppStructure()` | 导出纯函数 | codegen.ts L257-291 |
| `extractFilePlan()` | 导出纯函数 | codegen.ts L460-509 |
| `detectLang()` | 导出纯函数 | codegen.ts L511-530 |
| `getDefaultPlan()` | 导出纯函数 | codegen.ts L596-641 |

**`planAppStructure` 接收 `callLLM` 作为参数（避免循环依赖）：**
```typescript
import type { CodeGenLLMCaller } from "./llm.js";

export async function planAppStructure(
  prompt: string,
  framework: string,
  model: string,
  callLLM: CodeGenLLMCaller,
): Promise<AppFilePlan[] | null>
```

**Import 需求：**
```typescript
import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan, ProjectLanguage } from "@agentforge/shared-types";
import { parseJSONFromLLMResponse } from "../../lib/json-utils.js";
import { logger } from "@agentforge/logger";
```

**预计行数：** ~170 行

---

#### 新文件 4: `services/codegen/generate.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `generateFile()` | 导出纯函数 | codegen.ts L296-360 |
| `extractFileContent()` | 导出纯函数 | codegen.ts L535-591 |

**`generateFile` 接收 `callLLM` 和 `langGuides`：**
```typescript
import type { CodeGenLLMCaller } from "./llm.js";

export async function generateFile(
  filePlan: AppFilePlan,
  appPrompt: string,
  framework: string,
  model: string,
  callLLM: CodeGenLLMCaller,
  langGuides: Record<string, string>,
): Promise<{ content: string; tokens: number }>
```

**Import 需求：**
```typescript
import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
```

**预计行数：** ~120 行

---

#### 新文件 5: `services/codegen/review.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `reviewApp()` | 导出纯函数 | codegen.ts L365-417 |

**函数签名：**
```typescript
import type { CodeGenLLMCaller } from "./llm.js";

export async function reviewApp(
  plan: AppFilePlan[],
  projectId: string,
  model: string,
  callLLM: CodeGenLLMCaller,
  getFiles: (projectId: string) => Promise<Array<{ path: string; content: string }>>,
): Promise<string>
```

**Import 需求：**
```typescript
import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
```

**预计行数：** ~70 行

---

#### 修改: `services/codegen/index.ts`

**内容：**

```typescript
// Re-export singleton for backward compatibility
export { codeGenService } from "./codegen-service.js";
// 或直接在 index.ts 中定义 CodeGenService 类
```

**`CodeGenService` 类变为薄编排层：**
```typescript
import { callLLM } from "./llm.js";
import { planAppStructure } from "./plan.js";
import { generateFile } from "./generate.js";
import { reviewApp } from "./review.js";
import { LANG_GUIDES, PLAN_SYSTEM_PROMPT, GENERATE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, MAX_TOKENS_PLAN, MAX_TOKENS_FILE } from "./prompts.js";

export class CodeGenService {
  async *generate(projectId, userId, prompt, options) {
    // ... 编排逻辑，调用 planAppStructure(prompt, framework, resolvedModel, callLLM)
    // ... for 循环调用 generateFile(filePlan, prompt, framework, resolvedModel, callLLM, LANG_GUIDES)
    // ... 调用 reviewApp(plan, projectId, resolvedModel, callLLM, getFiles)
  }

  private async getProjectName(projectId: string): Promise<string | null> {
    // 保留动态 import 以打破循环依赖（Phase 5 会修复）
  }
}

export const codeGenService = new CodeGenService();
```

**需要保留的动态 import：**
```typescript
private async getProjectName(projectId: string): Promise<string | null> {
  const { prisma } = await import("../../db.js");  // 保留，Phase 5 修复
  // ...
}
```

**预计行数：** ~120 行（编排 + getProjectName）

---

### 2.3 Import 图谱（拆分后）

```
routes/app-project.ts
  → services/codegen/index.ts           (import { codeGenService })
    → codegen/llm.ts                     (import { callLLM })
    → codegen/prompts.ts                 (import { LANG_GUIDES, ... })
    → codegen/plan.ts                    (import { planAppStructure, extractFilePlan, detectLang, getDefaultPlan })
      → ../../providers/types.ts
      → ../../lib/json-utils.ts
      → @agentforge/shared-types
      → @agentforge/logger
    → codegen/generate.ts                (import { generateFile, extractFileContent })
      → ../../providers/types.ts
      → @agentforge/logger
    → codegen/review.ts                  (import { reviewApp })
      → ../../providers/types.ts
      → @agentforge/logger
```

无循环依赖。`plan.ts`、`generate.ts`、`review.ts` 都通过参数接收 `callLLM` 函数。

### 2.4 执行步骤

| 步骤 | 操作 | 风险 | 验证 |
|------|------|------|------|
| 2.1 | 创建 `services/codegen/` 目录 | 低 | — |
| 2.2 | 创建 `prompts.ts`，移动常量和 LANG_GUIDES | 低 | typecheck |
| 2.3 | 创建 `llm.ts`，移动 `callLLM()` | 低 | typecheck |
| 2.4 | 创建 `plan.ts`，移动 4 个函数，将 `callLLM` 改为参数 | 中 | typecheck |
| 2.5 | 创建 `generate.ts`，移动 2 个函数，将 `callLLM` + `langGuides` 改为参数 | 中 | typecheck |
| 2.6 | 创建 `review.ts`，移动 `reviewApp()`，将依赖改为参数 | 低 | typecheck |
| 2.7 | 删除原 `codegen.ts`。确认 `routes/app-project.ts` 的 import `"../services/codegen.js"` 自动解析到 `codegen/index.ts` | 中 | typecheck |
| 2.8 | 全量回归 | 低 | `pnpm typecheck && pnpm lint` |

---

## 3. workflows/service.ts（817 行）→ 3 个模块

### 3.1 当前结构分析

**文件：** `apps/server/src/workflows/service.ts`

```
类型:
  PendingApproval          (L22-29)   — 私有接口

类 WorkflowService:
  CRUD:
    create()               (L46-63)
    list()                 (L66-101)
    get()                  (L104-110)
    update()               (L113-142)
    delete()               (L145-153)
    validateDefinition()   (L156-174)
  
  Execution:
    runWorkflow()          (L179-392)  — async generator
    handleApproval()       (L395-452)  — async generator
    pauseRun()             (L455-470)
    resumeRun()            (L473-643)  — async generator
    cancelRun()            (L646-673)
  
  Runs:
    listRuns()             (L678-706)
    getRun()               (L709-727)
    saveStepLog()          (L730-755)
  
  DTO Helpers:
    toDTO()                (L759-774)
    runToDTO()             (L776-798)
    stepLogToDTO()         (L800-817)
```

**外部导入者：** 仅 `routes/workflows.ts`（`import { workflowService } from "../workflows/service.js"`）

### 3.2 拆分方案

#### 新文件 1: `workflows/dto.ts`

**内容：**

| 项目 | 类型 | 原位置 |
|------|------|--------|
| `toDTO()` | 导出函数 | service.ts L759-774 |
| `runToDTO()` | 导出函数 | service.ts L776-798 |
| `stepLogToDTO()` | 导出函数 | service.ts L800-817 |

**类型变更（依赖 Phase 0）：** 参数从 `any` → Prisma 精确类型。

```typescript
import type { Prisma } from "@agentforge/database";
import type { WorkflowDTO, WorkflowRunDTO, WorkflowStepLogDTO, WorkflowDefinition, ProgressSummary } from "@agentforge/shared-types";

export function toDTO(w: Prisma.WorkflowGetPayload<Record<string, never>>): WorkflowDTO {
  // ... 原来的实现，参数类型从 (w: any) 改为精确类型
}

export function runToDTO(r: Prisma.WorkflowRunGetPayload<Record<string, never>>): WorkflowRunDTO {
  // ...
}

export function stepLogToDTO(sl: Prisma.WorkflowStepLogGetPayload<Record<string, never>>): WorkflowStepLogDTO {
  // ...
}
```

**预计行数：** ~70 行

---

#### 新文件 2: `workflows/queries.ts`

**内容：** 从 `service.ts` 提取反复出现的 Prisma 查询模式。

| 函数 | 封装内容 | 使用处 |
|------|---------|--------|
| `findWorkflowById()` | `prisma.workflow.findFirst({ where: { id, userId } })` | get, update, delete, runWorkflow, resumeRun |
| `findRunById()` | `prisma.workflowRun.findFirst({ where: { id: runId, userId } })` | pauseRun, cancelRun, getRun, resumeRun |
| `listWorkflows()` | `findMany + count` with filter/pagination | list |
| `listRunsForWorkflow()` | `findMany + count` with status filter | listRuns |
| `findRunWithLogs()` | `findFirst` on run + `findMany` on stepLogs | getRun |

```typescript
// queries.ts
import { prisma } from "../db.js";
import type { Prisma } from "@agentforge/database";

export async function findWorkflowById(id: string, userId: string) {
  return prisma.workflow.findFirst({ where: { id, userId } });
}

export async function findRunById(runId: string, userId: string) {
  return prisma.workflowRun.findFirst({ where: { id: runId, userId } });
}

export async function listWorkflows(
  userId: string,
  where: Prisma.WorkflowWhereInput,
  page: number,
  limit: number,
) {
  const offset = (page - 1) * limit;
  return Promise.all([
    prisma.workflow.findMany({ where, orderBy: { updatedAt: "desc" }, skip: offset, take: limit }),
    prisma.workflow.count({ where }),
  ]);
}

// ... 其他查询函数
```

**预计行数：** ~80 行

---

#### 修改: `workflows/service.ts`

**移除内容：** `toDTO`, `runToDTO`, `stepLogToDTO`（移至 dto.ts），内联 Prisma 查询替换为 queries.ts 调用。

**保留内容：** `PendingApproval` 接口保留在 `service.ts` 中（它是 WorkflowService 的私有实现细节，仅被 `pendingApprovals` Map 和 `runWorkflow()`/`resumeRun()` 中的 pauseForApproval 闭包使用，移入 dto.ts 语义不匹配）。

**保留内容：** 所有业务逻辑方法、`WorkflowService` 类、`workflowService` 单例。

**新增 import：**
```typescript
import { toDTO, runToDTO, stepLogToDTO } from "./dto.js";
import { findWorkflowById, findRunById, listWorkflows, listRunsForWorkflow, findRunWithLogs } from "./queries.js";
```

**预计行数：** ~520 行（原 817 - DTO ~70 - 重复查询内联 ~80 + queries import 开销）

### 3.3 Import 图谱（拆分后）

```
routes/workflows.ts
  → workflows/service.ts          (import { workflowService })
    → dto.ts                       (import { toDTO, runToDTO, stepLogToDTO })
      → @agentforge/database
      → @agentforge/shared-types
    → queries.ts                   (import { findWorkflowById, ... })
      → ../db.js
      → @agentforge/database
    → dag-executor.ts              (import { DAGExecutor })
    → schema.ts                    (现有)
```

无循环依赖。

### 3.4 执行步骤

| 步骤 | 操作 | 风险 | 验证 |
|------|------|------|------|
| 3.1 | 创建 `dto.ts`，移动 3 个 DTO 方法，修复类型签名 | 中 | typecheck |
| 3.2 | 在 `service.ts` 中 import dto.ts，替换 `this.toDTO(...)` → `toDTO(...)` | 中 | typecheck |
| 3.3 | 创建 `queries.ts`，提取重复查询模式 | 低 | typecheck |
| 3.4 | 在 `service.ts` 中替换内联查询为 queries.ts 调用 | 中 | typecheck |
| 3.5 | 全量回归 | 低 | `pnpm typecheck && pnpm lint` |

---

## 4. agent.ts（2133 行）→ 5 个模块

### 4.1 当前结构分析

**文件：** `apps/server/src/services/agent.ts`

```
顶层常量/函数:
  DEFAULT_MAX_ITERATIONS        (L46)    — 10
  ITERATION_TIMEOUT_MS          (L48)    — 120000
  calculateRetryDelayForAgent() (L51-68) — 纯函数
  AGENT_DECIDE_TOOL             (L72-139)— ToolDefinition 常量
  REACT_PROMPT_WITH_TOOLS       (L142-146)— 拼接常量

AgentService 类:
  compressor                   (L149)  — MemoryCompressor 实例

  Public:
    run()                      (L155-926)   — ~770 行 async generator
    resume()                   (L932-976)   — ~45 行
    handleApproval()           (L982-1222)  — ~240 行
    getSessions()              (L2082-2114) — ~33 行
    getSession()               (L2120-2148) — ~29 行

  Private:
    continueReActLoop()        (L1228-1677) — ~450 行 async generator
    buildIterationContext()    (L1682-1729) — ~48 行
    formatStepForContext()     (L1734-1747) — ~14 行
    parseAgentDecideFromArgs() (L1753-1811) — ~59 行
    parseStep()                (L1816-1857) — ~42 行
    executeToolWithRetry()     (L1864-1995) — ~132 行
    delay()                    (L2000-2002) — ~3 行
    sessionRecord()            (L2007-2018) — ~12 行
    saveSession()              (L2023-2077) — ~55 行
```

**外部导入者（10 个文件）：**

| 文件 | Import |
|------|--------|
| `routes/agent.ts` | `import { AgentService } from "../services/agent.js"` |
| `services/agent-runtime/agent-executor.ts` | `import { AgentService } from "../agent.js"` |
| `teams/modes/orchestrator.ts` | `import { AgentService } from "../../services/agent.js"` |
| `teams/modes/peer.ts` | `import { AgentService } from "../../services/agent.js"` |
| `teams/modes/debate.ts` | `import { AgentService } from "../../services/agent.js"` |
| `workflows/handlers/agent-step.ts` | `import { AgentService } from "../../services/agent.js"` |
| `services/__tests__/agent.test.ts` | `import { AgentService } from "../agent.js"` |
| `services/__tests__/agent-approval.test.ts` | `import { AgentService } from "../agent.js"` |
| `services/__tests__/agent-memory.test.ts` | `import { AgentService } from "../agent.js"` |
| `services/__tests__/agent-error-recovery.test.ts` | `import { AgentService } from "../agent.js"` |

### 4.2 重复逻辑分析与合并策略（前置步骤）

#### 重复代码识别

`run()` 和 `continueReActLoop()` 共享以下逻辑块（约 300 行重复）：

**A. LLM 调用重试循环** — 约 90 行重复（run: L354-509, continue: L1331-1459）

两者相同的部分：
- 相同的 `while (!llmSucceeded && llmAttempt < maxLlmAttempts)` 循环结构
- 相同的 `for await (const chunk of provider.streamChat(...))` 
- 相同的 token 累积 + `agent_token` yield
- 相同的 `agent_decide` 工具调用解析（`parseAgentDecideFromArgs`）
- 相同的 `agent_clear_stream` on retry
- 相同的 fatal error 处理 + session save
- 相同的 retryable error 处理 + delay
- 相同的 degradation 处理

两者不同的部分：
- `run()` 在 LLM 流中处理原生工具调用（非 agent_decide），`continueReActLoop()` 也处理但更简单
- `run()` 使用 `iterationTools`（可能为 undefined），`continueReActLoop()` 始终传 `toolDefs`

**B. 决策-动作处理** — 约 120 行重复（run: L615-905, continue: L1478-1669）

两者相同的部分：
- 相同的 `agentDecision || parseStep(...)` 解析
- 相同的 parse 失败处理
- 相同的 `agent_think` yield
- 相同的 respond 处理（save message, yield, save session）
- 相同的 tool_call 处理（approval gate, tool execution, scratchpad push, compression）
- 相同的 ask_user 处理（scratchpad push, save session paused）

两者不同的部分：
- `run()` 有 respondOnly 模式（L577-613）
- `run()` 有原生 tool call 处理（L512-573）
- `run()` 有 `parsedFromText` 跟踪 + `agent_clear_stream` on raw JSON parse
- `run()` 有 `guard.guardToolCall()` 检查（L816-843），`continueReActLoop()` 没有
- `run()` 每次工具执行后有 `isDegraded` 检查，`continueReActLoop()` 也有但变量名不同

#### 合并策略

**不推荐将整个 ReAct 循环合并为一个方法** — 两个方法的初始化、模式切换（respondOnly）、原生工具调用处理差异太大。反之，提取 3 个层次的可复用单元：

**Level 1: 纯函数提取（零风险）**

以下方法已是纯函数或接近纯函数，不涉及 `this.*` 状态，直接提取：

| 方法 | 依赖 | 可提取性 |
|------|------|---------|
| `calculateRetryDelayForAgent()` | 无 | 已是顶级函数 ✅ |
| `buildIterationContext()` | `this.formatStepForContext()` | 提取后改为参数 ✅ |
| `formatStepForContext()` | 无 | 纯函数 ✅ |
| `parseAgentDecideFromArgs()` | `logger` | 纯函数 ✅ |
| `parseStep()` | `parseJSONFromLLMResponse`, `logger` | 纯函数 ✅ |
| `delay()` | 无 | 纯函数 ✅ |
| `sessionRecord()` | 无 | 纯函数 ✅ |

**Level 2: 带外部依赖的方法提取（低风险）**

| 方法 | 依赖 | 提取方式 |
|------|------|---------|
| `executeToolWithRetry()` | `toolRegistry`, `createChildContext`, `createRunContext`, `randomUUID`, `classifyError`, `buildDegradationMessage`, `getAlternativeTools`, `executionResultToContent`, `calculateRetryDelayForAgent`, `delay` | 改为独立函数，通过参数接收 toolRegistry |
| `saveSession()` | `prisma`, `logger` | 改为独立函数 |
| `getSessions()` | `prisma`, `logger` | 改为独立函数 |
| `getSession()` | `prisma`, `logger` | 改为独立函数 |

**Level 3: LLM 调用循环的部分合并（中等风险）**

不合并整个循环，但提取共享的"错误处理 + 重试"逻辑为独立函数：

```typescript
// llm-executor.ts — 共享的 LLM 错误分类 + 重试判断
export function handleLLMError(
  err: unknown,
  llmAttempt: number,
  maxLlmAttempts: number,
  sessionId: string,
): { action: "fatal" | "retry" | "degrade"; message: string; delayMs?: number } {
  const error = err instanceof Error ? err : new Error(String(err));
  const classified = classifyError(error, "llm");
  // ... 返回统一的结构化结果
}
```

> **设计决策：** 不追求将两个 ReAct 循环完全合并为一个。差异点（respondOnly 模式、原生工具调用、guard 检查）导致合并后的方法需要大量条件分支，反而降低可读性。当前提取 Level 1 + Level 2 已消除 ~500 行重复/可分离代码。

### 4.3 目标模块结构

```
services/agent/
├── index.ts              (~350 行) — AgentService 类 + run/resume/handleApproval/continueReActLoop
├── prompts.ts            (~120 行) — 系统 prompt + 上下文构建 + 步骤格式化
├── decision-parser.ts    (~100 行) — parseStep + parseAgentDecideFromArgs
├── tool-executor.ts      (~180 行) — executeToolWithRetry + 辅助函数
├── session-persistence.ts (~130 行) — saveSession + sessionRecord + getSessions + getSession
└── __tests__/            (现有测试文件移动至此)
```

> **说明：** 原计划中的 `llm-executor.ts`、`scratchpad.ts`、`guard-integration.ts` 在深入分析后决定暂不独立提取。
> - **llm-executor.ts**: LLM 调用循环与 ReAct 决策逻辑深度交织（token streaming、tool call interception、yield 事件）。提取需要引入复杂回调或策略模式，收益不足以抵消风险。
> - **scratchpad.ts**: 压缩逻辑已封装在 `MemoryCompressor` 类中。agent.ts 中仅余 ~30 行集成代码（条件判断 + compressor 调用），独立文件过薄。
> - **guard-integration.ts**: Guard 逻辑已封装在 `AgentGuardService` 中。agent.ts 中仅余 ~20 行集成代码，独立文件过薄。

### 4.4 各模块详细规格

---

#### 新文件 1: `services/agent/prompts.ts`

**内容：**

| 项目 | 原位置 | 类型 |
|------|--------|------|
| `DEFAULT_MAX_ITERATIONS` | agent.ts L46 | `const` |
| `ITERATION_TIMEOUT_MS` | agent.ts L48 | `const` |
| `AGENT_DECIDE_TOOL` | agent.ts L72-139 | `const ToolDefinition` |
| `REACT_PROMPT_WITH_TOOLS` | agent.ts L142-146 | `const string` |
| `respondOnlySystemPrompt()` | 提取自 `run()` L317-320 | 纯函数 |
| `buildIterationContext()` | agent.ts L1682-1729 | 纯函数 |
| `formatStepForContext()` | agent.ts L1734-1747 | 纯函数 |

**函数签名：**
```typescript
// 原为 private method，提取为纯函数
export function buildIterationContext(
  systemPrompt: string,
  task: string,
  scratchpad: AgentStep[],
  currentStep: number,
  compressedSummary?: string,
  keptStepNumbers?: Set<number>,
  respondOnly?: boolean,
): string;

export function formatStepForContext(step: AgentStep): string;

// 新提取：respond-only 模式的 system prompt
export function getRespondOnlySystemPrompt(): string;
```

**Import 需求：**
```typescript
import type { AgentStep, ToolDefinition } from "@agentforge/shared-types";
import { react_system_prompt } from "@agentforge/shared-prompts";
```

**预计行数：** ~120 行

---

#### 新文件 2: `services/agent/decision-parser.ts`

**内容：**

| 项目 | 原位置 | 类型 |
|------|--------|------|
| `parseAgentDecideFromArgs()` | agent.ts L1753-1811 | 纯函数 |
| `parseStep()` | agent.ts L1816-1857 | 纯函数 |

**函数签名：**
```typescript
export function parseAgentDecideFromArgs(
  rawArgs: string,
  totalSteps: number,
): AgentStep | null;

export function parseStep(
  response: string,
  stepNumber: number,
): AgentStep | null;
```

**Import 需求：**
```typescript
import { parseJSONFromLLMResponse } from "../../lib/json-utils.js";
import { logger } from "@agentforge/logger";
import type { AgentStep, AgentDecision } from "@agentforge/shared-types";
```

**预计行数：** ~100 行

---

#### 新文件 3: `services/agent/tool-executor.ts`

**内容：**

| 项目 | 原位置 | 类型 |
|------|--------|------|
| `calculateRetryDelayForAgent()` | agent.ts L51-68 | 顶层纯函数 |
| `executeToolWithRetry()` | agent.ts L1864-1995 | private method → 导出函数 |
| `delay()` | agent.ts L2000-2002 | private method → 导出函数 |

**关键变更：** `executeToolWithRetry()` 原是 private method，访问 `this.delay()`。提取后改为独立函数：

```typescript
export async function executeToolWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  conversationMessages: ChatMessage[],
  sessionId: string | undefined,
  stepNumber: number | undefined,
  parentContext: RunContext | undefined,
): Promise<ExecutionResult>
```

> **注意：** 原方法还访问了 `toolRegistry`（通过顶层 import `toolRegistry`）。提取后仍通过模块级 import 访问，不需要参数传入。但 `createChildContext`、`createRunContext` 已有独立 import。

**Import 需求：**
```typescript
import { randomUUID } from "crypto";
import { toolRegistry } from "../../tools/registry.js";
import { logger } from "@agentforge/logger";
import { createChildContext, createRunContext, type RunContext } from "../../runtime/context.js";
import { classifyError } from "../error-classifier.js";
import { executeWithRetry, DEFAULT_LLM_RETRY, DEFAULT_TOOL_RETRY } from "../retry-executor.js";
import { buildDegradationMessage, getAlternativeTools } from "../degradation-chain.js";
import { isDegradedResult, executionResultToContent, ExecutionErrorCode, type ExecutionResult } from "../../runtime/results.js";
import type { ChatMessage } from "../../providers/types.js";
```

> **注意：** `executeWithRetry` 这个 import 来自 `retry-executor.js`，与 `executeToolWithRetry` 内部逻辑不同。`executeToolWithRetry` 虽然名字相似，但它有自己的重试循环 —— 它不直接使用 `executeWithRetry`（来自 retry-executor.js），而是用 `DEFAULT_TOOL_RETRY` 的配置值。

**预计行数：** ~180 行

---

#### 新文件 4: `services/agent/session-persistence.ts`

**内容：**

| 项目 | 原位置 | 类型 |
|------|--------|------|
| `sessionRecord()` | agent.ts L2007-2018 | private → 导出函数 |
| `saveSession()` | agent.ts L2023-2077 | private → 导出函数 |
| `getSessions()` | agent.ts L2082-2114 | public → 导出函数 |
| `getSession()` | agent.ts L2120-2148 | public → 导出函数 |

**关键变更：** `saveSession()` 原访问 `prisma`，提取后通过 import 访问。

```typescript
// saveSession 提取后签名不变，但参数中的 sessionRecord 对象类型需要导出
export interface SessionRecord {
  id: string;
  conversationId: string;
  task: string;
  status: string;
  scratchpad: AgentStep[];
  finalSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export function createSessionRecord(id: string, conversationId: string, task: string): SessionRecord;

export async function saveSession(
  record: SessionRecord,
  scratchpad: AgentStep[],
  status: "running" | "paused" | "completed" | "failed",
  finalSummary: string | null,
  compressedSummary?: string,
): Promise<void>;

export async function getSessions(conversationId: string): Promise<SessionRecord[]>;

export async function getSession(id: string): Promise<SessionRecord | null>;
```

**Import 需求：**
```typescript
import { prisma } from "../../db.js";
import { logger } from "@agentforge/logger";
import type { AgentStep } from "@agentforge/shared-types";
```

**预计行数：** ~130 行

---

#### 修改: `services/agent/index.ts`

**内容：** `AgentService` 类，组合各模块。保留 `run()`、`resume()`、`handleApproval()`、`continueReActLoop()` 四个 async generator。

**新增 import：**
```typescript
// 从子模块导入
import {
  AGENT_DECIDE_TOOL,
  REACT_PROMPT_WITH_TOOLS,
  DEFAULT_MAX_ITERATIONS,
  buildIterationContext,
  getRespondOnlySystemPrompt,
} from "./prompts.js";
import { parseAgentDecideFromArgs, parseStep } from "./decision-parser.js";
import { executeToolWithRetry, calculateRetryDelayForAgent, delay } from "./tool-executor.js";
import {
  createSessionRecord,
  saveSession,
  getSessions as getSessionsFn,
  getSession as getSessionFn,
} from "./session-persistence.js";
```

**方法变更清单：**

| 原方法 | 变更 |
|--------|------|
| `run()` | 内联的 `sessionRecord` → `createSessionRecord(...)`；`this.delay(ms)` → `delay(ms)`；`this.executeToolWithRetry(...)` → `executeToolWithRetry(...)`；`this.parseAgentDecideFromArgs(...)` → `parseAgentDecideFromArgs(...)`；`this.parseStep(...)` → `parseStep(...)`；`this.buildIterationContext(...)` → `buildIterationContext(...)`；`this.saveSession(...)` → `saveSession(...)`；respondOnly prompt 内联 → `getRespondOnlySystemPrompt()` |
| `resume()` | `this.getSession(id)` → `getSessionFn(id)`；`this.continueReActLoop(...)` 不变（保留为 private method） |
| `handleApproval()` | `this.getSession(id)` / `this.saveSession(...)` → 函数调用；`this.sessionRecord(...)` → `createSessionRecord(...)` |
| `continueReActLoop()` | 同上模式替换 |
| `getSessions()` | 改为 thin wrapper: `return getSessionsFn(conversationId)` |
| `getSession()` | 改为 thin wrapper: `return getSessionFn(id)` |
| `buildIterationContext()` | 删除（移至 prompts.ts） |
| `formatStepForContext()` | 删除（移至 prompts.ts） |
| `parseAgentDecideFromArgs()` | 删除（移至 decision-parser.ts） |
| `parseStep()` | 删除（移至 decision-parser.ts） |
| `executeToolWithRetry()` | 删除（移至 tool-executor.ts） |
| `delay()` | 删除（移至 tool-executor.ts） |
| `sessionRecord()` | 删除（移至 session-persistence.ts） |
| `saveSession()` | 删除（移至 session-persistence.ts） |

**`compressor` 属性保留：** 仍在 `index.ts` 的 AgentService 类中初始化，因为压缩逻辑与 ReAct 循环的状态（`compressedSummary`、`keptStepNumbers`）紧密耦合且代码量小（~10 行）。

**预计行数：** ~400 行（run + resume + handleApproval + continueReActLoop 保留）

### 4.5 Backward Compatibility: Barrel Re-export

**原 `services/agent.ts` 改为 barrel 文件：**

```typescript
// services/agent.ts — barrel re-export for backward compatibility
export { AgentService } from "./agent/index.js";
```

> 所有 10 个外部导入者无需任何更改，import 路径 `"../services/agent.js"` 继续有效。

### 4.6 Import 图谱（拆分后）

```
routes/agent.ts
services/agent-runtime/agent-executor.ts
teams/modes/orchestrator.ts
teams/modes/peer.ts
teams/modes/debate.ts
workflows/handlers/agent-step.ts
services/__tests__/agent*.test.ts
  → services/agent.js                    (barrel re-export)
    → services/agent/index.ts            (AgentService 类)
      → ./prompts.js                     (常量 + 上下文构建)
      → ./decision-parser.js             (决策解析)
        → ../../lib/json-utils.js
        → @agentforge/logger
        → @agentforge/shared-types
      → ./tool-executor.js              (工具执行)
        → ../../tools/registry.js
        → ../../runtime/context.js
        → ../error-classifier.js
        → ../degradation-chain.js
        → ../../runtime/results.js
      → ./session-persistence.js         (DB 持久化)
        → ../../db.js
        → @agentforge/logger
      → ../memory-compressor.js          (现有)
      → ../agent-guard.js               (现有)
      → ../../providers/registry.js     (现有)
      → ../../lib/context-window.js      (现有)
      → ../retry-executor.js             (现有)
      → ../error-classifier.js           (现有)
      → ../../runtime/scope.js           (现有)
      → @agentforge/shared-types
      → @agentforge/shared-prompts
      → @agentforge/logger
```

无循环依赖。所有子模块只依赖外部服务/库，不依赖彼此或 `index.ts`。

### 4.7 执行步骤（按风险递增）

这是整个 Phase 3 最关键的操作序列。每一步完成后必须 typecheck + 运行 agent 相关测试。

#### 阶段 A: 准备（无破坏性变更）

| 步骤 | 操作 | 风险 | 验证 | 预计时间 |
|------|------|------|------|---------|
| A.1 | 创建 `services/agent/` 目录 | 无 | — | 1 min |
| A.2 | 创建 `services/agent/prompts.ts`，移动 `DEFAULT_MAX_ITERATIONS`、`ITERATION_TIMEOUT_MS`、`AGENT_DECIDE_TOOL`、`REACT_PROMPT_WITH_TOOLS`、`buildIterationContext()`、`formatStepForContext()`，提取 `getRespondOnlySystemPrompt()` | 低 | 确认 prompts.ts 编译通过 | 45 min |
| A.3 | 创建 `services/agent/decision-parser.ts`，移动 `parseAgentDecideFromArgs()`、`parseStep()` | 低 | 确认 decision-parser.ts 编译通过 | 30 min |
| A.4 | 创建 `services/agent/tool-executor.ts`，移动 `calculateRetryDelayForAgent()`、`executeToolWithRetry()`、`delay()` | 中 | 确认 tool-executor.ts 编译通过。注意 `executeToolWithRetry` 依赖多个外部模块 | 45 min |
| A.5 | 创建 `services/agent/session-persistence.ts`，移动 `sessionRecord()` → `createSessionRecord()`、`saveSession()`、`getSessions()`、`getSession()`，导出 `SessionRecord` 接口 | 中 | 确认 session-persistence.ts 编译通过 | 45 min |

#### 阶段 B: 集成连接

| 步骤 | 操作 | 风险 | 验证 | 预计时间 |
|------|------|------|------|---------|
| B.1 | 创建 `services/agent/index.ts`，复制 `AgentService` 类框架（保留所有 async generator），添加子模块 import | 中 | typecheck | 30 min |
| B.2 | 在 `index.ts` 中将 `this.methodName()` 调用替换为对应的导入函数调用（见"方法变更清单"） | 高 | typecheck。确认所有 `this.xxx` 引用已替换 | 60 min |
| B.3 | 删除 `agent.ts` 中已移动的方法/常量 | 中 | typecheck 确认无 "duplicate identifier" | 15 min |

#### 阶段 C: Barrel + 测试

| 步骤 | 操作 | 风险 | 验证 | 预计时间 |
|------|------|------|------|---------|
| C.1 | 将原 `services/agent.ts` 改为 barrel re-export: `export { AgentService } from "./agent/index.js"` | 低 | typecheck 确认外部导入者编译通过 | 5 min |
| C.2 | 运行 agent 测试套件: `pnpm --filter @agentforge/server vitest run src/services/__tests__/agent*.test.ts` | 高 | 全部通过 | 30 min |
| C.3 | 全量 typecheck: `pnpm typecheck` | 中 | 零错误 | 10 min |
| C.4 | 全量 lint: `pnpm lint` | 低 | 零错误（或仅有预先存在的 warning） | 5 min |

### 4.8 关键风险点

**风险 1: `executeToolWithRetry()` 中的隐式依赖**

`executeToolWithRetry()` 使用了 `DEFAULT_TOOL_RETRY`（来自 `retry-executor.js`）和 `calculateRetryDelayForAgent`（原为同文件顶级函数，拆分后在 `tool-executor.ts` 中）。移入 `tool-executor.ts` 后，它们在同一文件中，无需额外处理。但需要确认从 `retry-executor.js` import 的 `executeWithRetry` 函数不会与我们的 `executeToolWithRetry` 函数产生命名混淆。

**缓解：** 使用明确的 import 别名。
```typescript
import { executeWithRetry as retryExecutor } from "../retry-executor.js";
// 但我们实际上不使用 executeWithRetry 函数本身，只用 DEFAULT_TOOL_RETRY 常量
```

**风险 2: `continueReActLoop()` 中的 `this.saveSession()` 调用**

`continueReActLoop()` 调用了 `this.saveSession(sessionRecord, scratchpad, status, ...)` 和 `this.sessionRecord(id, conversationId, task)`。拆分后这些调用必须改为独立函数。由于 `saveSession` 会修改传入的 `record` 对象的属性（L2066-2069: `record.status = status` 等），改为独立函数后行为不变（对象引用传递）。

**缓解：** 确保 `saveSession()` 函数签名不变，且接收可变 `SessionRecord` 对象。

**风险 3: Mock 路径变更影响测试**

4 个 agent 测试文件使用 `vi.mock("../../db.js")` 等相对路径。拆分后子模块的路径比原文件深一层（`services/agent/xxx.ts` vs `services/agent.ts`），`import { prisma } from "../../db.js"` 的路径正确性需要验证。

**缓解：** 在 `services/agent/` 目录下的子模块中，所有相对路径 import 需要比原文件多一个 `../`。在步骤 B.1 创建 `index.ts` 时需仔细核对所有 import 路径。

---

## 5. 整体执行顺序

按风险从低到高，每天一个文件：

```
Day 1 (2-3h):
  ├── 1. dag-executor.ts → 3 modules   [1.5h]
  └── 2. codegen.ts → 5 modules        [2h, 可与 1 并行]

Day 2 (2-3h):
  └── 3. workflows/service.ts → 3 modules  [2h]

Day 3-4 (8-10h):
  ├── 4A. agent.ts 阶段 A: 创建子模块   [3h]
  ├── 4B. agent.ts 阶段 B: 集成连接     [2h]
  └── 4C. agent.ts 阶段 C: Barrel+测试  [1h]

Day 5 (30 min):
  └── 全量回归: pnpm typecheck && pnpm lint && pnpm --filter @agentforge/server test
```

---

## 6. 验证 Checklist

每完成一个文件拆分后执行：

```bash
# 最小验证（每一步后）
pnpm typecheck

# 完整验证（每个文件拆分完成后）
pnpm typecheck && pnpm lint

# agent.ts 拆分完成后额外执行
pnpm --filter @agentforge/server vitest run src/services/__tests__/agent.test.ts
pnpm --filter @agentforge/server vitest run src/services/__tests__/agent-approval.test.ts
pnpm --filter @agentforge/server vitest run src/services/__tests__/agent-memory.test.ts
pnpm --filter @agentforge/server vitest run src/services/__tests__/agent-error-recovery.test.ts

# 全量回归（全部完成后）
pnpm typecheck && pnpm lint && pnpm --filter @agentforge/server test
```

---

## 7. 回滚策略

每个文件拆分通过 Git 分支隔离。如果某一步出现问题：

```bash
git checkout -- apps/server/src/services/agent.ts  # 恢复原文件
rm -rf apps/server/src/services/agent/              # 删除新目录
```

建议为每个文件拆分创建独立分支：
- `phase3/dag-executor-split`
- `phase3/codegen-split`
- `phase3/workflow-service-split`
- `phase3/agent-split`

---

## 8. 修订记录

| 日期 | 修订人 | 内容 |
|------|--------|------|
| 2026-06-16 | Architect | 初稿 |
| 2026-06-16 | Architecture Reviewer | 审查反馈：CHANGES_REQUIRED（3 严重/重要，4 建议） |
| 2026-06-16 | Architect | 修订 v1.1： |
| | | - [严重] dag-executor.ts 步骤 1.2 添加 `export type { CheckpointData } from "./checkpoint.js"` 防止 typecheck 失败 |
| | | - [重要] 概览表 agent.ts 目标模块数 7→5，标题同步更新 |
| | | - [重要] codegen 文件命名策略：明确 codegen.ts 删除，由 codegen/index.ts 替代；统一 barrel 策略 |
| | | - [重要] PendingApproval 明确保留在 service.ts 而非移入 dto.ts |
| | | - [建议] 添加 `CodeGenLLMCaller` 类型别名消除 DRY 违规 |
| | | - [建议] dag-executor 消除 `executeWithRetry` thin wrapper，仅保留公开 API `executeSingleStep` thin wrapper |
| | | - [建议] 外部导入者计数 9→10 |
