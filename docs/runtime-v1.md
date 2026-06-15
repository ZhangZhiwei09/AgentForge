# AgentForge Execution Runtime V1

> AgentForge Runtime 的核心抽象不是 Agent、Tool 或 Workflow，而是 Execution。Execution 以树结构组织，ExecutionNode 是运行时对象模型，ExecutionResult 是统一结果协议，RuntimeEvent 是状态变化的投影。所有上层能力（Agent、Workflow、Voice、Trace、Interrupt、Metrics）都是对 Execution Tree 的生产、消费或观察。

---

## 1. 为什么是 Runtime

### 1.1 问题起源：客服消息中断

AgentForge 最初的架构中，每个服务独立管理自己的执行流：

```
ChatService ──SSE──> Frontend
AgentService ──SSE──> Frontend
WorkflowEngine ──SSE──> Frontend
VoiceService ──WS──> Frontend
```

当需要"客服消息中断"时，出现了一个根本问题：**Voice 怎么知道 Chat 在执行什么？中断信号应该发给谁？**

这个看似简单的需求暴露了一个结构性问题：**没有统一的执行模型**。

### 1.2 更深层的问题

"中断"只是冰山一角。同样的问题存在于：

| 横切关注点 | 当前状态 | 缺失的是什么 |
|-----------|---------|------------|
| 取消传播 | 各服务各自处理 AbortSignal | 取消一个 Workflow 时，其子 Agent、子 Tool 自动取消 |
| 超时管理 | 硬编码常量分散各处 | 统一的超时预算与继承 |
| 重试策略 | `retry-executor.ts` 只覆盖 Tool | Agent、Workflow、Voice 都没有统一重试 |
| 执行追踪 | `RunContext.ancestry` 已记录树结构 | 但没有节点的状态、时序、结果 |
| 调试可见性 | AgentPanel 能看到 ReAct 步骤 | 看不到 Workflow 内部、看不到 SubAgent 嵌套、看不到完整时间线 |

### 1.3 设计目标

Runtime V1 不增加新功能，而是**提取已有功能中的共性，形成统一抽象**。目标：

1. **让上层服务删除代码，而不是增加代码**
2. **让取消、超时、追踪这些横切关注点只需实现一次**
3. **为未来的 Workflow、SubAgent、Multi-Agent 提供统一的执行容器**

---

## 2. 四个核心抽象

### 2.1 ExecutionNode（Root Primitive）

**ExecutionNode 是 Runtime 的第一公民。**

它建模"一个正在执行的东西"，负责：

- 生命周期管理（创建 → 运行 → 终止）
- 父子关系（树结构）
- 取消传播（父取消 → 子自动取消）
- 状态机（严格的状态转移）

```typescript
enum ExecutionState {
  CREATED,
  RUNNING,
  COMPLETED,
  FAILED,
  CANCELLED,
  TIMEOUT,
}

type ExecutionType = 'chat' | 'agent' | 'tool' | 'workflow' | 'voice' | 'subagent';

class ExecutionNode {
  readonly id: string;
  readonly type: ExecutionType;
  readonly parent: ExecutionNode | null;
  readonly context: RunContext;   // 不可变身份（见 2.2）
  readonly children: ExecutionNode[];

  // 生命周期
  start(): void;
  complete(result: ExecutionResult): void;
  fail(error: ExecutionError): void;
  cancel(reason: string): void;    // 级联取消所有子节点
  timeout(afterMs: number): void;

  // 查询
  get state(): ExecutionState;
  get duration(): number;
  get isTerminal(): boolean;

  // 创建子节点
  createChild(type: ExecutionType): ExecutionNode;
}
```

**ExecutionNode 是聚合根，而非所有能力的最终承载者。**

随着 Runtime 演进，`ExecutionNode` 内部职责会逐步分解为独立管理器——`LifecycleManager`（状态机）、`ChildManager`（树操作）、`EventEmitter`（事件流）。V1 不立即做这个分解，但 `ExecutionNode` 的公开 API 已经按这些职责分区设计，防止未来长成 God Object。当任一管理器的逻辑超过 ~50 行时，就是拆分的时机。

**为什么 RunContext 不合并进 ExecutionNode？**

`RunContext` 是不可变值对象（身份），`ExecutionNode` 是有状态的对象（生命周期）。合并会导致：

- `RunContext` 被传递时，接收方可能意外调用 `context.cancel()` 杀死整个执行树
- 序列化/传递时携带了不该暴露的控制能力
- 违反单一职责

正确的设计是：

```typescript
class ExecutionNode {
  readonly context: RunContext;  // ExecutionNode 持有 Context，反之不成立
}
```

### 2.2 RunContext（不可变身份）

**RunContext 是 Execution 的"身份证"** — 只读、可传递、可序列化。

```typescript
interface RunContext {
  readonly runId: string;
  readonly ancestry: string[];          // 从根到当前节点的完整路径
  readonly signal: AbortSignal;         // 取消信号
  readonly metadata: Record<string, unknown>;  // tenantId, userId, sessionId 等
}
```

`RunContext` 的职责边界：
- ✅ 身份标识（runId, ancestry）
- ✅ 取消信号传递（signal）
- ✅ 关联元数据（metadata）
- ❌ 生命周期控制（那是 ExecutionNode 的事）
- ❌ 业务逻辑（那是上层 Service 的事）

### 2.3 ExecutionResult（统一结果协议）

**所有执行单元返回同一种结果类型。** 不是 ToolResult，不是 AgentResult——就是 ExecutionResult。

```typescript
type ExecutionResult =
  | { status: 'success';    output: unknown }
  | { status: 'partial';    output: unknown; reason: string }
  | { status: 'failed';     error: ExecutionError }
  | { status: 'cancelled';  reason: string }
  | { status: 'timeout';    afterMs: number };

interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  retryable: boolean;
}

enum ExecutionErrorCode {
  NOT_FOUND,
  ACCESS_DENIED,
  INVALID_PARAM,
  EXECUTION_ERROR,
  TIMEOUT,
  CIRCUIT_OPEN,
  RATE_LIMIT,
  NETWORK_ERROR,
  API_ERROR,
  CONFLICT,
  CANCELLED,
}
```

**为什么五态而不是三态？**

HelloAgents 的三态（SUCCESS / PARTIAL / ERROR）已经比 AgentForge 当前的 `Promise<string>` 强很多。但 Runtime 还需要区分三种终端方式：

- `failed`：执行了但出错了（工具调用失败、API 返回错误）→ 可以重试或降级
- `cancelled`：被外部取消（用户点了停止、父节点被取消）→ 不应该重试，调用者应该清理并退出
- `timeout`：超过了时间预算 → 可以增加预算重试或降级

这三者对调用者的语义完全不同，必须区分。

**Tool、Agent、Workflow、Human Approval、MCP 全部返回 ExecutionResult。** 这统一了 degradation-chain、circuit-breaker、retry-executor 的输入类型——它们从字符串解析器变成对结构化数据的纯函数。

### 2.4 事件体系：两类事件

**事件不是独立存在的实体，而是状态的投影或业务行为的记录。**

#### LifecycleEvent（生命周期事件）

由 ExecutionNode 状态转移**自动产生**。业务代码从不直接 emit。

```
ExecutionNode.start()
  → 状态转移 CREATED → RUNNING
  → 自动产生 LifecycleEvent { type: 'node.started', nodeId, timestamp }

ExecutionNode.complete(result)
  → 状态转移 RUNNING → COMPLETED
  → 自动产生 LifecycleEvent { type: 'node.completed', nodeId, result, duration }

ExecutionNode.cancel(reason)
  → 级联取消所有子节点
  → 每个子节点自动产生 LifecycleEvent { type: 'node.cancelled', nodeId, reason }
```

```typescript
type LifecycleEvent =
  | { type: 'node.started';     nodeId: string; ancestry: string[]; timestamp: number }
  | { type: 'node.completed';   nodeId: string; ancestry: string[]; result: ExecutionResult; duration: number }
  | { type: 'node.failed';      nodeId: string; ancestry: string[]; error: ExecutionError; duration: number }
  | { type: 'node.cancelled';   nodeId: string; ancestry: string[]; reason: string }
  | { type: 'node.timeout';     nodeId: string; ancestry: string[]; afterMs: number };
```

**关键约束：状态 → 事件，而非事件 → 状态。** 这保证了不会出现"发了 completed 但实际没 complete"的双写问题。LifecycleEvent 永远是 ExecutionNode 状态机的诚实投影。

#### DomainEvent（业务事件）

由上层 Service 在 ExecutionNode 的生命周期内**主动发出**。这些事件不是状态转移，而是业务行为的记录。AgentPanel、Trace、Metrics 需要的信息远不止生命周期——它们还需要知道 LLM 请求了什么、Tool 调用了什么参数、输出了什么 token。

```typescript
type DomainEvent =
  | { type: 'tool.invoked';      nodeId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool.result';       nodeId: string; toolName: string; result: ExecutionResult; durationMs: number }
  | { type: 'llm.request';       nodeId: string; provider: string; model: string; messages: unknown[] }
  | { type: 'llm.response';      nodeId: string; content: string; usage: TokenUsage; latencyMs: number }
  | { type: 'llm.chunk';         nodeId: string; delta: string }
  | { type: 'output.chunk';      nodeId: string; content: string }
  | { type: 'agent.think';       nodeId: string; step: number; observation: string; analysis: string; plan: string }
  | { type: 'agent.decide';      nodeId: string; step: number; decision: string }
  | { type: 'agent.approval';    nodeId: string; toolName: string; status: 'requested' | 'approved' | 'rejected' };
```

两类事件共享同一个 `ExecutionNode.events` 流，但产生方式不同：

| | LifecycleEvent | DomainEvent |
|---|---|---|
| 产生者 | ExecutionNode 状态机（自动） | 上层 Service（手动） |
| 触发条件 | 状态转移 | 业务行为 |
| 保证 | 永远与状态一致 | 依赖 Service 正确调用 |
| 消费者 | Trace、Metrics、取消传播 | AgentPanel、DebugPanel、HTML Trace |

```typescript
interface ExecutionNode {
  /** 统一事件流：包含 LifecycleEvent 和 DomainEvent */
  readonly events: AsyncIterable<LifecycleEvent | DomainEvent>;

  /** Service 发出业务事件 */
  emit(event: DomainEvent): void;
}
```

`emit()` 只接受 `DomainEvent`——`LifecycleEvent` 由状态机自动产生，外部不可伪造。

### 2.5 Execution Tree Invariants（运行时不变量）

这些不变量是 Runtime 正确性的底线，任何情况下不得违反。

**Invariant 1：Root Node 唯一**
每棵 Execution Tree 有且仅有一个根节点（`parent === null`）。`runtime.createRoot()` 保证这一点。

**Invariant 2：节点只有一个 Parent**
每个 `ExecutionNode.parent` 指向唯一的父节点。`createChild()` 保证这一点。

**Invariant 3：终态不可逆**
`COMPLETED`、`FAILED`、`CANCELLED`、`TIMEOUT` 一旦进入，不可再转移为任何其他状态。状态机在 `setState()` 中硬性校验。

**Invariant 4：父节点完成前，所有子节点必须进入终态**
`parent.complete()` 调用时，如果存在非终态的子节点，Runtime 必须：
- 要么拒绝完成（抛出错误）
- 要么自动取消所有活跃子节点后完成

V1 采用后者：`complete()` 自动对活跃子节点调用 `cancel('parent completed')`。这个行为显式文档化，防止幽灵任务。

**Invariant 5：事件顺序与状态转移一致**
对于任一执行节点，`LifecycleEvent` 的出现顺序必须与其状态转移历史完全一致：

```
node.started  →  node.completed   // 正确
node.completed → node.started     // 不可能（状态机拒绝）
node.started  →  node.cancelled   // 正确
node.started  →  node.completed → node.failed  // 不可能（终态不可逆）
```

### 2.6 跨进程设计预留

V1 仅实现单进程 Execution Tree。但 ExecutionNode、RunContext、ExecutionResult 三个核心类型的接口设计必须满足未来可序列化：

- `RunContext` 已经是纯数据（`interface`，无方法），可直接 `JSON.stringify`
- `ExecutionResult` 是 discriminated union，可序列化
- `ExecutionNode` 的公开状态（id, type, parent.id, state, duration）可序列化

这保证半年后如果出现 `Workflow Step → BullMQ Job → Worker → SubAgent` 的跨进程模式，Execution Tree 的核心模型不需要重新设计——只需在进程边界做序列化/反序列化。

---

## 3. 执行树

### 3.1 树结构

```
Chat Run
 ├── Agent Run
 │    ├── Tool Run (web_search)
 │    ├── Tool Run (file_read)
 │    └── Tool Run (file_write)
 ├── Agent Run (subagent)
 │    └── Tool Run (db_query)
 └── Respond Run
```

每一层都是 `ExecutionNode`。Chat 不知道 Tool 的内部逻辑，但它知道 Tool 在执行、Tool 的状态、Tool 的结果——因为 Tool 是它的子节点。

### 3.2 取消传播

```
parent.cancel("user interrupted")
  → child1.cancel("parent cancelled")
  → child2.cancel("parent cancelled")
    → grandchild.cancel("parent cancelled")
```

取消从父到子级联，不可逆。每个节点在自己的 `cancel()` 中做清理（关闭连接、删除临时文件等）。

### 3.3 超时继承

```
chat (timeout: 120s)
 ├── agent (timeout: 90s)     // 继承自 chat，但可以缩小
 │    ├── tool (timeout: 30s)  // 每个 tool 有自己的默认超时
 │    └── tool (timeout: 30s)
 └── respond (timeout: 20s)
```

子节点的超时自动取 `min(自身默认值, 父节点剩余时间)`。

---

## 4. Runtime 的边界

### 4.1 属于 Runtime

| 职责 | 说明 |
|------|------|
| 节点创建/完成/取消 | ExecutionNode 的生命周期 |
| 父子生命周期传播 | 取消级联、超时继承 |
| 统一结果类型 | ExecutionResult 及其消费者 |
| 生命周期事件 | LifecycleEvent 的自动产生和分发 |
| 执行树追踪 | ancestry + 状态 + 时序 |
| 运行时 Invariants | 第 2.5 节定义的 5 条不变量 |

### 4.2 不属于 Runtime

| 职责 | 归属 |
|------|------|
| Agent 的 ReAct 循环逻辑 | AgentService |
| Workflow 的 DAG 编排 | WorkflowEngine |
| 具体工具的 Schema 和实现 | ToolRegistry |
| 取消策略（graceful vs force） | 上层 Service 在 cancel() 回调中实现 |
| LLM 调用和流式处理 | LLMProvider |
| 持久化策略 | 上层 Service |
| UI 渲染 | Frontend |
| Prompt 上下文组装 | Context Pipeline（Agent Layer） |
| 业务事件（tool.invoked, llm.request 等） | 上层 Service 通过 `emit()` 发出 |

### 4.3 判断标准

一个能力是否应该进入 Runtime：

- ✅ 至少被 3 个不同 Service 重复实现 → 属于 Runtime
- ✅ 不依赖具体业务语义（不关心"这是 Chat 还是 Agent"）→ 属于 Runtime
- ❌ 只有一个 Service 在用 → 留在 Service 内部
- ❌ 包含业务策略（"何时重试"、"如何降级"、"Prompt 如何组装"）→ 不属于 Runtime

**特别说明：Context Pipeline 不属于 Runtime。** Context Pipeline 管理的是 Prompt 组装策略，不同的 Agent 类型（ReAct、PlanSolve、CodeAgent、MultiAgent）可能有完全不同的 Context Strategy。但它们共享同一个 Execution Tree。Context Pipeline 是 Execution Tree 的消费者，定义在 Agent Layer，不在 Runtime Layer。

---

## 5. 与现有代码的演化关系

### 5.1 从 ExecutionController + RunContext 到 ExecutionNode

当前代码：

```typescript
// context.ts
interface RunContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly ancestry: string[];
}

// controller.ts
class ExecutionController {
  readonly context: RunContext;
  start(): void;
  complete(): RunResult;
  interrupt(): RunResult;
  fail(error: string): RunResult;
}
```

演化路径：

```
ExecutionController + RunContext
        ↓
   ExecutionNode     // 合并生命周期 + 身份，但保持 RunContext 不可变
        ↓
   + 子节点管理        // createChild(), children, 取消级联
        ↓
   + LifecycleEvent   // 状态转移时自动产生
        ↓
   + ExecutionResult  // 替换 string/fail() 参数
        ↓
   + DomainEvent      // emit() 供 Service 发出业务事件
```

**这不是重写，是合并和增强。** `ExecutionController` 的状态机和 `RunContext` 的身份模型都保留，只是组织方式变了。

### 5.2 现有的 Runtime 模块

当前 `apps/server/src/runtime/` 包含：

| 文件 | 内容 | V1 演化 |
|------|------|---------|
| `context.ts` | `RunContext` 接口 + 工厂函数 | 保留，作为 ExecutionNode 的 `context` 字段 |
| `controller.ts` | `ExecutionController` 状态机 | 吸收进 ExecutionNode |
| `buffer.ts` | `OutputBuffer` | 保留，作为输出累积器 |
| `scope.ts` | `ExecutionScope` 聚合入口 | 替换为 `runtime.createRoot()` |
| `index.ts` | 导出 | 更新导出 |

### 5.3 对上层 Service 的影响

**ChatService.streamChat() 的简化（示意）：**

Before（当前）:
```typescript
async streamChat(params) {
  const ctx = createRunContext(signal);
  const controller = new ExecutionController(ctx);
  const buffer = new OutputBuffer();

  controller.start();

  // 手动管理状态
  if (controller.shouldStop) { /* 清理 */ }

  // ... LLM 调用 ...

  if (error) {
    controller.fail(error.message);  // 手动记录失败
  } else {
    controller.complete();           // 手动记录完成
  }
}
```

After（V1）:
```typescript
async streamChat(params) {
  const node = runtime.createRoot('chat', { signal });

  node.start();  // 自动发出 LifecycleEvent: node.started

  // ... LLM 调用 ...

  // Service 发出业务事件（AgentPanel / Trace 需要的信息）
  node.emit({ type: 'llm.request', nodeId: node.id, provider, model, messages });
  node.emit({ type: 'llm.response', nodeId: node.id, content, usage, latencyMs });

  // 中断检查
  if (controller.shouldStop) {
    node.cancel('interrupted');  // 自动传播到子节点 + 发出 LifecycleEvent
    return;
  }

  node.complete({ status: 'success', output: result });
  // 自动发出 LifecycleEvent: node.completed
  // Trace、Metrics、AgentPanel 都收到了
}
```

**关键区别：** 生命周期管理（状态转移、LifecycleEvent 发出、取消传播）从 Service 代码中移除，变成了 Runtime 的自动行为。Service 只需通过 `emit()` 发出业务事件来丰富 Trace/AgentPanel 的信息。

---

## 6. 消费者体系

所有上层模块退化为 **Execution Tree 的生产者或消费者**：

```
                    ┌─────────────┐
                    │  Execution  │
                    │    Tree     │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           │               │               │
     ┌─────┴─────┐   ┌────┴────┐   ┌──────┴──────┐
     │  Producer │   │ Consumer│   │  Consumer   │
     │           │   │         │   │             │
     │ Chat      │   │ Trace   │   │ Metrics     │
     │ Agent     │   │ Panel   │   │ Prometheus  │
     │ Workflow  │   │ Debug   │   │ OTel        │
     │ Voice     │   │         │   │             │
     │ Tool      │   │         │   │             │
     └───────────┘   └─────────┘   └─────────────┘
```

- **Producer**：创建 ExecutionNode，调用生命周期方法，发出 DomainEvent
- **Consumer**：订阅事件流，渲染 UI / 记录日志 / 聚合指标

Producer 和 Consumer 互不知晓——它们只通过 Execution Tree 的事件流通信。

---

## 7. 实施路径

文档已经足够好。现在应该进入代码验证。真正的风险不在于设计不清晰，而在于**继续设计**——那些会暴露问题的细节，不会出现在文档里，而会出现在第一次 `ToolExecutor: Promise<string>` → `Promise<ExecutionResult>` 的改动中。

### Week 1：验证核心抽象

1. **ExecutionResult** 类型定义 + `types.ts` 更新
2. **ExecutionState** 替换 `RunState`（语义等价，名称统一）
3. **ExecutionNode** 最小实现（无事件，无子节点——先用当前 `ExecutionController` 的代码直接改）
4. **ToolExecutor 签名改动**：`Promise<string>` → `Promise<ExecutionResult>`
5. **degradation-chain.ts** 改为读取 `ExecutionResult.status`，删除字符串匹配逻辑

**验收标准**：所有 159 个现有测试仍然通过。Tool 的返回类型变了，但行为不变。

### Week 2：树 + 事件

6. **子节点管理**：`createChild()` + `children` + 取消级联
7. **LifecycleEvent** 自动产生（状态转移时）
8. **DomainEvent** emit 机制
9. **HTML Trace**（消费事件流，写入自包含 HTML 文件）
10. **AgentPanel** 改为订阅 `events` 而非解析 SSE 字符串

**验收标准**：一个 Agent Run 的完整 Trace HTML 可以打开浏览器查看。

### Week 3：集成

11. **ChatService** 迁移到 `runtime.createRoot()`
12. **AgentService** 迁移到子节点
13. **WorkflowEngine** 迁移到 Execution Tree（每个 Step 一个子节点）
14. **统一 Config**：散落的硬编码常量收敛到一个结构化配置对象

### P2（之后）

- Optimistic File Lock（利用 `ExecutionErrorCode.CONFLICT`）
- AgentPanel V2：渲染 Execution Tree 而非仅 ReAct 步骤
- Context Pipeline（独立文档，Agent Layer，不在 Runtime V1 范围）

---

## 8. 不做什么

- **不重写现有 Service**：ChatService、AgentService、WorkflowEngine 保持功能不变，逐步迁移到 ExecutionNode
- **不引入新的外部依赖**：Runtime 是纯 TypeScript 抽象
- **不强制 Event-Driven Architecture**：LifecycleEvent 是状态投影，DomainEvent 是可选增强。Service 可以完全不 emit DomainEvent，Runtime 仍然正常工作
- **不替代 BullMQ**：异步任务队列仍然由 BullMQ 管理。V1 Execution Tree 只覆盖单进程同步执行
- **V1 不实现跨进程 Execution Tree**：但核心类型（RunContext、ExecutionResult）的设计保持可序列化，为未来预留
- **不把 Context Pipeline 放进 Runtime**：它是 Agent Layer 的关注点，不同 Agent 类型有不同策略

---

## 9. 一句话总结

**AgentForge Runtime 的本质是 Execution Tree。ExecutionNode 管理"什么东西在执行"，ExecutionResult 定义"执行产生了什么"，LifecycleEvent 是状态变化的诚实投影，DomainEvent 是业务行为的可选记录。Agent、Tool、Workflow、Voice 都是 Execution 的一种形式——它们生产 ExecutionNode，Runtime 管理它们的生命周期并强制不变量，消费者观察它们的事件流。**
