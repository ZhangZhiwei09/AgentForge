# Diagnosis Service 改进方案：从"用 LangGraph 实现规则引擎"到"Agent Runtime 的 LangGraph 下游用例"

> 日期: 2026-07-05 | 作者: Claude (Agent Interviewer)
> 背景: 对已落地的 Diagnosis Service 和规划中的 Runtime 迁移做了交叉审查，发现架构判断偏差
>
> **⚠️ 状态更新（2026-08）**: Phase B 建议已实现 — DIAGNOSIS 现在是 Agent Runtime 的第 5 条路由。LangGraph 已按 ADR-001 从 TS Server 移除，Phase C（Runtime ReAct Loop 的 LangGraph 迁移）不再适用。Phase A 加固项待确认。

---

## 1. 问题诊断

### 1.1 核心偏差

当前 Diagnosis Service 用 LangGraph 的 `StateGraph` 实现了一个**纯规则流水线**：

- 零 LLM 调用（意图分类、实体提取、诊断生成全是正则 + 模板）
- 无循环、无中断/恢复、无人在回路
- `invoke()` 一次性同步跑完
- `createGraph()` 每次请求新建图

LangGraph 的核心价值（LLM 编排、checkpoint/恢复、Human-in-the-Loop）一个都没用上。这个图本质上是 5 个 async 函数 + 2 个 if-else。

### 1.2 优先级倒挂

```
已完成: Diagnosis Service（边缘用例，独立端点）
未完成: Agent Runtime ReAct loop 迁移（核心基础设施，所有 Agent 的底盘）
```

`langchain-langgraph-refactor-plan.md` v1.2 已通过两轮 Architecture Review，但 Phase 2 的 `PrismaCheckpointer` 和 `LangGraphAgentRunner` 仍然是骨架。Diagnosis Service 作为 LangGraph 的下游用例，本应在 Runtime 迁移完成后自然受益于统一的 checkpoint/streaming/工具调用基础设施——现在反过来了。

### 1.3 与架构约束的冲突

项目 CLAUDE.md 明确要求：

> 新增能力必须复用现有 Runtime，禁止绕过 Agent Runtime 创建平行执行链路

Diagnosis Service 以独立端点 `POST /api/diagnosis/query` 暴露，不经过 `AgentRuntimeService` → `QueryRouter` → `AgentExecutor` 的主链路。这在 MVP 阶段可以接受，但不能成为长期模式。

---

## 2. 改进方案

### Phase A：Diagnosis Service 加固（本周，不改变架构）

在不改变图结构的前提下，修复已经识别出的工程问题。

#### A1. 图复用

图结构是静态的，应在构造时创建一次：

```typescript
export class DiagnosisService {
  private readonly graph: ReturnType<typeof this.createGraph>;

  constructor(deps: DiagnosisServiceDeps = {}) {
    this.knowledgeRetriever = deps.knowledgeRetriever ?? new KnowledgeService();
    this.monitoringTools = deps.monitoringTools ?? new MockDiagnosisMonitoringTools();
    this.graph = this.createGraph();  // 构造时创建，不在 run() 里创建
  }

  async run(input: RunDiagnosisInput): Promise<DiagnosisResponse> {
    const state = await this.graph.invoke(createInitialDiagnosisState(input));
    // ...
  }
}
```

#### A2. 异步节点错误处理

`retrieve_knowledge` 和 `query_monitoring` 是仅有的两个异步节点，且都没有 try-catch。增加降级逻辑：

```typescript
export function createRetrieveKnowledgeNode(deps: DiagnosisNodeDeps) {
  return async function retrieveKnowledgeNode(state: DiagnosisState): Promise<Partial<DiagnosisState>> {
    try {
      const docs = await deps.knowledgeRetriever.searchHybrid({
        query: buildKnowledgeQuery(state),
        kbIds: state.kbIds,
        topK: 5,
        useReranker: true,
      });
      return { retrievedDocs: docs.map(mapKnowledgeEvidence) };
    } catch (error) {
      logger.error({ error, query: state.query }, "Knowledge retrieval failed");
      return {
        retrievedDocs: [],
        warnings: [...state.warnings, "知识库检索失败，诊断仅基于结构化信息和监控结果。"],
      };
    }
  };
}
```

`query_monitoring` 同理——单个工具调用失败不应阻断整个诊断，应返回部分结果 + warning。

#### A3. 流式输出

将 `invoke()` 改为 `stream()`，让调用方看到节点级进度：

```typescript
async *runStream(input: RunDiagnosisInput): AsyncGenerator<DiagnosisStreamEvent> {
  const state = createInitialDiagnosisState(input);
  for await (const chunk of await this.graph.stream(state)) {
    yield {
      type: "node_complete",
      node: Object.keys(chunk)[0],
      partial: chunk,
    };
  }
  // 最后 yield 完整 DiagnosisResponse
}
```

同时保留 `run()` 作为非流式便捷方法。

#### A4. Mock 数据注册机制

替换硬编码的 `mockTraceLogs` / `mockMerchantMetrics`，改用 `Map` + 注册接口：

```typescript
class MockDiagnosisMonitoringTools implements DiagnosisMonitoringTools {
  private traces = new Map<string, TraceLog>();
  private metrics = new Map<string, MerchantMetrics>();

  registerTrace(traceId: string, data: TraceLog): this { ... }
  registerMetrics(merchantId: string, data: MerchantMetrics): this { ... }

  async execute(call: DiagnosisToolCall): Promise<DiagnosisToolResult> {
    // 从 Map 查找，fallback 到 default
  }
}
```

这样测试可以注册任意数据，而不是依赖两个 magic string。

### Phase B：诊断能力接入 Agent Runtime（1-2 周）

这是关键的战略修正——让 Diagnosis Service 不再是平行链路，而是 Agent Runtime 的一个下游消费者。

#### B1. 将诊断意图注册为 TASK 路由的子类型

当前 4-route 分类器输出 SAFETY / CHAT / TASK / HUMAN。在 TASK 下新增 `diagnosis` 子类型：

```
用户请求 → AgentRuntimeService → QueryRouter → TASK
  → AgentExecutor → AgentService.run()
    → 如果子类型是 diagnosis → DiagnosisGraphRunner（LangGraph）
    → 否则 → Legacy ReAct loop
```

#### B2. 将 DiagnosisService 重构为 DiagnosisGraphRunner

`DiagnosisGraphRunner` 实现 `AgentRunner` 接口（`runner/types.ts`），复用 Runtime 的：

- SSE 流式管道（`RouteStreamEvent`）
- `ExecutionScope` / `ExecutionController`（超时、取消）
- `ToolRegistry`（而非直接持有 `DiagnosisMonitoringTools`）
- Session 管理和 checkpoint 持久化

```typescript
export class DiagnosisGraphRunner implements AgentRunner {
  constructor(
    private readonly knowledgeRetriever: DiagnosisKnowledgeRetriever,
    private readonly checkpointer: CheckpointAdapter,
  ) {}

  async *run(conversationId: string, task: string, options?: AgentRunOptions) {
    // 用 LangGraph 图执行诊断，但通过 Runtime 管道输出
  }
}
```

#### B3. 统一 Checkpoint 基础设施

Diagnosis 的图状态应使用和 Runtime ReAct loop 相同的 `CheckpointAdapter` → `agent_sessions.runtime_state` 持久化路径。这样：

- 诊断流程可以暂停反问用户、等待补充信息后恢复（多轮）
- Session stickiness 自动生效
- 不需要单独的 session 管理逻辑

### Phase C：Runtime ReAct Loop 迁移（与 Phase B 并行或紧随其后）

这才是 LangGraph 真正的用武之地。按 `langchain-langgraph-refactor-plan.md` 的 Phase 2-4 推进：

1. **Phase 2**：实现 `PrismaCheckpointer`，完成 `LangGraphAgentRunner`（ReAct + approval + interrupt + degrade）
2. **Phase 3**：按调用方灰度 rollout（先 workflow-agent-step，再 agent/run，最后 agent/chat）
3. **Phase 4**：SSE parity 测试通过后，逐步 deprecate legacy runner

---

## 3. 优先级矩阵

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | A1 图复用 + A2 错误处理 | 生产就绪的基本要求，改动极小 |
| P1 | B1 接入 Runtime 主链路 | 消除平行执行链路，遵守架构约束 |
| P1 | Phase C Phase 2（PrismaCheckpointer + LangGraphAgentRunner） | LangGraph 真正产生价值的落点 |
| P2 | A3 流式输出 | 用户体验提升，但不阻塞功能 |
| P2 | A4 Mock 注册机制 | 提升测试灵活性 |
| P2 | B3 统一 Checkpoint | 多轮诊断能力 |
| P3 | B2 完整 AgentRunner 适配 | 长期架构一致性 |

---

## 4. 不做的事

- **不在 Diagnosis Service 里强行加 LLM 节点**：当前规则引擎对 MVP 场景够用。LLM 推理应该在 Runtime ReAct loop 迁移完成后，作为 Tool/Planner 层的能力被图调用，而非在 diagnosis 图里内嵌 LLM 调用。
- **不新建第二个 LangGraph 使用范式**：DiagnosisGraphRunner 和未来的 LangGraphAgentRunner 应共享 checkpoint 格式、streaming 映射、tool 适配层。
- **不推翻 Diagnosis Service 重写**：当前代码质量不差，问题是定位偏差而非实现错误。修正调用链路和基础设施共享即可。

---

## 5. 验证标准

- [ ] `DiagnosisService` 构造函数中创建图，`run()` 不再调用 `createGraph()`
- [ ] 知识库检索失败时，返回部分诊断 + warning，而非 500
- [ ] 监控工具调用失败时，返回部分诊断 + warning，而非 500
- [ ] Diagnosis 请求经过 `AgentRuntimeService` 主链路（而非独立端点直接调用）
- [ ] `PrismaCheckpointer.get/put/delete/list` 有实现，不再是 `throw new Error("not implemented")`
- [ ] Runtime ReAct loop 的 LangGraph 图中至少有一个 LLM 推理节点在工作
