# RFC-001: AgentForge Execution Runtime Model V1

> **Status**: Accepted
> **Date**: 2026-06-15
> **Scope**: 定义 AgentForge 统一运行时执行模型的核心抽象。智能客服消息中断是第一个消费者。

---

## 核心抽象

```
apps/server/src/runtime/
├── context.ts      # RunContext（不可变 + ancestry 运行树）
├── controller.ts   # ExecutionController + RunState + RunTermination
├── buffer.ts       # OutputBuffer
├── scope.ts        # ExecutionScope（聚合入口）
└── index.ts
```

### 1. RunContext — 不可变运行时上下文

```typescript
export interface RunContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  /** 运行树路径：["root", "agent-1", "tool-search"] */
  readonly ancestry: string[];
}

export function createRunContext(signal: AbortSignal): RunContext;
export function createChildContext(parent: RunContext, childRunId?: string): RunContext;
```

**设计要点**：
- 全部字段 `readonly` + `Object.freeze()`，Tool 无法污染上游
- `createChildContext()` 由调用者（Agent/Service）决定何时创建，不由 ToolRegistry 内部自动生成
- `ancestry` 替代 `parentRunId`：数组直接表达完整运行树，无需额外构建

### 2. RunState — 运行时状态机

```
Pending → Running
Running → Interrupting  (signal.abort())
Running → Completed     (正常结束)
Running → Failed        (异常)
Interrupting → Interrupted  (LLM/Tool 均已终止)
```

`Interrupting` 是过渡态——用户点了停止但 LLM/Tool 可能还在收尾。UI 展示 "Stopping..."。

### 3. RunTermination — 终端原因

```typescript
export enum RunTermination {
  Completed = "completed",
  Interrupted = "interrupted",
  Failed = "failed",
}
```

`RunResult` 不携带 `output`，内容从 `OutputBuffer.getContent()` 获取。

### 4. OutputBuffer — 纯输出缓冲

```typescript
export class OutputBuffer {
  append(token: string): void;
  getContent(): string;
  clear(): void;
  get isEmpty(): boolean;
}
```

无持久化、无生命周期。可被 Chat / Voice / Workflow 复用。

> **V2 预留**：`OutputBuffer<T = string>` 泛型支持结构化输出（`WorkflowStep[]`、Agent Trace 等）。

### 5. ExecutionController — 纯生命周期

```typescript
export class ExecutionController {
  readonly context: RunContext;
  readonly buffer: OutputBuffer;

  get state(): RunState;
  get shouldStop(): boolean;
  onStateChange(fn: (s: RunState) => void): () => void;

  complete(): { termination: RunTermination.Completed; content: string };
  interrupt(): { termination: RunTermination.Interrupted; content: string };
  fail(error: string): { termination: RunTermination.Failed; content: string; error: string };
}
```

**关键决策**：`complete/interrupt/fail` 不调用任何持久化。只返回 `{ termination, content }`。持久化由上层 Service 决定——ChatService 写 `messages`，WorkflowService 写 `workflow_runs`，VoiceService 写 `transcripts`。

> **V2 预留**：`StopReason { type: "user" | "timeout" | "system" | "parent" }` 区分中断来源。

### 6. ExecutionScope — 聚合入口

```typescript
export interface ExecutionScope {
  context: RunContext;
  controller: ExecutionController;
  buffer: OutputBuffer;
}

export function createExecutionScope(options: {
  signal: AbortSignal;
  parentContext?: RunContext;
}): ExecutionScope;
```

未来 Tracing / Metrics / Logger 直接往 Scope 加字段，不用到处传多个独立参数。

---

## Tool 超时与中断统一

```typescript
// AbortSignal.any() — Node 20+ 原生支持
const timeoutSignal = AbortSignal.timeout(timeoutMs);
const combinedSignal = AbortSignal.any([context.signal, timeoutSignal]);
// Tool 只检查 signal.aborted
```

超时、用户取消、系统取消全部统一为 `signal.aborted`。

---

## 分层职责

```
Route 层：提取 c.req.raw.signal → createExecutionScope()
Service 层：使用 scope，决定持久化策略
Agent 层：使用 scope.controller.buffer.append() + scope.controller.shouldStop
Tool 层：接受 RunContext，检查 signal.aborted
Provider 层：接受 signal，传入 OpenAI SDK
```

**Runtime 不关心持久化。Service 决定存储目标。**

---

## V2 预留

| 项目 | 说明 |
|------|------|
| `OutputBuffer<T>` | 泛型支持结构化输出 |
| `StopReason` | 区分 user/timeout/system/parent 中断来源 |
| `scope.logger` | 注入 Runtime Logger |
| `scope.metrics` | 注入 Runtime Metrics |
| `scope.trace` | OpenTelemetry 集成 |
| `RunContext.ancestry` 可视化 | 运行树 UI 展示 |
| Replay / Debug | 基于 ancestry + buffer 回放 |

---

## 相关文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/server/src/runtime/context.ts` | 新建 | RunContext + 工厂函数 |
| `apps/server/src/runtime/buffer.ts` | 新建 | OutputBuffer |
| `apps/server/src/runtime/controller.ts` | 新建 | RunState + RunTermination + ExecutionController |
| `apps/server/src/runtime/scope.ts` | 新建 | ExecutionScope + createExecutionScope |
| `apps/server/src/runtime/index.ts` | 新建 | re-export |
| `apps/server/src/tools/types.ts` | 修改 | ToolExecutor = (args, context: RunContext) |
| `apps/server/src/tools/registry.ts` | 修改 | execute(name, args, context) |
| `apps/server/src/tools/builtins.ts` | 修改 | 10 个工具接受 RunContext |
| `apps/server/src/providers/types.ts` | 修改 | streamChat + signal |
| `apps/server/src/providers/openai.ts` | 修改 | SDK signal |
| `apps/server/src/providers/deepseek.ts` | 修改 | SDK signal |
| `apps/server/src/services/agent.ts` | 修改 | run(options + scope) |
| `apps/server/src/services/chat.ts` | 修改 | streamChat + scope |
| `apps/server/src/services/customer-chat.ts` | 修改 | streamChat + scope |
| `apps/server/src/services/customer-chat/tool-agent.ts` | 修改 | execute(ctx, scope) |
| `apps/server/src/services/customer-chat/types.ts` | 修改 | Agent.execute 签名 |
| `apps/server/src/routes/chat.ts` | 修改 | createExecutionScope |
| `apps/server/src/routes/customer-chat.ts` | 修改 | createExecutionScope |
| `packages/sdk/src/client.ts` | 修改 | streamChat + signal |
| `apps/web/src/stores/chat.ts` | 修改 | finalizeStreamingMessage |
| `apps/web/src/hooks/useStreamChat.ts` | 修改 | AbortController |
| `apps/web/src/hooks/useCustomerChatStream.ts` | 修改 | abort + finalize |
| `apps/web/src/components/chat/ChatInput.tsx` | 修改 | Stop 按钮 |
| `apps/web/src/components/customer-chat/CustomerChatPage.tsx` | 修改 | Stop 按钮 |
| `apps/web/src/components/customer-chat/CustomerChat.tsx` | 修改 | Stop 按钮 |

---

## 实施顺序

```
Phase 1: Runtime 基础 (context → buffer → controller → scope)
Phase 2: Tool Interface (types → registry → 10 builtins)
Phase 3: Provider (types → openai → deepseek)
Phase 4: Agent (AgentService.run)
Phase 5: Service (ChatService → CustomerChatService → ToolAgent → types)
Phase 6: Route (chat → customer-chat)
Phase 7: SDK + Frontend
```
