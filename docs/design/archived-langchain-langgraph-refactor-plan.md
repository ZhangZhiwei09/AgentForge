# LangChain / LangGraph 混合重构方案（Agent Runtime 内核渐进迁移）

> 版本: v1.2 Approved | 日期: 2026-06-27 | 作者: Architect
> 状态: Re-Review 通过，所有 P0 问题已解决

## 修订历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-06-26 | 初版方案：保留 Agent Runtime 外壳，仅将 TASK 路由内部渐进迁移为 LangGraph，LangChain 仅做 Tool / Retriever / Prompt / Structured Output 适配层 |
| Review v1 | 2026-06-26 | Architecture Reviewer 给出 CHANGES_REQUIRED：指出 pause/resume/approval 跨请求续跑模型未定义清楚、缺少 durable resumable state、ToolRegistry 约束不够硬、SSE contract parity 不够具体、低估 AgentService 的共享影响范围 |
| v1.1 | 2026-06-26 | 修订：新增 AgentService facade + runner 模型；新增会话级 engine stickiness；新增 durable graph checkpoint 设计；将 ToolRegistry.execute 设为不可绕过硬约束；将 SSE 事件顺序 parity 设为迁移门槛；重写分阶段路径，按调用方灰度 rollout |
| Review v2 | 2026-06-27 | Architecture Reviewer 再次审查：指出 7 个 P0 阻塞问题 —— runtime_state 与现有状态字段重叠（P0-1）、resumeCursor 定义空洞无法承载 LangGraph CheckpointTuple 序列化（P0-2）、约束 7 与 durable state 根本矛盾（P0-3）、degrade 节点在图设计中缺失（P0-4）、checkpoint 版本兼容性无保障（P0-5）、SSE parity 测试方法论缺失（P0-6）、Phase 3A→3B SSE 映射层差异未计入 parity 测试范围（P0-7） |
| v1.2 | 2026-06-27 | 全部修复：重写第 10 节（PrismaCheckpointer 架构 + 状态字段权威性定义 + checkpoint 版本策略）；新增 11.3 degrade 节点；修正约束 7 措辞；新增 14.4 Parity Test Design Doc；扩展 14.2/14.3 增加 AgentExecutor 集成测试维度；新增 11.4 cancel 传播设计；更新 Phase 0 产出清单 |

---

## 1. 背景与目标

### 1.1 当前架构现状

AgentForge 当前已经具备清晰的 Agent Runtime 外壳：

```text
用户请求
  -> AgentRuntimeService
    -> QueryRouter (SAFETY / CHAT / TASK / HUMAN)
      -> 对应 RouteAgent
        -> TASK 路由由 AgentExecutor 包装 AgentService.run() 执行
          -> ToolRegistry
          -> KnowledgeContextBuilder
          -> CitationVerifier
          -> SSE RouteStreamEvent
```

当前仓库中与本次重构直接相关的核心事实：

- `apps/server/src/services/agent-runtime.ts`
  - 已承担会话管理、历史加载、记忆注入、路由分发、SSE 流式编排等职责
- `apps/server/src/services/agent-runtime/router.ts`
  - 已实现 Rule First + LLM Fallback 的 4-route 分类器
- `apps/server/src/services/agent-runtime/agent-executor.ts`
  - 已承担 TASK 路由统一入口、知识上下文构建、Citation 校验、SSE 映射
- `apps/server/src/services/agent/index.ts`
  - 已实现复杂 ReAct loop，并包含 tool call、approval gate、ask_user、resume、degrade 等逻辑
- `apps/server/src/tools/registry.ts`
  - 已实现工具注册、分类、超时、取消、熔断、指标埋点
- `docs/runtime/execution-runtime-v1.md`
  - 已明确 Runtime V1：`RunContext` / `ExecutionController` / `OutputBuffer` / `ExecutionScope`

结论：**AgentForge 并不缺一个“总框架”，而是缺一个更清晰、可恢复、可灰度替换的 Agent 内核状态编排层。**

### 1.2 当前痛点

当前复杂度最高的部分不在 Router 或 Tool 层，而在 `AgentService` 的手写 ReAct loop：

1. `run()` / `resume()` / `continueReActLoop()` / `handleApproval()` 语义分散且耦合高
2. `approval_required` / `ask_user` / `interrupt` / `degrade` 分支很多，状态跨请求恢复困难
3. LLM 流输出、Tool 执行、Scratchpad、持久化之间耦合较深
4. 新增 Planner、Replan、多子任务能力时，现有 loop 会继续膨胀
5. 当前代码已经具备状态机雏形，但“状态是什么、在哪保存、如何恢复”并不显式

### 1.3 本次重构目标

本次重构不追求“LangChain 化整个仓库”，而是追求：

- **保留 Runtime 外壳**，不推翻现有 Agent Runtime 设计
- **仅替换 Agent 内核状态机**，优先解决 run / resume / approval 的可维护性与可恢复性
- **使用 LangGraph 显式管理状态图与中断恢复**
- **使用 LangChain Core 统一 Tool / Prompt / Structured Output / Message Adapter**
- **保持外部 API、SSE 协议、持久化语义兼容**
- **通过会话级 engine stickiness + 按调用方灰度 rollout 实现可回滚迁移**

---

## 2. 设计原则与非目标

### 2.1 必须遵守的架构约束

本方案必须严格遵守项目现有约束：

1. **Agent Runtime 是系统核心**
   - 不允许绕过 `AgentRuntimeService` 创建第二条独立 Agent 主链路
2. **统一 AgentExecutor / AgentService facade**
   - 不允许为 LangGraph 新建平行的 `/api/langgraph/*` Agent API
3. **保留 4-route 分类器**
   - SAFETY / CHAT / TASK / HUMAN 继续由当前 Router 决定
4. **最小改动、渐进迁移**
   - 优先替换内核执行状态机，而不是推翻系统壳层
5. **外部 API 兼容**
   - `/api/agent/chat`、`/api/agent/run`、`/api/agent/respond`、`/api/agent/approve`、现有 SSE 协议保持兼容
6. **Prompt 中文化**
   - 所有新增 Prompt / Tool Description / Context Template / Structured Output 指令必须使用中文
7. **AgentService/AgentExecutor 层不直接操作持久化，LangGraph Checkpointer 通过明确的 CheckpointAdapter 接口与现有事实源交换序列化后的 checkpoint blob**
   - AgentService/AgentExecutor 层的业务持久化行为（message 写入、session status 更新）继续由现有 Service/Session Persistence 层控制
   - LangGraph Checkpointer 作为 runtime 内部适配器，通过 `CheckpointAdapter` 接口读写 `agent_sessions.runtime_state`
   - CheckpointAdapter 不直接 import PrismaClient —— 它通过 session-persistence 模块暴露的受限接口操作 agent_sessions 表
   - 这并非"Runtime 不关心持久化"的例外，而是将 checkpoint 视为 LangGraph runtime 的内部序列化状态，其持久化生命周期由 checkpointer adapter 自行管理，与业务持久化层解耦
8. **不允许绕过 ToolRegistry**
   - 任何 graph 工具执行都必须通过 `toolRegistry.execute()`

### 2.2 非目标（本次明确不做）

本次方案**不包含**：

1. 不将整个项目改写为 LangChain-first / LangGraph-first 框架
2. 不替换 `QueryRouter`
3. 不替换 `ToolRegistry`
4. 不替换 `ExecutionScope` / `RunContext` / `ExecutionController`
5. 不将现有 Workflow Engine (`apps/server/src/workflows/*`) 一并迁移到 LangGraph
6. 不把 Teams / Multi-Agent / Video 路径纳入首轮 rollout
7. 不采用 prebuilt 黑盒 ReAct agent，避免丢失审批、SSE、citation、取消控制能力

---

## 3. 为什么是 LangChain + LangGraph，而不是全自研或全框架化

### 3.1 为什么引入 LangGraph

LangGraph 适合解决的正是 AgentForge 当前最重的部分：

- 显式状态管理
- 条件分支
- 中断 / 恢复
- Human-in-the-loop
- 子图扩展
- 后续 Planner / Replan 预留

当前 `AgentService` 实际上已经在做：

```text
Plan / Decide -> Tool Call -> Observe -> Respond
                      |            |
                      v            v
                 Approval Gate   Ask User
```

LangGraph 的收益在于：

- 把“隐式控制流”变成“显式图结构”
- 将 `run / resume / continue / handleApproval` 的重复状态处理收拢到统一 runner 语义
- 为跨请求续跑提供明确的 checkpoint 边界
- 为未来复杂 Agent 能力扩展提供稳定骨架

### 3.2 为什么引入 LangChain

LangChain 在本项目中的合理定位不是接管主架构，而是作为**适配层工具箱**：

- Tool Adapter
- Prompt Template
- Structured Output
- Message Adapter
- Runnable 组合能力

LangChain 适合做“部件标准化”，但不适合在当前阶段直接替换掉 AgentForge 已经成熟的 Runtime 外壳。

### 3.3 为什么不做全量迁移

当前仓库已有大量与业务强相关的运行时能力：

- 工具审批
- Tool 熔断
- 取消与超时传播
- Citation 校验
- 业务回复校验
- RouteStreamEvent SSE 协议
- 现有前端消费链路
- Workflow DAG 引擎
- Teams Blackboard / Message Bus

如果直接改成 prebuilt agent 或完全依赖框架内建执行器，会损失这些差异化资产，并引入更高的不确定性。

结论：**最优路线不是“用 LangChain/LangGraph 替换 AgentForge”，而是“让 LangChain/LangGraph 嵌入 AgentForge 的 Agent 内核层”。**

---

## 4. 影响范围与边界重新定义

### 4.1 关键修正：本次不是只影响 `AgentExecutor`

Architecture Review 指出了一个关键问题：`AgentService` 并不只被 TASK 路由使用，还被以下入口直接复用：

- `apps/server/src/routes/agent.ts`
  - `/api/agent/run`
  - `/api/agent/respond`
  - `/api/agent/approve`
- `apps/server/src/workflows/handlers/agent-step.ts`
- `apps/server/src/teams/modes/orchestrator.ts`
- `apps/server/src/teams/modes/peer.ts`
- `apps/server/src/teams/modes/debate.ts`

因此，正确的架构边界不是“在 `agent-runtime/task-graph` 下偷偷替换一个 TASK 子模块”，而是：

> **将 `AgentService` 重构为 facade + runner selector，但首轮 rollout 只在特定调用方开启 LangGraph runner。**

### 4.2 迁移边界

本次方案的真实边界应定义为：

1. **架构边界**：重构 `AgentService` 内核实现方式
2. **运行边界**：首轮只灰度到指定调用方
3. **协议边界**：对外仍保持现有 API / SSE / session persistence 语义

### 4.3 调用方分类

| 调用方 | 现状 | 首轮策略 |
|---|---|---|
| `AgentRuntimeService -> AgentExecutor` | TASK 路由，用户面最大 | 不是第一批，需在 raw agent API 之后再灰度 |
| `/api/agent/run/respond/approve` | 最直接使用 `AgentService` | 第一批灰度目标 |
| `workflows/handlers/agent-step.ts` | Workflow 中复用 AgentService | 首轮不迁移，后置 |
| `teams/modes/*` | Team 协作模式复用 AgentService | 首轮不迁移，保持 legacy |

---

## 5. 目标架构

### 5.1 总体形态

推荐采用 **Hybrid Runtime + Shared Agent Facade**：

```text
API / Runtime / Workflow / Team 调用方
  -> AgentService (Facade)
     -> RunnerSelector
        -> LegacyAgentRunner
        -> LangGraphAgentRunner
             -> decide
             -> approval_gate
             -> execute_tool
             -> observe
             -> ask_user
             -> respond
             -> finalize

其中：
- AgentRuntimeService / QueryRouter / AgentExecutor 继续保留
- ToolRegistry / ExecutionScope / ProviderRegistry 继续保留
- KnowledgeContextBuilder / CitationVerifier / Business Validation 继续保留在 AgentExecutor 外层
```

### 5.2 核心思想

- **Runtime 外壳不动**：`AgentRuntimeService` 继续做入口编排
- **AgentService 变 facade**：对外方法签名不变，对内选择 runner
- **LangGraph 只替换内核状态机**：不直接碰 API 层或 Tool 底座
- **Tool 真实执行仍经 ToolRegistry**：LangChain Tool 只是 schema adapter，不是新的工具系统
- **持久化仍经现有 DB 事实源**：但允许在同一事实源内新增 durable graph state 字段
- **灰度必须按调用方进行**：不能直接 global switch

---

## 6. 哪些部分适合引入 LangGraph，哪些适合引入 LangChain，哪些继续保留自研

## 6.1 适合引入 LangGraph 的部分

### A. Agent 内核执行状态机

将当前 `AgentService` 的 ReAct 状态显式化为 StateGraph：

- `decide`
- `approval_gate`
- `execute_tool`
- `observe`
- `ask_user`
- `respond`
- `finalize`
- `fail / degrade`

### B. Pause / Resume / Approval 语义

当前审批与澄清都具备“跨请求暂停后恢复”的运行特征，LangGraph 很适合承担这部分状态流转；但前提是**有 durable resumable state**，见第 10 节。

### C. 未来可扩展子图

未来可以自然扩展：

- planner 子图
- rag 子图
- reflective / replan 子图

## 6.2 适合引入 LangChain 的部分

### A. Tool Adapter

保持 `ToolRegistry` 为 source of truth，新建 LangChain-compatible Tool adapter。

**硬约束：**

- Tool metadata 仍来自 `RegisteredTool`
- 真正执行必须调用 `toolRegistry.execute(name, args, context)`
- 不允许 adapter 直接 import 业务工具执行函数
- 继续保留 timeout / cancel / circuit breaker / metrics

### B. Prompt / Structured Output

将 decision prompt、respond prompt、structured output schema 模板化，并收敛到统一中文 prompt 策略。

### C. Message Adapter

把现有 `ChatMessage[]`、scratchpad、tool result 注入组织成统一的 graph 消息拼装层。

## 6.3 必须继续保留自研的部分

| 模块 | 保留原因 |
|---|---|
| `AgentRuntimeService` | 总入口、会话、历史、记忆、路由、SSE 编排已成熟 |
| `QueryRouter` | 4-route 分类器已契合业务架构 |
| `AgentExecutor` | TASK 路由 facade + 后处理层 |
| `ExecutionScope` / `RunContext` | 取消与运行树模型是系统地基 |
| `ToolRegistry` | 已承载审批、超时、熔断、埋点 |
| `ProviderRegistry` / `LLMProvider` | 已统一 OpenAI / DeepSeek 调用抽象 |
| `KnowledgeContextBuilder` | 当前知识上下文整理逻辑具业务特性 |
| `CitationVerifier` | 项目级可信回答差异化能力 |
| `validateBusinessResponse` | 业务护栏不可交给通用框架 |
| `MemoryEngine` | 已对接现有记忆抽取与检索 |
| `RouteStreamEvent` / `AgentStreamEvent` | 前后端已对齐，不能轻易改变 |
| Workflow Engine | 已有 `apps/server/src/workflows/*`，本期不重复造轮子 |
| Teams 协作框架 | 已有 MessageBus / Blackboard，本期不改 |

---

## 7. 与现有代码的映射关系

| 现有模块 | 重构后角色 | 处理策略 |
|---|---|---|
| `apps/server/src/services/agent-runtime.ts` | 总编排层 | 保留 |
| `apps/server/src/services/agent-runtime/router.ts` | 4-route 分类器 | 保留 |
| `apps/server/src/services/agent-runtime/agent-executor.ts` | TASK facade + 后处理层 | 保留外壳 |
| `apps/server/src/services/agent/index.ts` | Agent facade | 对外签名不变，对内 runner 选择 |
| `apps/server/src/routes/agent.ts` | raw agent API | 首轮灰度入口 |
| `apps/server/src/workflows/handlers/agent-step.ts` | workflow consumer | 首轮保持 legacy |
| `apps/server/src/teams/modes/*` | team consumers | 首轮保持 legacy |
| `apps/server/src/tools/registry.ts` | 工具真实执行层 | 保留，不可绕过 |
| `apps/server/src/services/agent-runtime/knowledge-context.ts` | 知识上下文构建 | 保留 |
| `apps/server/src/services/agent-runtime/citation-verifier.ts` | 引证校验 | 保留 |
| `packages/shared-prompts/src/index.ts` | 中文 Prompt 容器 | 扩展，新增 runner prompt 模块 |
| `packages/database/prisma/schema.prisma` 中 `AgentSession` / `AgentApproval` | persistence 事实源 | 保留，可做最小增量扩展 |
| `apps/server/src/workflows/*` | Workflow Engine | 保留，不纳入本期迁移 |

---

## 8. Runner 模型设计

### 8.1 AgentService facade

重构后的 `AgentService` 应成为统一 facade，对外继续暴露：

- `run()`
- `resume()`
- `handleApproval()`
- `getSession()`
- `getSessions()`

对内新增：

- `LegacyAgentRunner`
- `LangGraphAgentRunner`
- `RunnerSelector`

### 8.2 会话级 engine stickiness

Architecture Review 的关键要求：**engine 选择必须是会话级粘性，而不是每个请求重新读环境变量。**

设计要求：

1. `run()` 创建 session 时确定 engine
2. engine 类型写入 durable session state
3. `resume()` / `handleApproval()` 必须按 session 中记录的 engine 继续执行
4. 即使环境变量后来切换，已暂停 session 也必须回到原 engine

建议 engine 值：

- `legacy`
- `langgraph`

### 8.3 调用方级 rollout，而不是全局开关

不能只有一个全局 `AGENT_TASK_ENGINE=...` 就切掉所有调用方。

建议 rollout 维度：

- `agent_direct_api`
- `agent_runtime_task`
- `workflow_agent_step`
- `team_modes`

每个维度都应可独立：

- 默认 legacy
- 独立灰度
- 独立回滚

---

## 9. 目标状态模型

### 9.1 建议的 Graph State

建议新增显式状态对象：

```typescript
interface LangGraphRunnerState {
  conversationId: string;
  sessionId: string;
  engine: "langgraph";
  phase: "decide" | "approval_gate" | "execute_tool" | "observe" | "degrade" | "ask_user" | "respond" | "finalize" | "failed";

  task: string;
  messages: ChatMessage[];
  scratchpad: AgentStep[];
  iteration: number;
  maxIterations: number;

  decision: AgentDecision | null;
  lastToolName: string | null;
  lastToolArgs: Record<string, unknown> | null;
  lastToolResult: ExecutionResult | null;

  finalContent: string | null;
  finalSummary: string | null;
  streamedMessageId: string | null;
  fallbackContent: string | null;

  // P0-4: 降级回环控制
  degradeCount: number;          // 连续降级计数
  degradeThreshold: number;      // 连续降级上限（默认 3），超限路由到 fail

  // P0-7: AgentExecutor 消息持久化控制
  skipUserMessageSave: boolean;
  skipAssistantMessageSave: boolean;

  // 11.4: respondOnly 双态切换
  responseMode: "decision" | "respond_only";

  // 11.3: Cancel 信号传播
  cancelSignal: AbortSignal | null;

  // 10.2: 内存压缩状态
  compressedSummary: string;
  keptStepNumbers: Set<number>;

  pendingInterrupt:
    | null
    | { type: "ask_user"; question: string; context?: string }
    | { type: "approval"; approvalId: string; toolName: string };

  resumeCursor: string | null;
  error: string | null;
}
```

### 9.2 与 Runtime V1 的关系

Graph State 只是 Agent 内核运行态，不替代 Runtime V1：

- `RunContext`：继续作为取消信号、runId、ancestry 来源
- `ExecutionController`：继续作为生命周期控制器
- `OutputBuffer`：继续承接流式输出缓冲
- `ExecutionScope`：继续作为 graph node 执行时的上下文容器

原则：**LangGraph 适配 Runtime，而不是 Runtime 适配 LangGraph。**

---

## 10. Durable Resumable State 设计（修订重点）

### 10.1 为什么必须有 durable state

Pause / resume / approval 在 AgentForge 中不是单次内存内循环，而是**跨 HTTP 请求恢复执行**：

- `/api/agent/respond` 继续 paused session
- `/api/agent/approve` 继续 approval session

因此，LangGraph runner 不能只在内存中保存状态；否则：

- 进程重启会丢状态
- 请求结束后无法恢复图执行
- 审批/澄清场景功能不完整

### 10.2 设计原则

本方案仍然坚持：**不新增第二事实源**。但这不等于”不保存 graph resumable state”。

正确表述应为：

> **LangGraph 的 durable state 由现有 `agent_sessions` 表承载，通过自定义 `PrismaCheckpointer` 将 LangGraph checkpoint 序列化写入 `runtime_state` 字段。Checkpointer 通过受限的 `CheckpointAdapter` 接口与持久化层交互，不直接操作 PrismaClient。**

### 10.3 Checkpointer 架构：PrismaCheckpointer + CheckpointAdapter

#### 10.3.1 为什么自研 PrismaCheckpointer 而不是用 LangGraph 内置的 PostgresSaver

LangGraph 提供 `MemorySaver`（进程内存）、`SqliteSaver`、`PostgresSaver`，以及 `BaseCheckpointSaver` 接口。

- `MemorySaver`：无法满足跨请求恢复需求（P0 blocker）
- `PostgresSaver`：会创建独立的 `langgraph_checkpoints` 表，违反”不新增第二事实源”约束，且不感知 `agent_sessions` 的现有 schema
- `SqliteSaver`：项目使用 PostgreSQL

因此选择**自研 `PrismaCheckpointer`**，实现 LangGraph 的 checkpoint 接口，将 checkpoint 数据序列化到 `agent_sessions.runtime_state` 中。

#### 10.3.2 CheckpointAdapter 接口

```typescript
/**
 * CheckpointAdapter — LangGraph Checkpointer 与 agent_sessions 持久化之间的桥接层。
 * 不直接暴露 PrismaClient，通过 session-persistence 模块操作 agent_sessions 表。
 */
interface CheckpointAdapter {
  /**
   * 读取 session 的 runtime_state（包含序列化的 checkpoint）。
   * 返回 null 表示 session 不存在或无 runtime_state。
   */
  getRuntimeState(sessionId: string): Promise<AgentSessionRuntimeState | null>;

  /**
   * 写入 session 的 runtime_state。
   * 仅更新 runtime_state 相关字段（engine, checkpointVersion, phase, resumeCursor,
   * pendingInterrupt, graphState），不修改 status / scratchpad / finalSummary。
   */
  putRuntimeState(
    sessionId: string,
    state: AgentSessionRuntimeState,
  ): Promise<void>;
}
```

#### 10.3.3 LangGraph Checkpoint 到 runtime_state 的映射

LangGraph 的 checkpoint 是一个 `CheckpointTuple`，包含：

```typescript
// LangGraph 内部结构（概念表示）
interface CheckpointTuple {
  config: { configurable: { thread_id: string; checkpoint_id: string } };
  checkpoint: {
    v: number;                    // schema version
    ts: string;                   // timestamp
    channel_values: Record<string, unknown>;  // 每个 channel 的最新值
    channel_versions: Record<string, number>; // 每个 channel 的版本号
    versions_seen: Record<string, Record<string, number>>; // 各节点见过的版本
    pending_sends: Array<unknown>; // 待发送的跨节点消息
  };
  metadata: { source: string; step: number; parents: Record<string, string> };
  parentConfig?: { configurable: { thread_id: string; checkpoint_id: string } };
}
```

映射关系：

| LangGraph 概念 | agent_sessions 字段 | 说明 |
|---|---|---|
| `thread_id` | `id`（sessionId） | 一对一映射 |
| `checkpoint_id` | `runtime_state.resumeCursor` | 最后一个 checkpoint 的 ID |
| `CheckpointTuple` | `runtime_state.graphState` | 完整序列化的 checkpoint tuple（JSON blob） |
| `channel_values` 中的 `messages` | `agent_sessions.scratchpad`（投影） | scratchpad 是已完成的 AgentStep[]，与 graph state 中的 messages 保持语义一致 |
| `pending_sends` | `runtime_state.graphState` 内 | 序列化在 checkpoint 内部 |

#### 10.3.4 resumeCursor 的准确定义

`resumeCursor` **不是**一个简单的字符串指针，而是 **LangGraph checkpoint_id**。它的完整生命周期：

1. **写入**：每次 graph 进入中断状态（`approval_gate` 或 `ask_user` 节点）时，`PrismaCheckpointer.put()` 被 LangGraph 框架调用，此时：
   - checkpoint 序列化为 JSON 写入 `runtime_state.graphState`
   - `checkpoint_id` 写入 `runtime_state.resumeCursor`
   - `phase` 写入当前节点名（`approval_gate` 或 `ask_user`）

2. **恢复**：`resume()` / `handleApproval()` 调用时：
   - 从 `agent_sessions` 读取 `runtime_state`
   - 将 `runtime_state.graphState` 反序列化回 `CheckpointTuple`
   - 通过 `graph.astream(null, { config: { configurable: { thread_id: sessionId, checkpoint_id: resumeCursor } } })` 恢复执行
   - LangGraph 框架根据 `checkpoint_id` 自动定位到正确的 graph 位置继续

3. **完成/失败**：graph 运行到 `finalize` 或 `fail` 节点时：
   - `resumeCursor` 清空为 null
   - `phase` 设为 `finalize` 或 `failed`

### 10.4 推荐持久化方案

建议在 `AgentSession` 这一现有事实源上做最小增量扩展，新增 `runtime_state` JSON 字段。

推荐形态：

```typescript
interface AgentSessionRuntimeState {
  engine: “legacy” | “langgraph”;
  checkpointVersion: number;
  phase: string | null;
  resumeCursor: string | null;
  pendingInterrupt:
    | null
    | { type: “ask_user”; question: string; context?: string }
    | { type: “approval”; approvalId: string; toolName: string; toolArgs: Record<string, unknown> };
  graphState: Record<string, unknown> | null;
}
```

> **类型安全要求**：`graphState` 的 `Record<string, unknown>` 是 JSON 序列化边界类型 —— Prisma Json 列以 `unknown` 传入/传出。在 `PrismaCheckpointer` 内部，`put()` 时通过 `zod` schema 校验 `CheckpointTuple` 结构后再序列化，`get()` 时通过同一个 zod schema 校验后再还原为类型化的 `CheckpointTuple`。业务代码（AgentService facade、RunnerSelector）只与类型化的 `AgentSessionRuntimeState` 交互。

推荐持久化位置：

- **方案 A（采用）**：在 `agent_sessions` 表增加 `runtime_state` JSON 字段（Prisma：`Json?`，PostgreSQL：`JSONB`）
- 方案 B（废弃）：在现有 `scratchpad` JSON 外层包 versioned envelope —— 会让 legacy 类型语义变脆，不可取

**本方案选择方案 A。**

### 10.5 与现有状态字段的关系（P0-1 解决）

当前 `agent_sessions` 表已通过 `status` + `scratchpad` 承载会话状态。新增 `runtime_state` 后，必须明确各字段的权威性边界。

#### 10.5.1 各字段的职责与权威性

| 字段 | 职责 | 权威性 | 谁写入 | 谁读取 |
|---|---|---|---|---|
| `status` | 会话生命周期状态：`running` / `paused` / `completed` / `failed` | **决定性权威** —— 系统以 status 为会话是否存活的一级判断依据 | `saveSession()`（所有 runner） | `resume()` / `handleApproval()` / API 查询 |
| `scratchpad` | 已完成的 AgentStep[] 历史（决策、工具调用、结果）。对两个 engine 语义相同。 | **业务数据权威** —— 完整记录 agent 的思考与行动轨迹 | `saveSession()`（所有 runner） | AgentPanel API、debug、压缩 |
| `runtime_state` | LangGraph 引擎专属的 graph 恢复元数据（checkpoint blob、当前 node、pending interrupt） | **引擎恢复辅助数据** —— 仅在 `engine === “langgraph”` 时有意义。`status = “paused”` 时 runtime_state 提供”如何恢复”的细节。 | `PrismaCheckpointer.put()`（仅 langgraph runner） | LangGraph runner 恢复路径 |
| `AgentApproval` | 审批业务记录（审批 ID、工具名、参数、风险级别、审批人、决定时间） | **审批审计权威** —— 独立于 session 状态 | `AgentService` 审批逻辑 | `/api/agent/approve`、审计 |

#### 10.5.2 状态写入顺序与一致性保证

```text
每次状态变更的写入顺序（关键路径）:

1. saveSession(record, scratchpad, status, finalSummary)  ← 先写决定性字段
2. checkpointAdapter.putRuntimeState(sessionId, runtimeState)  ← 再写辅助恢复字段
```

崩溃一致性策略：

- **启动时扫描**：服务启动或 worker 启动时，扫描 `status = “paused”` 且 `runtime_state.engine = “langgraph”` 的 session。如果 `runtime_state.resumeCursor` 非 null，标记 session 为可恢复；如果 `runtime_state` 为 null，降级到 legacy engine 处理（因为缺乏恢复信息，无法用 LangGraph 恢复）
- **不一致修复规则**：以 `status` 为准。如果 `status = “completed”` 但 `runtime_state.phase = “approval_gate”`，忽略 `runtime_state`（session 已通过其他路径完成）。如果 `status = “paused”` 但 `runtime_state.resumeCursor = null`（写入中断导致 runtime_state 未落盘），日志告警并降级为 `failed`

#### 10.5.3 scratchpad 兼容性约定

- **Legacy runner**：继续通过 `saveSession()` 写 `scratchpad`，不感知 `runtime_state`
- **LangGraph runner**：`saveSession()` 写 `scratchpad`（与 legacy 相同的 AgentStep[] 格式），同时 `PrismaCheckpointer.put()` 写 `runtime_state.graphState`（LangGraph 原生 checkpoint blob）
- **`scratchpad` 是两引擎共享的展示/调试数据**，`runtime_state.graphState` 是 LangGraph 引擎专属的内部恢复数据

### 10.6 与 AgentApproval 的关系

- `AgentApproval` 继续保存审批记录与审批结果
- `AgentSession.runtime_state.pendingInterrupt` 只保存”当前 runner 如何恢复”所需信息
- `messages` 继续保存用户 / assistant 对话历史

即：

| 信息 | 事实源 |
|---|---|
| 会话由哪个 engine 创建 | `agent_sessions.runtime_state.engine` |
| graph 当前停在哪个 node | `agent_sessions.runtime_state.phase` |
| graph 下一次从哪里继续 | `agent_sessions.runtime_state.resumeCursor`（LangGraph checkpoint_id） |
| graph checkpoint 完整数据 | `agent_sessions.runtime_state.graphState`（序列化 CheckpointTuple） |
| 当前等待 ask_user 还是 approval | `agent_sessions.runtime_state.pendingInterrupt` |
| 审批业务记录 | `agent_approvals` |
| 用户可见对话历史 | `messages` |

### 10.7 Checkpoint 版本兼容性策略（P0-5 解决）

#### 10.7.1 版本号定义

`runtime_state.checkpointVersion` 是一个单调递增的整数。初始值为 `1`。

每个 `checkpointVersion` 对应一个明确的 graph 定义版本（节点集合 + state schema）。版本号与部署配置关联（通过 `AGENT_LANGGRAPH_CHECKPOINT_VERSION` 环境变量或部署配置注入），不与 git commit hash 直接耦合。

#### 10.7.2 兼容性等级

| 变更类型 | 兼容性等级 | checkpointVersion | 处理策略 |
|---|---|---|---|
| Prompt 文本调整 | `compatible` | 不变 | 无需特殊处理 |
| 节点内部逻辑优化 | `compatible` | 不变 | 无需特殊处理 |
| 新增字段到 graph state（带默认值） | `compatible` | 不变 | 反序列化时补充默认值 |
| 新增节点（不影响现有边） | `compatible` | 不变 | 新 checkpoint 包含新节点信息 |
| 删除节点 | `incompatible` | 递增 | 旧 checkpoint 无法恢复，走 legacy 引擎完成 |
| 修改 state schema（字段重命名、类型变更） | `incompatible` | 递增 | 旧 checkpoint 无法恢复，走 legacy 引擎完成 |
| 修改边路由逻辑 | `incompatible` | 递增 | 旧 checkpoint 无法恢复，走 legacy 引擎完成 |

#### 10.7.3 恢复时的版本检查

```typescript
async function resumeGraphFromCheckpoint(
  session: AgentSession,
  graph: StateGraph,
  currentVersion: number,
): Promise<GraphRecoveryResult> {
  const runtimeState = session.runtime_state;

  // 版本不匹配 → 回退到 legacy engine
  if (runtimeState.checkpointVersion !== currentVersion) {
    logger.warn({
      sessionId: session.id,
      checkpointVersion: runtimeState.checkpointVersion,
      currentVersion,
    }, “Checkpoint version mismatch, falling back to legacy engine”);
    return { recoverable: false, reason: “version_mismatch” };
  }

  // 版本匹配 → 反序列化并恢复
  const checkpoint = deserializeCheckpoint(runtimeState.graphState);
  const config = {
    configurable: {
      thread_id: session.id,
      checkpoint_id: runtimeState.resumeCursor,
    },
  };
  return { recoverable: true, checkpoint, config };
}
```

#### 10.7.4 部署时的兼容性保障

1. **部署前检查**：部署新 graph 版本前，检查是否有 `status = “paused”` 的旧版本 langgraph session
2. **迁移策略**：
   - 如果 paused session 数量为 0：直接部署，无需迁移
   - 如果 paused session 数量 > 0 且变更兼容：无需特殊处理，旧 checkpoint 可恢复
   - 如果 paused session 数量 > 0 且变更不兼容：**将这些 session 的 engine 切换为 `legacy`**，通过 legacy runner 完成恢复。迁移 SQL 示例：
     ```sql
     UPDATE agent_sessions
     SET runtime_state = jsonb_set(runtime_state, '{engine}', '”legacy”')
     WHERE status = 'paused'
       AND runtime_state->>'engine' = 'langgraph'
       AND (runtime_state->>'checkpointVersion')::int < $NEW_VERSION;
     ```
3. **运行时降级**：如果 `resume()` 期间检测到版本不匹配（见 10.7.3），不抛异常，自动降级到 legacy runner 完成本次恢复。新请求继续按调用方配置选择 engine

### 10.8 恢复路径

#### `resume()`

1. 读 `AgentSession`
2. 检查 `runtime_state.engine`
3. 若为 `legacy`，走原有 `LegacyAgentRunner.resume()`
4. 若为 `langgraph`：
   a. 检查 `runtime_state.checkpointVersion` 与当前版本是否匹配
   b. 若版本不匹配，降级到 `LegacyAgentRunner.resume()`
   c. 若版本匹配，加载 `runtime_state.graphState`，反序列化 checkpoint
   d. 通过 `graph.astream(null, { config })` 恢复到 `ask_user` 之后的 graph continuation

#### `handleApproval()`

1. 读 `AgentSession`
2. 读 `AgentApproval`
3. 检查 `runtime_state.engine`
4. 若为 `legacy`，走原有 `LegacyAgentRunner.handleApproval()`
5. 若为 `langgraph`：
   a. 版本检查（同上）
   b. 注入 approval 结果到 graph state 的 `pendingInterrupt` 响应
   c. 恢复到 `approval_gate` 之后的 graph continuation

---

## 11. Graph 节点设计

### 11.1 节点总览

建议拆分为以下节点：

1. `prepare_context`
2. `decide`
3. `approval_gate`
4. `execute_tool`
5. `observe`
6. `degrade`（非终止，回环到 decide）
7. `ask_user`
8. `respond`
9. `finalize`
10. `fail`

### 11.2 每个节点职责

#### 11.2.1 `prepare_context`

职责：

- 接收 task / conversation history / scope
- 初始化 graph state
- 写入初始 runtime_state

#### 11.2.2 `decide`

职责：

- 调用 LLM 做当前轮决策
- 生成结构化 `AgentDecision`
- 写入 scratchpad 当前 step 草稿

要求：

- Prompt 必须中文
- structured output 必须校验
- 支持 legacy 风格的 `tool_call` / `respond` / `ask_user`

#### 11.2.3 `approval_gate`

职责：

- 对 `decision.action === "tool_call"` 的工具执行前判断是否需审批
- 复用现有 `RegisteredTool.requireApproval`
- 写入 `AgentApproval` 表
- 在 `AgentSession.runtime_state` 中保存 `pendingInterrupt`
- 触发 pause

#### 11.2.4 `execute_tool`

职责：

- 通过 Tool Adapter 调用 LangChain Tool 视图
- **底层必须委托 `toolRegistry.execute()`**
- 透传 `RunContext.signal`
- 接收 `ExecutionResult`

要求：

- 保留超时、取消、熔断、埋点能力
- 禁止 graph 节点直接跳过 ToolRegistry 调真实工具

#### 11.2.5 `observe`

职责：

- 将工具返回写回 scratchpad / message context
- 决定是否继续下一轮 decide 或进入 respond
- 更新 `runtime_state.resumeCursor`

#### 11.2.6 `degrade`（非终止，P0-4 新增）

职责：

- 接收 `decide` 中 LLM 调用重试全部耗尽后的降级信号
- 产出 `agent_degraded` SSE 事件（与 legacy runner 中 `agent_degraded` 事件语义一致）
- 向 graph state 的 `messages` 注入降级上下文消息：`[系统提示] 上一轮模型调用失败（{error}）。请基于已有信息继续尝试完成任务，或向用户说明当前情况。`
- 通过回环边路由回 `decide`，让 agent 在新的上下文中继续尝试（与 legacy `continue` 到下一轮 ReAct iteration 的行为一致）

关键约束：

- `degrade` **不是终止节点**。与 `fail` 严格区分：`fail` 是致命错误终止，`degrade` 是降级恢复
- 在同一个 iteration 中连续降级次数应记录到 graph state（`degradeCount`），超过阈值（如连续 3 次降级）则路由到 `fail`
- 降级消息的语言必须是中文

#### 11.2.7 `ask_user`

职责：

- 将 `ask_user` 决策写入 session runtime_state
- 通过现有 SSE 兼容逻辑输出用户可见问题
- 触发暂停，等待 `/api/agent/respond`

#### 11.2.8 `respond`

职责：

- 生成最终中文回复
- 对 leaked JSON / 非自然语言内容做防御清洗
- 输出兼容 legacy 的 `agent_responding` / `agent_token` / `agent_respond`

#### 11.2.9 `finalize`

职责：

- 持久化 assistant message
- 清空 `runtime_state.pendingInterrupt`
- 标记 session 完成
- 发出 `agent_done`

#### 11.2.10 `fail`

职责：

- 持久化错误状态到 session
- 发出 `agent_error`
- 终止 graph 执行

### 11.3 Cancel 传播设计（P0 补充）

`RunContext.signal`（AbortSignal）必须能穿越 LangGraph 的 `graph.astream()` 到达每个长时间运行的节点。

#### 11.3.1 传播路径

```text
ExecutionScope.context.signal
  → 包装到 graph config.configurable.signal
    → prepare_context 节点提取并存储到 graph state
      → 每个长时间运行的节点（decide、execute_tool）在关键操作前检查 state.signal.aborted
```

#### 11.3.2 具体实现

1. **入图**：`prepare_context` 接收 `config.configurable.signal`，存储到 graph state 的 `cancelSignal: AbortSignal | null` 字段
2. **节点检查**：`decide`（LLM 调用前）、`execute_tool`（工具执行前）、`observe`（处理前）检查 `state.cancelSignal?.aborted`
3. **检测到取消**：
   - `decide` 中：将当前 graph state 持久化（partial content），路由到 `finalize` 或 `fail`
   - `execute_tool` 中：**关键安全要求** —— 对于 `requireApproval` 的高风险工具，取消时不得执行工具，直接返回 `cancelledResult`；工具执行内部通过 `ToolRegistry.execute()` 透传的 `RunContext.signal` 自行处理
   - 其他节点中：快速路由到 `finalize`，保存 partial content

4. **中断后清理**：
   - 持久化 partial content 到 messages
   - 将 session status 设为 `failed`
   - 清空 `pendingInterrupt`

#### 11.3.3 与现有 ExecutionController 的关系

- `ExecutionController.shouldStop` 继续由 `AgentService` facade 在 graph 运行前后检查
- graph 运行中，cancel 通过 state.signal 到达节点
- graph 外层的 `AgentExecutor` 继续检查 `scope?.controller.shouldStop` —— 这与现有行为一致

### 11.4 respondOnly 双态切换建模（P0 补充）

当前 legacy runner 有一个隐式状态转换：首次 tool call 后切换到 `respondOnly` 模式（LLM 输出干净 Markdown，不使用 tool calling 格式）。这个转换必须在 graph 中显式化。

#### 11.4.1 Graph State 字段

在 `LangGraphRunnerState` 中新增：

```typescript
responseMode: "decision" | "respond_only";
```

#### 11.4.2 切换条件

- 初始值：`"decision"`（进入 decide 时正常使用 tools + agent_decide）
- 切换到 `"respond_only"`：
  - `observe` 节点中，若上一轮 decision 产生了 tool_call（无论是否经过 approval），且不是 native tool calling（是文本解析路径 `parsedFromText = true`）
  - 切换到 `"respond_only"` 后，后续 `decide` 节点使用 `getRespondOnlySystemPrompt()` 和 `undefined` tools

#### 11.4.3 Graph 节点行为差异

| responseMode | decide 使用的 system prompt | decide 使用的 tools | LLM 输出预期 |
|---|---|---|---|
| `"decision"` | `REACT_PROMPT_WITH_TOOLS` | `toolDefs` | 文本 ReAct JSON 或 agent_decide tool call |
| `"respond_only"` | `getRespondOnlySystemPrompt()` | `undefined` | 自然语言 Markdown（防泄漏 JSON） |

---

## 12. Graph 边与中断语义

### 12.1 完整 graph 边定义

```text
prepare_context
  -> decide

decide
  -> tool_call ? approval_gate
  -> respond ? respond
  -> ask_user ? ask_user
  -> LLM 重试耗尽 ? degrade

approval_gate
  -> approved ? execute_tool
  -> rejected ? observe（注入拒绝上下文后继续）
  -> pause ? [中断，等待 /api/agent/approve]

execute_tool
  -> successfully ? observe
  -> tool_error ? observe（错误信息作为 tool result）

observe
  -> more_work ? decide
  -> task_done ? respond
  -> max_iterations ? finalize

degrade
  -> [注入降级上下文到 graph state]
  -> degradeCount < threshold ? decide（回环）
  -> degradeCount >= threshold ? fail（降级耗尽，终止）

ask_user
  -> pause ? [中断，等待 /api/agent/respond]

respond
  -> finalize

finalize
  -> [持久化 assistant message，清空 pendingInterrupt，标记完成]

fail
  -> [持久化错误状态，终止]
```

### 12.2 关键边路由条件

图中存在四类关键中断和一类回环：

1. **用户手动停止**
   - 由 `ExecutionScope.context.signal` 驱动（见 11.4 cancel 传播设计）
2. **审批暂停**
   - 由 `approval_gate` 触发，并写入 durable runtime_state
3. **ask_user 暂停**
   - 由 `ask_user` 触发，并写入 durable runtime_state
4. **LLM 降级回环**（非终止）
   - 由 `degrade` 触发，注入降级上下文后回环到 `decide`
   - 连续降级 3 次后路由到 `fail` 终止

### 12.3 重要约束：Phase 2 之前不得上线可中断 session

Architecture Review 明确指出：如果 Phase 2 只替换 happy path，而把 `resume/approval` 留到后续，会形成”半旧半新”的 paused session。

因此本方案新增硬约束：

> **在 LangGraph runner 完整覆盖 `run + resume + handleApproval + ask_user + interrupt` 之前，不允许任何会产生 pause/approval 的 session 进入 langgraph engine。**

换句话说：

- Phase 2 是 parity 实现阶段，不是对外放量阶段
- 若要早期实验，只能在测试环境或明确禁止中断路径的隔离场景下进行

---

## 13. Adapter 设计

## 13.1 Tool Adapter（硬约束）

目标：让 graph 节点能以统一方式调工具，但不削弱现有 ToolRegistry 的治理能力。

建议接口：

```typescript
interface GraphToolAdapter {
  listTools(enabledTools?: string[]): GraphTool[];
  execute(
    name: string,
    args: Record<string, unknown>,
    context: RunContext,
  ): Promise<ExecutionResult>;
}
```

**硬约束：**

1. `ToolDefinition` 仍来自 `ToolRegistry.getDefinitions()`
2. tool description 继续中文化
3. `context.signal` 必须直达工具执行层
4. 适配器只做 schema / bridge，不做真实执行业务
5. 真正执行只能委托 `toolRegistry.execute()`

**完整调用链：**

```text
Graph execute_tool 节点
  → GraphToolAdapter.execute(name, args, context)
    → executeToolWithRetry(name, args, history, sessionId, step, context)
      → toolRegistry.execute(name, args, context)
        → RegisteredTool.execute(args, context)
        ← ExecutionResult (success / failed / cancelled / timeout / partial)
      ← ExecutionResult（含重试次数、退避日志）
    ← ExecutionResult
  ← 将 ExecutionResult 写入 graph state.lastToolResult
```

此调用链保证所有现有治理能力不丢失：

| 能力 | 保证机制 |
|---|---|
| 超时控制 | `ToolRegistry.executeWithTimeout()` — 工具执行 30s 超时 + AbortSignal |
| 取消传播 | `RunContext.signal` 通过 `context` 参数透传到 `ToolRegistry.execute()` |
| 熔断器 | `ToolRegistry.circuitBreaker` — 连续 5 次失败自动打开，60s cooldown |
| 重试 | `executeToolWithRetry()` — 可重试错误指数退避，最多 3 次 |
| 指标埋点 | `ToolRegistry.execute()` 内嵌 `toolCallsTotal` + `toolExecutionDurationMs` |
| 审批门控 | `approval_gate` 节点在 `execute_tool` 之前，通过 `RegisteredTool.requireApproval` 判断 |
| 安全守卫 | `AgentGuardService.guardToolCall()` 在 `approval_gate` 通过后、`execute_tool` 前检查（token 预算、成本上限） |

**严禁绕过**：
- GraphToolAdapter 不得直接 `import { someTool } from "../tools/business/..."` 并调用业务函数
- 不得在 adapter 内部 new 工具实例跳过 ToolRegistry
- Code review 必须验证 true execution 的 call site 只有 `toolRegistry.execute()`

## 13.2 Prompt / Message Adapter

职责：

- graph decide prompt 模板化
- respond prompt 模板化
- scratchpad / tool result / history 注入标准化

## 13.3 Provider Call Adapter

由于当前仓库已有自定义 `LLMProvider` 抽象：

- `streamChat()`
- `chatSync()`

因此第一阶段**不建议**引入 `@langchain/openai` 等 provider package 替换现有 provider abstraction。

建议做法：

- LangGraph node 内仍调用当前 provider abstraction
- LangChain 主要用于 Tool / Prompt / structured output 组织
- 未来若要迁 provider 层，再单独出 RFC

## 13.4 SSE Event Adapter / Mapper

Graph 输出不得直接暴露给前端，必须统一映射回当前协议：

- `AgentStreamEvent`
- `RouteStreamEvent`

重点不是“类型名兼容”，而是**事件顺序与补偿语义兼容**，见第 14 节。

---

## 14. SSE / Runtime Contract Parity（修订重点）

### 14.1 为什么只保留事件类型名还不够

前后端依赖的不只是事件集合，还依赖事件**顺序**与**补偿语义**。当前系统至少依赖以下行为：

- `meta -> token -> done`
- `agent_clear_stream` 用于清除 JSON / 中间态输出
- `agent_ask_user` 在 Runtime 层被兼容映射为 `clear_stream + token`
- 中断场景下部分输出补偿与 fallback
- `done` 上的 citation / validation payload

因此 parity 的定义必须是：

> **legacy runner 与 langgraph runner 在关键场景下产生等价的 AgentStreamEvent / RouteStreamEvent 顺序语义，而不是仅仅字段 shape 相似。**

### 14.2 迁移门槛

Phase 0 起就必须复用并扩展现有 runtime contract tests：

- `apps/server/src/__tests__/runtime-contract.test.ts`

新增 parity case 至少覆盖：

1. 正常流式路径
2. 无 `agent_responding` 的补偿输出路径
3. `agent_error` 后的 post-processing fallback
4. `ask_user -> clear_stream + token` 兼容路径
5. interruption 时部分内容持久化与补偿输出
6. citation payload 透传
7. tool call -> observe -> respond 顺序
8. approval pause -> approve -> continue 顺序
9. ask_user pause -> respond -> continue 顺序

### 14.3 通过标准

在任一调用方开启 langgraph runner 之前，必须满足：

- legacy / langgraph 双引擎 parity test 通过（AgentStreamEvent 层 + AgentExecutor 集成层）
- RouteStreamEvent 顺序一致性通过
- `AgentExecutor` 外层无需特殊分支适配 langgraph

### 14.4 Parity Test 设计方法（P0-6 新增）

以下内容已在 `docs/design/parity-test-design.md` 中详细定义（Phase 0.3 产出），核心决策摘录如下：

#### 14.4.1 Mock 策略

| 测试类别 | LLM 是否 Mock | 原因 |
|---|---|---|
| Decision parity（决策路由是否正确） | **Mock LLM** | 需要确定性输入验证 `decide → tool_call/respond/ask_user` 路由逻辑 |
| Tool routing parity（工具选择正确性） | **Mock LLM** | 需要确定性输入验证工具名、参数传递 |
| Event sequence parity（事件类型序列） | **Mock LLM** | 需要相同 LLM 输出下比较两个 runner 的事件序列 |
| End-to-end smoke（完整流程） | **真实 LLM** | 验证真实模型行为下的端到端兼容性，不作为门禁 |
| Interrupt recovery（中断恢复正确性） | **Mock LLM** | 需要确定性控制中断时机和恢复输入 |

**Mock LLM 实现**：构造一个 `TestLLMAdapter`，注入到 runner 的 provider 参数中，使其返回预设的 token stream + tool call 序列。

#### 14.4.2 对比粒度

Parity 测试分两个对比层：

**Layer 1：AgentStreamEvent 序列对比（AgentService 输出层）**

- 对比项目：事件类型序列（如 `meta → think → act → clear_stream → observe → think → ... → respond → done`）
- 关键 payload 字段值匹配（`finalContent`、`decision.tool`、`step.result` 等）
- **不对比**：`timestamp`、`message_id`（UUID 随机）、具体 token 拆分粒度

**Layer 2：RouteStreamEvent 序列对比（AgentExecutor 集成层）**

- 输入：相同的 mock `AgentService.run()` 生成器（分别用 legacy 和 langgraph runner 构造）
- 输出：比较两个 runner 经过 `AgentExecutor.execute()` 后产出的 `RouteStreamEvent` 序列
- 验证：`meta → token* → done` 的顺序、citation payload、fallback 补偿路径

#### 14.4.3 序列对比算法

```typescript
function compareEventSequences(
  legacyEvents: AgentStreamEvent[],
  langgraphEvents: AgentStreamEvent[],
): ParityResult {
  // Step 1: 按 key 提取事件类型序列
  const legacyTypes = legacyEvents.map(e => e.type);
  const graphTypes = langgraphEvents.map(e => e.type);

  // Step 2: 比较事件类型序列
  const typeDiff = diffSequences(legacyTypes, graphTypes);

  // Step 3: 对匹配的事件，比较 payload 关键字段
  const payloadDiffs = comparePayloads(
    legacyEvents, langgraphEvents,
    KEY_FIELDS_WHITELIST  // ['step', 'tool', 'content', 'action', ...]
  );

  return { typeDiff, payloadDiffs, passed: typeDiff.length === 0 && payloadDiffs.length === 0 };
}
```

#### 14.4.4 时间不敏感字段白名单

以下字段在两个 runner 间比较时被视为时间不敏感（允许差异）：

- `message_id`：UUID 随机生成
- `session_id`：UUID 随机生成（但同一个测试 case 中两个 runner 应可传入相同 session_id）
- `approval_id`：UUID 随机生成
- `timestamp`：时间戳自然不同
- `usage.total_tokens`：允许 ±5% 差异（prompt 构建有微小差异）
- `content` 中单个 token 的拆分粒度：两个 runner 可能在 chunk 边界上使用不同的 tokenizer，因此 **仅对比累积 content 的最终结果**，不对比每个 `agent_token` event 的边界

#### 14.4.5 AgentExecutor 集成测试维度（P0-7 新增）

Phase 2 的 parity 测试矩阵必须增加 **Layer 2 集成测试**（不仅是 AgentService 层面的 `AgentStreamEvent` 对比）：

```typescript
/**
 * AgentExecutor 集成 parity 测试工具。
 * 输入: mock AgentService.run() 生成器（legacy 或 langgraph）
 * 输出: 两个 runner 的 RouteStreamEvent 序列对比结果
 */
async function testAgentExecutorParity(
  task: string,
  mockLLM: TestLLMAdapter,
): Promise<{
  legacyRouteEvents: RouteStreamEvent[];
  graphRouteEvents: RouteStreamEvent[];
  diff: ParityDiff;
}> {
  // 1. 用 mock LLM 构造 legacy runner 的 AgentService.run()
  const legacyService = new AgentService();
  const legacyRunner = new LegacyAgentRunner(legacyService);
  const legacyEvents = collectEvents(legacyRunner.run(conversationId, task, { ... }));

  // 2. 用相同 mock LLM 构造 langgraph runner 的 AgentService.run()
  const graphRunner = new LangGraphAgentRunner(/* injected checkpointer, adapter, mockProvider */);
  const graphEvents = collectEvents(graphRunner.run(conversationId, task, { ... }));

  // 3. 分别通过 AgentExecutor 映射
  const legacyRoute = collectEvents(agentExecutorExecute(legacyEvents));
  const graphRoute = collectEvents(agentExecutorExecute(graphEvents));

  // 4. 比较 RouteStreamEvent 序列
  return { legacyRouteEvents: legacyRoute, graphRouteEvents: graphRoute, diff: compare(legacyRoute, graphRoute) };
}
```

覆盖场景：
- `meta → token* → done` 正常流式路径
- `clear_stream` 补偿路径（Leaked JSON 清洗）
- `agent_error → fallback token stream → done` 错误降级路径
- `agent_ask_user → clear_stream + token*` 兼容映射路径
- Interruption 时的 partial content 持久化 + `done` 路径

---

## 15. Prompt 策略

### 15.1 Prompt 收敛原则

当前 Prompt 分散在：

- `packages/shared-prompts/src/index.ts`
- `apps/server/src/services/agent/prompts.ts`

本次建议：

1. 保留 legacy Prompt 作为对照基线
2. 新增 runner / graph 专用 Prompt 模块
3. 逐步将 LLM-facing 字符串收敛到 shared prompt 包或明确的 adapter 模块

### 15.2 中文 Prompt 作为硬约束

所有新增内容必须中文，包括：

- decide prompt
- respond prompt
- ask_user clarification template
- approval explainers
- tool descriptions（如有调整）
- structured output field 描述
- fallback 注入给模型的系统提示

### 15.3 审计要求

Phase 0 必须做一次 LLM-facing 文本审计，修复现存英文项，并将中文化列入 review checklist。

---

## 16. 持久化与数据模型策略

### 16.1 继续复用现有事实源

当前数据库已存在：

- `AgentSession`
- `AgentApproval`
- `messages`

本方案不新增第二事实源，继续沿用，但允许对 `AgentSession` 做**最小增量扩展**来保存 runner 元数据与 resumable state。

### 16.2 最小增量 schema 方向

建议在 `AgentSession` 上增加以下能力（设计层面）：

- `engine` 或 `runtime_state.engine`
- `runtime_state` JSON
- `runtime_state_version`

目标：

- 能识别 session 属于 legacy 还是 langgraph
- 能 durable 恢复 graph continuation
- 能 crash-safe 地恢复 ask_user / approval / interrupt 场景

### 16.3 与现有 Workflow Engine 的边界

现有 `apps/server/src/workflows/*` 已自带：

- workflow schema
- DAG executor
- checkpoint
- human approval step

本期明确边界：

- **不把 Agent LangGraph 与 Workflow Engine 合并**
- **不借由本次重构顺手改 Workflow checkpoint 模型**
- Workflow 只是 AgentService 的一个调用方，不是本方案的内核改造对象

---

## 17. 依赖策略

### 17.1 推荐新增依赖

仅建议在 `@agentforge/server` 中新增：

- `@langchain/core`
- `@langchain/langgraph`

### 17.2 第一阶段不建议新增的依赖

第一阶段不建议直接引入：

- `@langchain/openai`
- `@langchain/community`
- provider-specific integration packages

原因：

- 当前已有自定义 `LLMProvider` 抽象
- 直接替换 provider 会扩大重构半径
- 与“最小改动”原则不符

### 17.3 类型安全要求

若 LangChain / LangGraph 带来外部输出对象，必须按项目规范做边界校验：

- tool results
- structured outputs
- graph state serialization
- any SDK metadata objects

---

## 18. 测试与可观测性要求

### 18.1 Contract Tests（必须补齐）

在 feature flag 切换前，需要补齐 contract tests，验证 legacy 与 graph 引擎输出兼容：

1. AgentStreamEvent 顺序 parity
2. RouteStreamEvent 顺序 parity
3. interrupt 时部分输出持久化语义兼容
4. approval gate 触发与恢复兼容
5. ask_user 触发与恢复兼容
6. tool error / degrade 语义兼容
7. citation / validation done payload 兼容
8. session engine stickiness 兼容
9. progress crash recovery 兼容

### 18.2 指标对比

至少对比：

- TTFT
- TTLT
- tool call success/error rate
- approval pending -> resume success rate
- fallback rate
- interrupt success rate
- session recovery success rate

### 18.3 日志要求

新增 runner 后，日志要可回答：

- 当前 session 绑定了哪个 engine
- 当前在哪个 node / phase
- 上一步决策是什么
- 为什么暂停
- 为什么恢复
- 当前恢复用了哪份 checkpoint
- 为什么 fallback

---

## 19. 分阶段迁移路径（重写）

## Phase 0：契约固化与基线审计

**目标**：先把”什么不能变”定义清楚。

工作内容：

1. 冻结对外兼容面：
   - `/api/agent/chat`
   - `/api/agent/run`
   - `/api/agent/respond`
   - `/api/agent/approve`
   - `AgentStreamEvent`
   - `RouteStreamEvent`
2. 盘点 `AgentService` 所有调用方（`AgentExecutor`、`routes/agent.ts`、`workflows/handlers/`、`teams/modes/*`）
3. 完成 LLM-facing 中文文本审计（扫描 `prompts.ts`、`shared-prompts` 中所有注入给模型的字符串，确保无英文漏网）
4. 设计 Parity Test 方法论文档（`docs/design/parity-test-design.md`），明确：
   - Mock 策略（哪些 case mock LLM，哪些用真实 LLM）
   - 对比粒度（Layer 1 AgentStreamEvent 序列 + Layer 2 AgentExecutor 集成 RouteStreamEvent 序列）
   - 序列对比算法
   - 时间不敏感字段白名单
5. 补齐 baseline contract tests（`apps/server/src/services/__tests__/agent-runner-contract.test.ts`），覆盖：
   - 正常流式路径（tools → observe → respond → done）
   - approval pause → approve → resume → done
   - ask_user pause → respond → resume → done
   - error → fallback → done
   - interrupt → partial content → done
   - citation payload 透传
6. 设计 `runtime_state` 字段的 Prisma schema migration
7. 设计 `PrismaCheckpointer` 实现方案（含 `CheckpointAdapter` 接口定义）

**交付标准**：

- 不切实际流量
- legacy 行为不变
- 有完整的 parity 基线测试（至少覆盖 AgentStreamEvent 层的 9 个 case）
- 有明确的 `docs/design/parity-test-design.md`
- 有经代码审计确认的中文 prompt 合规报告
- `AgentSession.runtime_state` 字段设计与 Prisma migration 已经过 review

## Phase 1：Facade + Selector + Sticky Session 骨架

**目标**：先改结构，不改行为。

工作内容：

1. `AgentService` 重构为 facade
2. 下沉当前实现为 `LegacyAgentRunner`
3. 新增 `RunnerSelector`
4. 持久化 session engine stickiness
5. 搭好 durable runtime_state 存储抽象
6. 新增 LangChain adapter skeleton

**交付标准**：

- 所有调用方默认仍走 legacy
- `run / resume / handleApproval` 对外行为不变
- Session 创建后可读到固定 engine 元数据

## Phase 2：LangGraph Runner 完整 parity 实现

**目标**：先做到完整 parity，再谈外部灰度。

工作内容：

1. 实现 `LangGraphAgentRunner`
2. 覆盖完整语义：
   - `run()`
   - `resume()`
   - `handleApproval()`
   - `ask_user`
   - `interrupt`
   - `degrade`
3. graph 工具执行全部走 `ToolRegistry.execute()`
4. graph 恢复全部依赖 durable runtime_state + 现有事实源

**交付标准**：

- parity tests 通过
- pause / resume / approval 不依赖进程内存
- 仍不默认对外放量

**硬限制：**

- 在本阶段结束前，不允许对任何可能 pause / approval 的真实会话启用 langgraph engine

## Phase 3：按调用方灰度 rollout

**目标**：控制 blast radius，而不是一次切全局。

推荐顺序：

### Phase 3A：`/api/agent/run/respond/approve`

原因：

- 最直接观察 `AgentStreamEvent`
- 不额外叠加 `AgentExecutor` 外层后处理复杂度

### Phase 3B：`AgentRuntimeService -> AgentExecutor` 的 TASK 路径

原因：

- 验证 citation / validation / RouteStreamEvent mapper 在 graph runner 下保持稳定

### Phase 3C：`workflow agent-step`

原因：

- Workflow 已有自己的一层 orchestrator，需最后验证

### Phase 3D：`teams/modes/*`

原因：

- Team 协作模式对 Agent 行为最敏感，应最后迁移或单独立项

**交付标准**：

- 每个调用方都可独立启停 langgraph
- 任一调用方出现问题都可单独回滚到 legacy

## Phase 4：选择性扩展

**目标**：在 parity 已证明成立后，再谈收益扩展。

候选范围：

- Prompt 收敛
- RAG 子链优化
- planner / research 子图

**注意：**

- Workflow Engine 与 Multi-Agent 是否迁入 LangGraph，不在本阶段内
- parity 未完成前，不得提前做这些扩展

---

## 20. 风险与回滚策略

### 20.1 主要风险

#### R1. Durable state 设计不清，导致跨请求恢复失败 ✅ 已解决

控制（v1.2 已落实）：

- §10.3 已定义 PrismaCheckpointer + CheckpointAdapter 架构
- §10.7 已定义 checkpoint 版本兼容性策略
- §10.5 已定义 runtime_state 与现有 status/scratchpad 的权威性边界
- Phase 2 前不允许放量 pause-capable session

#### R2. SSE 行为回归

控制：

- parity 测试要覆盖顺序与补偿语义，不只看 shape

#### R3. Tool 治理能力被绕过

控制：

- LangChain Tool adapter = schema adapter only
- 真正执行必须委托 `toolRegistry.execute()`

#### R4. 影响范围失控

控制：

- Runner rollout 必须按调用方维度
- Workflow / Teams 默认 legacy，最后迁移

#### R5. Prompt 中文规则被破坏

控制：

- 中文 prompt 作为硬 guardrail
- Phase 0 做审计，review checklist 强制检查

### 20.2 回滚策略

必须具备以下开关：

1. 调用方级 engine flag
2. 会话级 engine stickiness
3. `AgentService` facade 保留 legacy 分支
4. 关键 contract tests 常驻 CI

回滚原则：

- 已暂停 session 必须回到创建它的 engine
- 新请求可按调用方开关回退
- 不通过“改环境变量覆盖旧 session”来强制切换 engine

---

## 21. 推荐目录 / 文件改造草案（修订）

```text
apps/server/src/services/agent/
  index.ts                       # AgentService facade
  runner/
    types.ts
    legacy-agent-runner.ts
    langgraph-agent-runner.ts
    runner-selector.ts
    session-engine-state.ts      # engine stickiness + runtime_state 读写
    checkpoint-adapter.ts        # CheckpointAdapter 接口 + PrismaCheckpointer 实现
  langchain/
    prompt-adapter.ts
    message-adapter.ts
    tool-adapter.ts              # GraphToolAdapter（调用链：→ executeToolWithRetry → toolRegistry.execute）
    structured-output.ts
    event-adapter.ts

apps/server/src/services/agent-runtime/
  agent-executor.ts              # 保留 facade，继续做 TASK 后处理
  types.ts                       # 保持 RouteStreamEvent 契约稳定

packages/shared-prompts/src/
  agent-runtime/
    langgraph-runner-prompts.ts  # graph / runner 专用中文 prompts

apps/server/src/services/__tests__/
  agent-runner-contract.test.ts  # Phase 0: baseline contract tests
  agent-runner-parity.test.ts    # Phase 2: legacy vs langgraph parity (Layer 1 + Layer 2)

docs/design/
  parity-test-design.md          # Phase 0 产出：Parity 测试方法论
```

> 关键修正：Runner 目录放在 `services/agent/` 下，而不是 `agent-runtime/task-graph/` 下，因为真实替换点是 `AgentService`，且它有多个调用方。

---

## 22. 实施守则（Guardrails）

1. **AgentRuntimeService / QueryRouter / AgentExecutor 外壳不动**
2. **AgentService 对外方法签名不变，只改内部 runner**
3. **只使用 low-level StateGraph，不使用 prebuilt 黑盒 agent**
4. **LangChain Tool adapter 只做桥接，不做真实执行**
5. **真正工具执行必须走 `ToolRegistry.execute()`（调用链：GraphToolAdapter → executeToolWithRetry → toolRegistry.execute）**
6. **灰度必须按调用方进行，不能一次切全局**
7. **已创建 session 必须 engine sticky，resume/approve 不得漂移 engine**
8. **durable graph state 必须通过 PrismaCheckpointer + CheckpointAdapter 保存到 agent_sessions.runtime_state**
9. **所有新增 LLM-facing 文本必须是中文**
10. **SSE contract parity 必须在 rollout 前通过（Layer 1 AgentStreamEvent + Layer 2 AgentExecutor RouteStreamEvent）**
11. **Workflow / Teams / Video 不在首轮迁移范围内**
12. **任何阶段如发现边界扩大，必须暂停并补充设计审查**
13. **status 字段是 session 生命周期的决定性权威来源，runtime_state 是辅助恢复数据；不一致时以 status 为准**
14. **graph checkpoint 版本不匹配时，paused session 降级到 legacy engine 完成恢复，不抛异常**
15. **degrade 节点是非终止回环节点，fail 是终止节点；两者不可混淆**
16. **cancel signal（AbortSignal）必须通过 graph state 传播到每个长时间运行节点**
17. **respondOnly 双态切换通过 graph state.responseMode 显式管理，不在节点中隐式判断**

---

## 23. 最终建议

### 23.1 是否值得做

**值得做，但只值得做“混合重构”，不值得做“全量重写”。**

原因：

- 当前 Agent Runtime 外壳已经成熟
- 真正需要改善的是 Agent 内核状态编排与跨请求恢复模型
- LangGraph 对这一层有明确收益
- LangChain 适合作为 adapter 层，不适合作为顶层替代品

### 23.2 推荐结论

最终建议为：

> **保留 AgentForge Runtime 外壳，重构 `AgentService` 为 facade + dual-runner 迁移结构；使用 LangGraph 替换其内部 ReAct 状态机，使用 LangChain 建立 Tool / Prompt / Structured Output 适配层；通过会话级 engine stickiness、durable runtime_state、调用方级灰度 rollout，实现可恢复、可回滚、协议兼容的渐进迁移。**

这是当前仓库约束下收益最高、风险最低、可持续迭代的路线。

---

## 24. 后续产物（Phase 0 执行）

以下产物按 Phase 0 顺序产出：

1. ~~Re-Review 审查结论~~ → **已完成**：v1.2 修订解决了全部 7 个 P0 阻塞问题
2. `docs/design/parity-test-design.md` —— Parity 测试方法论文档（含 mock 策略、对比粒度、序列对比算法）
3. `agent_sessions.runtime_state` Prisma migration 脚本
4. Phase 0 任务拆解清单
5. rollout checklist（按调用方，模板待 Phase 3 填充）

> v1.2 方案已完成设计层面的所有 P0 修复，可以进入 Phase 0 编码执行。
