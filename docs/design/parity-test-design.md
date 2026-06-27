# Agent Runner Parity Test 设计方法

> 版本: v1.0 | 日期: 2026-06-27 | 来源: langchain-langgraph-refactor-plan.md §14.4

## 1. 目标

定义 legacy runner 与 langgraph runner 的 SSE 事件输出如何被确定性对比，使 Phase 2 的 "parity tests 通过" 交付标准可被客观判定。

## 2. Mock 策略

### 2.1 策略矩阵

| 测试类别 | LLM 是否 Mock | 原因 |
|---|---|---|
| Decision parity（决策路由正确性） | **Mock LLM** | 需要确定性输入验证 `decide → tool_call/respond/ask_user/degrade` 路由 |
| Tool routing parity（工具选择正确性） | **Mock LLM** | 需要确定性输入验证工具名、参数传递路径 |
| Event sequence parity（事件类型序列） | **Mock LLM** | 需要相同 LLM 输出下比较两个 runner 的事件序列 |
| End-to-end smoke（完整流程） | **真实 LLM** | 验证真实模型行为下的端到端兼容性，**不作为门禁** |
| Interrupt recovery（中断恢复正确性） | **Mock LLM** | 需要确定性控制中断时机和恢复输入 |
| Cancel propagation（取消传播） | **Mock LLM** | 需要模拟 AbortSignal 在特定 node 触发 |

### 2.2 Mock LLM 实现

构造 `TestLLMAdapter`，使其返回预设的 token stream + tool call 序列：

```typescript
interface MockLLMConfig {
  /** 模拟的 token 流（逐块产出） */
  tokens: string[];
  /** 模拟的 tool call（在某个 chunk 之后触发） */
  toolCalls?: Array<{
    name: string;
    arguments: string; // JSON string
    triggerAfterTokenIndex: number;
  }>;
  /** 模拟 LLM 完成后的 usage 信息 */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 模拟错误（在某个 chunk 之后抛出） */
  error?: { afterTokenIndex: number; message: string; category: "fatal" | "retryable" | "degradable" };
}

class TestLLMAdapter implements LLMProvider {
  async *streamChat(messages, model, systemPrompt, temperature, maxTokens, tools, signal) {
    // 按 config 产出预设的 token stream 和 tool call
  }
}
```

### 2.3 关键 Mock 场景预设

```typescript
// 场景 1: 正常 tool_call → observe → respond
const NORMAL_TOOL_RESPOND: MockLLMConfig = {
  tokens: ['{"decision":', '{"action":', '"tool_call",', '"tool":', '"search_knowledge_base"'],
  toolCalls: [{ name: "agent_decide", arguments: JSON.stringify({
    observation: "用户询问产品价格",
    analysis: "需要查询知识库",
    plan: "先检索再回答",
    decision: { action: "tool_call", tool: "search_knowledge_base", args: { query: "价格" }, reason: "需要查询" }
  }), triggerAfterTokenIndex: 3 }],
};

// 场景 2: ask_user 暂停
const ASK_USER_PAUSE: MockLLMConfig = { ... };

// 场景 3: LLM 重试耗尽 → degrade
const LLM_DEGRADE: MockLLMConfig = {
  error: { afterTokenIndex: 0, message: "Connection timeout", category: "degradable" },
  // 重试 3 次，每次都失败
};

// 场景 4: 审批暂停 → approve → 恢复
const APPROVAL_RESUME: MockLLMConfig = { ... };

// 场景 5: AbortSignal 取消
const CANCEL_MID_EXECUTION: MockLLMConfig = { ... };
```

## 3. 对比粒度

### 3.1 Layer 1: AgentStreamEvent 序列对比（AgentService 输出层）

**对比项目：**

1. **事件类型序列** — 按顺序比较每个 event 的 `type` 字段
2. **关键 payload 字段值** — 对匹配类型的事件，比较白名单字段

**不对比（时间不敏感）：**

- `timestamp`、`message_id`（UUID 随机）、`session_id`（UUID 随机）、`approval_id`（UUID 随机）
- 单个 `agent_token` event 的 chunk 边界（token 拆分粒度可能不同）
- `usage.total_tokens`（允许 ±5% 差异）

**关键 payload 字段白名单：**

```
agent_think:     ["step", "observation", "analysis", "plan"]
agent_act:       ["step", "decision.action", "decision.tool", "decision.args_json"]
agent_observe:   ["step", "result"]
agent_respond:   ["content", "summary"]
agent_ask_user:  ["question", "context"]
agent_approval_required: ["tool_name", "tool_args", "risk_level"]
agent_degraded:  ["step", "reason"]
agent_error:     ["error"]
agent_done:      ["total_steps", "final_summary"]
```

### 3.2 Layer 2: RouteStreamEvent 序列对比（AgentExecutor 集成层）

**输入：** 相同的 mock `AgentService.run()` 生成器（分别用 legacy 和 langgraph runner 构造）

**输出对比：** 两个 runner 经过 `AgentExecutor.execute()` 后产出的 `RouteStreamEvent` 序列

**对比维度：**

1. `meta` event 的 `route`、`model`、`provider` 字段
2. `token*` 序列的累积 content（比较最终拼接后的完整文本，不比较每个 token chunk 的边界）
3. `done` event 的 `citation`、`validated`、`fallback_used`、`route` 字段
4. `clear_stream` 事件的触发时机（在相同 event 序列位置触发）

**关键验证场景：**

| 场景 | Legacy 预期 | LangGraph 预期 |
|---|---|---|
| 正常流式 | `meta → token* → done` | 相同 |
| Leaked JSON 清洗 | `clear_stream → token* → done` | 相同 |
| ask_user | `clear_stream → token*` (question text) | 相同，不出现 ReAct JSON |
| Error fallback | `token* → done` (HARDCODED_FALLBACK text) | 相同 fallback 路径 |
| Interrupt partial | `token* → done` (sanitized partial) | 相同 |
| Citation payload | `done.citation: { level, coverageRate, ... }` | 相同 payload |

## 4. 序列对比算法

```typescript
interface EventSequenceDiff {
  typeMismatches: Array<{ index: number; legacy: string; graph: string }>;
  payloadMismatches: Array<{
    index: number;
    eventType: string;
    field: string;
    legacyValue: unknown;
    graphValue: unknown;
  }>;
  missingEvents: Array<{ index: number; runner: "legacy" | "graph"; eventType: string }>;
}

function compareEventSequences(
  legacyEvents: AgentStreamEvent[],
  graphEvents: AgentStreamEvent[],
): EventSequenceDiff {
  const diff: EventSequenceDiff = {
    typeMismatches: [],
    payloadMismatches: [],
    missingEvents: [],
  };

  // Step 1: 对齐并比较事件类型序列
  const maxLen = Math.max(legacyEvents.length, graphEvents.length);
  for (let i = 0; i < maxLen; i++) {
    const l = legacyEvents[i];
    const g = graphEvents[i];

    if (!l) { diff.missingEvents.push({ index: i, runner: "legacy", eventType: g.type }); continue; }
    if (!g) { diff.missingEvents.push({ index: i, runner: "graph", eventType: l.type }); continue; }

    if (l.type !== g.type) {
      diff.typeMismatches.push({ index: i, legacy: l.type, graph: g.type });
      continue;
    }

    // Step 2: 对匹配的事件类型，比较关键 payload 字段
    const keyFields = KEY_FIELDS_WHITELIST[l.type] || [];
    for (const field of keyFields) {
      const lv = getNestedValue(l, field);
      const gv = getNestedValue(g, field);
      if (!deepEqual(lv, gv)) {
        diff.payloadMismatches.push({
          index: i, eventType: l.type, field,
          legacyValue: lv, graphValue: gv,
        });
      }
    }
  }

  return diff;
}
```

## 5. Layer 2 AgentExecutor 集成对比

```typescript
/**
 * AgentExecutor 集成 parity 测试工具。
 */
async function testAgentExecutorParity(
  task: string,
  mockLLM: TestLLMAdapter,
): Promise<{
  legacyRouteEvents: RouteStreamEvent[];
  graphRouteEvents: RouteStreamEvent[];
  diff: EventSequenceDiff;
}> {
  // 1. 用 mock LLM 构造 legacy runner
  const legacyService = new AgentService();
  const legacyRunner = new LegacyAgentRunner(legacyService, mockLLM);
  const legacyEvents = await collectAsyncGenerator(
    legacyRunner.run(CONVERSATION_ID, task, { /* standard options */ })
  );

  // 2. 用相同 mock LLM 构造 langgraph runner
  const graphRunner = new LangGraphAgentRunner(
    createTestCheckpointer(),
    createTestToolAdapter(),
    mockLLM,
  );
  const graphEvents = await collectAsyncGenerator(
    graphRunner.run(CONVERSATION_ID, task, { /* same options */ })
  );

  // 3. 分别通过 AgentExecutor 映射（使用相同的 RouteContext）
  const context = createTestRouteContext(CONVERSATION_ID, task);
  const legacyRoute = await collectAsyncGenerator(
    createAgentExecutor().execute(context, /* scope */ undefined)
  );
  const graphRoute = await collectAsyncGenerator(
    createAgentExecutor().execute(context, /* scope */ undefined)
  );

  // 4. 比较 RouteStreamEvent 序列
  const diff = compareEventSequences(legacyRoute, graphRoute);
  return { legacyRouteEvents: legacyRoute, graphRouteEvents: graphRoute, diff };
}
```

### AgentExecutor 集成测试必需的 case

1. `meta → token* → done` 正常流式路径
2. `clear_stream` 补偿路径（Leaked JSON → clean content re-stream）
3. `agent_error → HARDCODED_FALLBACK token stream → done` 错误降级
4. `agent_ask_user → clear_stream + token*` 兼容映射
5. Interruption 时 partial content 持久化 + `done`（验证 `sanitizeReActJSON` 仍然有效）
6. Citation payload 在 `done` 中正确透传

## 6. 对比判定规则

| 差异类型 | 判定 | 说明 |
|---|---|---|
| 事件类型序列不同 | **FAIL** | Legacy 和 LangGraph 必须产出相同的事件类型序列 |
| 关键 payload 字段值不同 | **FAIL** | 决策逻辑（action, tool, args）必须一致 |
| token 边界不同但累积结果相同 | **PASS** | 允许不同 chunk 大小，比较 finalContent |
| usage.total_tokens 差异 ≤5% | **PASS** | prompt 构建的微小差异可接受 |
| UUID 字段不同 | **PASS** | message_id, session_id, approval_id 自然不同 |
| 仅 LangGraph 多了某个事件 | **FAIL** | 事件集合必须等价 |
| 仅 Legacy 多了某个事件 | **FAIL** | 事件集合必须等价 |

## 7. 测试文件结构

```
apps/server/src/services/__tests__/
  agent-runner-contract.test.ts       # Phase 0: baseline — 仅 legacy runner 的行为快照
  agent-runner-parity.test.ts        # Phase 2: legacy vs langgraph Layer 1 对比
  agent-executor-parity.test.ts      # Phase 2: Layer 2 AgentExecutor 集成对比
  fixtures/
    mock-llm-adapter.ts              # TestLLMAdapter 实现
    parity-scenarios.ts              # 预设的 MockLLMConfig 场景集
```
