# AgentForge Runtime V1 — Agent Runtime Model

> **状态：已冻结** | 2026-06-15
>
> 本文档定义 AgentForge 的 Agent Runtime 状态模型。它是 `docs/agent-runtime.md` 的正式设计文档，
> 覆盖 Agent 生命周期、事件协议、输出交付三个维度的完整定义。
>
> 任何修改这些核心抽象的需求，必须**先更新本文档**形成共识，再改代码。

---

## 1. 架构分层

AgentForge 的 Agent 系统分两层，各自有独立的事件协议：

```
┌─────────────────────────────────────────────────────┐
│  RouteStreamEvent (5 种)                             │
│  → 面向外部 SSE 消费者（前端、Eval、日志）            │
│  → 定义在 customer-chat/types.ts                     │
├─────────────────────────────────────────────────────┤
│  ToolAgent (Protocol Translator)                     │
│  → 内部状态：AgentPhase / OutputState / ResponseEnvelope │
│  → 映射层：AgentStreamEvent → RouteStreamEvent        │
├─────────────────────────────────────────────────────┤
│  AgentStreamEvent (14 种)                             │
│  → 面向内部 Agent 通信（ReAct 循环、多 Agent 团队）    │
│  → 定义在 packages/shared-types/src/agent.ts          │
├─────────────────────────────────────────────────────┤
│  AgentService (ReAct Loop Engine)                     │
│  → 内部优化：respondOnly（条件性 prompt 简化）         │
│  → 不暴露到外部协议                                    │
└─────────────────────────────────────────────────────┘
```

---

## 2. 三维状态模型

### 2.1 AgentPhase — 业务阶段

**定义位置**: `apps/server/src/services/customer-chat/tool-agent.ts`

```typescript
type AgentPhase =
  | "planning"     // 初始/思考中
  | "executing"    // Agent 决定调用工具
  | "observing"    // 工具返回结果，Agent 消化数据
  | "responding"   // Agent 显式声明开始组织最终回复
  | "finished";    // Agent 生命周期结束
```

**状态机规则（严格遵守）：**

```
planning ──[agent_decide tool_call]──→ executing
planning ──[agent_responding]───────→ responding

executing ──[agent_observe]─────────→ observing
executing ──[agent_responding]──────→ responding

observing ──[agent_decide tool_call]──→ executing
observing ──[agent_responding]────────→ responding

responding ──[agent_done]───────────→ finished
responding ──[agent_error]──────────→ 不改变 phase ← 关键！
```

**核心约束：**

| 规则 | 说明 |
|------|------|
| Phase 仅由业务事件驱动 | `agent_observe`、`agent_responding`、`agent_respond`、`agent_done` |
| `agent_token` **不驱动**任何 phase 转换 | Token 是输出，不是状态信号 |
| `agent_error` **不改变** phase | 错误是临时状态，Agent 可能继续执行 |
| `agent_done` → `finished` 是终态 | 不逆转 |

**为什么 `agent_responding` 是最关键的事件：**

以前模型是推断式的：`agent_observe` 结束 ≈ 开始回复。但实际上 `observe` 后完全可能继续调工具。
现在 `agent_responding` 是 Agent **自己声明**"我已拿到足够信息，开始组织最终回复"——
这比推断可靠得多。

### 2.2 OutputState — 输出生命周期

**定义位置**: `apps/server/src/services/customer-chat/tool-agent.ts`

```typescript
interface OutputState {
  visibleChars: number;       // 已交付给用户的字符数，只增不减
  responseStarted: boolean;   // agent_responding 已触发 → 开始交付最终答案
  responseCompleted: boolean; // agent_respond 已触发 或 post-processing 已完成补偿
}
```

**与 AgentPhase 的解耦关系：**

| 场景 | Phase | responseStarted | responseCompleted |
|------|-------|-----------------|-------------------|
| Agent 思考中，token 未转发 | planning | false | false |
| Agent 声明回复，开始流式输出 | responding | true | false |
| 最终回复已生成，流式完成 | responding | true | true |
| agent_decide respond（无流式），补偿输出 | responding | false→true（补偿） | true |
| 异常：Agent 未声明回复但被 done 终止 | finished | false | false→true（补偿） |

**补偿机制（唯一出口）：** 在 done 事件发送前，检查 `outputState.responseCompleted`。
如果为 false，通过 `finalContent ?? fallbackContent ?? accumulatedSanitized ?? hardcodedFallback` 优先级链
补发内容。这是唯一的兜底补偿出口。

### 2.3 ResponseEnvelope — 响应内容

**定义位置**: `apps/server/src/services/customer-chat/tool-agent.ts`

```typescript
interface ResponseEnvelope {
  finalContent?: string;    // 来自 agent_respond（正常 LLM 生成的内容）
  fallbackContent?: string; // 来自 agent_error / sanitize 失败（降级内容）
}
```

**优先级链（post-processing 阶段）：**

```
envelope.finalContent          ← LLM 正常生成
    ??
envelope.fallbackContent       ← agent_error 设置 或 sanitize 失败设置
    ??
sanitizeReActJSON(accumulated) ← 尝试从缓存内容中提取
    ||
"抱歉，暂时无法处理..."         ← 硬编码兜底
```

**设计意图：**
- `finalContent` 和 `fallbackContent` **互不覆盖**——一旦设置了 fallbackContent，后续 finalContent 不受影响
- 消除了旧 `pendingContent` 的"垃圾桶"问题——不再把所有东西混在一起
- 未来可扩展：`fallbackModelContent`（降级模型生成）、`humanOverride`（人工接管）

---

## 3. 事件协议

### 3.1 AgentStreamEvent — 内部协议（14 种）

**定义位置**: `packages/shared-types/src/agent.ts`
**用途**: AgentService ReAct 循环产出 → 被 ToolAgent/Teams/Workflows 消费

| 事件 | type | 携带数据 | 驱动 Phase |
|------|------|----------|------------|
| `agent_meta` | 元信息 | session_id, model, provider, tools | ❌ |
| `agent_think` | 推理 | step, observation, analysis, plan | ❌ |
| `agent_act` | 决策 | step, decision (tool_call/respond/ask_user) | ✅→executing |
| `agent_observe` | 观察 | step, result | ✅→observing |
| `agent_token` | 流式 token | content, message_id | ❌ |
| `agent_responding` | **声明回复** | step | ✅→responding |
| `agent_respond` | 最终回复 | content, summary, message_id | ❌ |
| `agent_clear_stream` | 清空缓存 | message_id, step | ❌ |
| `agent_ask_user` | 询问用户 | question, context, session_id | ❌ |
| `agent_error` | 错误 | error, step | ❌ |
| `agent_done` | 结束 | total_steps, final_summary, session_id | ✅→finished |
| `agent_approval_required` | 审批请求 | approval_id, tool_name, risk_level | ❌ |
| `agent_approval_result` | 审批结果 | approval_id, status | ❌ |
| `agent_degraded` | 降级 | original_tool, alternative_tool, reason | ❌ |
| `agent_guard_block` | 安全阻断 | reason, detail | ❌ |

### 3.2 RouteStreamEvent — 外部协议（5 种）

**定义位置**: `apps/server/src/services/customer-chat/types.ts`
**用途**: 面向前端 SSE 消费者

| 事件 | type | 携带数据 |
|------|------|----------|
| `meta` | 元信息 | message_id, session_id, model, intent, knowledge 等 |
| `token` | 流式字符 | content, message_id |
| `content_block` | 结构化卡片 | block (OrderCard/StatusCard/PolicyCard 等), message_id |
| `done` | 结束 | message_id, usage, suggestions, memory, validated, fallback_used |
| `error` | 错误 | content |

### 3.3 协议映射（ToolAgent 翻译层）

```
AgentStreamEvent          →    RouteStreamEvent
─────────────────────────────────────────────────
agent_token               →    token (仅在 phase==="responding" 时转发)
agent_responding          →    (仅更新内部状态，不产出外部事件)
agent_respond             →    token (补偿输出) 或 仅更新 envelope
agent_observe             →    content_block (如果工具结果含结构化数据)
agent_done                →    done
agent_error               →    (仅更新 envelope.fallbackContent)
agent_think/act/ask_user  →    (在 ToolAgent 层被吞噬，不暴露)
```

**关键设计决策：**
- `agent_responding` 不产出外部事件——它是一个**信号**，用来控制 token 是否转发
- `agent_respond` 可能产出 token（补偿路径）也可能不产出（正常路径，token 已通过 agent_token 转发）
- `agent_think`/`agent_act`/`agent_ask_user` 被 ToolAgent 吞掉——这是有意为之，客服场景不需要暴露内部推理

---

## 4. AgentService 内部：respondOnly 变量

**位置**: `apps/server/src/services/agent.ts:261`
**作用范围**: AgentService 内部 ReAct 循环

```typescript
let respondOnly = false;
```

这是一个**独立的内部优化**，与已删除的 customer-chat `RESPOND_ONLY` 无关。

**何时触发：** 当 AgentService 检测到原生 tool call（`tool.name !== "agent_decide"`），
设置为 `true`，后续迭代使用简化的 system prompt（无 JSON 输出指令）和空工具列表，
让 LLM 直接输出干净的 Markdown 回复。

**不导出到共享类型，不暴露到外部协议。**

---

## 5. 消费者地图

### 5.1 `agent_respond` 消费者

| 消费者 | 文件 | 用途 |
|--------|------|------|
| ToolAgent | `tool-agent.ts` | 设置 envelope.finalContent，触发补偿输出 |
| 前端 Agent 面板 | `useAgentStream.ts:121` | 展示最终回复内容 |
| 多 Agent Peer | `teams/modes/peer.ts:73` | 广播 agent 回复给其他 peer |
| 多 Agent Orchestrator | `teams/modes/orchestrator.ts:81` | 捕获 agent 输出 |
| 多 Agent Debate | `teams/modes/debate.ts:159,248` | 获取辩论各方的回复 |
| 工作流引擎 | `workflows/handlers/agent-step.ts:97` | 检测 agent 步骤是否结束 |
| Agent Guard | `agent-guard.ts:367` | 在 yield agent_respond 之前做安全检查 |

### 5.2 `agent_responding` 消费者

| 消费者 | 文件 | 用途 |
|--------|------|------|
| ToolAgent | `tool-agent.ts:171` | phase→responding, responseStarted=true |

`agent_responding` 目前只有一个直接消费者，但它的价值在于**语义精确性**——
它让 ToolAgent 不需要"猜"Agent 是否开始回复，而是由 Agent 自己声明。
这为未来扩展（如 guardrail 检查后回到 executing）奠定基础。

### 5.3 RouteStreamEvent 消费者

| 消费者 | 文件 | 用途 |
|--------|------|------|
| CustomerChatPage | `CustomerChatPage.tsx` | 内嵌客服页面 SSE 消费 |
| 浮动客服窗口 | `CustomerChat.tsx` | 浮动客服 icon SSE 消费 |
| useCustomerChatStream | `useCustomerChatStream.ts` | 抽取的 SSE hook |
| Eval 日志 | `customer-chat.ts` | done 事件中的 citation/validated/fallback_used |

---

## 6. 消费者审计（2026-06-15）

| 搜索项 | 结果 | 状态 |
|--------|------|------|
| `pendingContent` / `pending_content` | **零匹配** | ✅ 已清除 |
| `flowState` | 1 条注释（`tool-agent.ts:290`，声明不依赖） | ✅ 仅文档 |
| `RESPOND_ONLY` (customer-chat 层) | **零匹配** | ✅ 已清除 |
| `respondOnly` (AgentService 内部) | 8 处（全部在 `agent.ts` 内部） | ✅ 独立概念，安全 |
| `AgentPhase` 外部引用 | 仅 `customer-chat-unit.test.ts`（复制定义） | ⚠️ 测试重复定义 |
| `OutputState` 外部引用 | 仅 `customer-chat-unit.test.ts`（复制定义） | ⚠️ 测试重复定义 |

**结论**: 旧引用清理干净。`AgentPhase`/`OutputState`/`ResponseEnvelope` 仍在 ToolAgent 内部，
测试代码复制了类型定义——这是有意的，避免仅为测试而导出内部类型。

---

## 7. 生命周期序列图

```
用户消息
    │
    ▼
QueryRouter.classify()  ← LLM 分类
    │
    ▼
ToolAgent.execute()
    │
    ├─ [planning]  yield meta
    │
    ├─ [executing] AgentService.run() 启动 ReAct
    │      │
    │      ├── agent_think → (吞掉，不暴露)
    │      ├── agent_act (tool_call) → phase=executing
    │      ├── agent_observe → phase=observing, yield content_block
    │      │       │
    │      │       └── (可能循环多轮)
    │      │
    │      ├── agent_responding → phase=responding, responseStarted=true
    │      │       │
    │      │       └── agent_token → 仅在 responding 时转发 token 事件
    │      │
    │      ├── agent_respond → envelope.finalContent, responseCompleted=true
    │      │       │
    │      │       └── (如果 responseStarted=false → 补偿输出)
    │      │
    │      └── agent_done → phase=finished
    │
    ├─ [post-processing]
    │      │
    │      ├── sanitizeReActJSON (清理泄漏的 ReAct JSON)
    │      ├── 补偿输出 (如果 !responseCompleted)
    │      └── yield content_blocks (结构化卡片)
    │
    └─ [finished] yield done
```

---

## 8. 设计原则

1. **Phase 与 Output 解耦。** Agent 在做什么（Phase）≠ 已经交付了多少（OutputState）。
   一个 Phase 可以跨越多个 OutputState 阶段，反之亦然。

2. **Agent 自己声明状态，而非被推断。** `agent_responding` 的价值在于：
   Agent 主动声明"我已拿到足够信息"，而非 ToolAgent 从 `agent_observe` 推断"应该开始回复了"。

3. **唯一的补偿出口。** Post-processing 是唯一检查 `!responseCompleted` 并补偿输出的地方。
   不允许在其他任何地方直接操作输出补偿。

4. **内容分离，互不覆盖。** `finalContent` 和 `fallbackContent` 各司其职，设置了一个不影响另一个。
   优先级链在最终出口处一次性计算。

5. **Token 转发仅受 Phase 控制。** `agent_token` 仅在 `phase === "responding"` 时转发。
   这确保用户看到的是最终回复，而非 JSON 决策文本或中间推理。

---

## 9. 演进方向

当前三维模型（Phase + Output + Response）覆盖了 Agent 运行时的主要状态维度。
以下是已识别但尚未实施的维度：

### 9.1 ExecutionState（下一优先级）

```typescript
interface ExecutionState {
  currentTool?: string;     // 正在执行的工具名
  toolCalls: number;        // 本次运行中已调用的工具次数
  iteration: number;        // ReAct 迭代轮次
  tokensUsed: number;       // 已消耗的 token
  costCents: number;        // 已消耗的费用（分）
}
```

**用途：** 结构化 trace，可直接回答"为什么调了 5 次工具"、"什么时候超时"、"为什么死循环"。

### 9.2 Planner 集成

当前 Phase 已预留 `planning`，但实际 Planner Agent 尚未实现。
未来的 Planner Agent 将：

```
Plan → Execute → Observe → (Replan) → Respond
```

当前的 `planning` phase 几乎没有额外成本，且与未来 Planner 完全兼容。

### 9.3 完整 AgentState

最终目标：

```typescript
interface AgentState {
  phase: AgentPhase;
  execution: ExecutionState;
  output: OutputState;
  response: ResponseEnvelope;
}
```

这是成熟的 Agent Runtime 状态模型，与 LangGraph、OpenAI Agents SDK、AutoGen 等主流框架对齐。

---

## 10. 相关文件

| 文件 | 用途 |
|------|------|
| `apps/server/src/services/customer-chat/tool-agent.ts` | ToolAgent 实现 + AgentPhase/OutputState/ResponseEnvelope 类型 |
| `apps/server/src/services/customer-chat/types.ts` | RouteStreamEvent + RouteAgent 接口 |
| `apps/server/src/services/agent.ts` | AgentService ReAct 循环（含内部 respondOnly） |
| `packages/shared-types/src/agent.ts` | AgentStreamEvent（14 种）+ AgentDecision/AgentStep |
| `packages/shared-types/src/customer-chat.ts` | CSMessage, CSStreamMeta, KnowledgeResult 等共享类型 |
| `apps/server/src/services/customer-chat/router.ts` | QueryRouter：LLM 驱动路由分类 |
| `apps/server/src/services/customer-chat.ts` | CustomerChatService：编排层 |
| `apps/web/src/hooks/useAgentStream.ts` | 前端 AgentStreamEvent 消费 |
| `apps/server/src/__tests__/customer-chat-unit.test.ts` | AgentPhase/OutputState 状态机单元测试 |
| `docs/agent-runtime.md` | 本文档 |

---

## 11. CitationVerifier 集成（L4 引证校验）

**状态**: ✅ 已集成（2026-06-15）
**文件**: `tool-agent.ts`

引证校验流程：
1. ReAct 循环中从 `search_knowledge_base` 工具结果收集 KB chunks
2. sanitizeReActJSON 之后，调用 `CitationVerifier.verify(finalAnswer, collectedKBChunks)`
3. 记录 `csCitationCoverage` 指标
4. 调用 `validateBusinessResponse(finalAnswer, collectedKBChunks, citationReport)` 执行 5 层校验
5. done 事件透传 `citation` 字段（level, coverageRate, avgScore, uncitedCount）

### 11.1 sanitizeReActJSON 时序问题

**严重程度**: 中等
**文件**: `tool-agent.ts:252-270`
**发现**: `runtime-contract.test.ts` Scenario 6

sanitizeReActJSON 在 for 循环（事件处理）**之后**执行。此时 `responseCompleted` 可能已被 `agent_respond` 事件设置为 `true`。
当 sanitize 清空 `finalContent`（检测到 ReAct JSON 泄漏）时，post-processing 因 `responseCompleted=true` 而跳过补偿。
如果 `agent_respond` 之前没有 `agent_token` 被转发，用户可能看到零 token 输出。

**建议修复**: 将 sanitize 逻辑移到 `agent_respond` 事件处理内部，在设置 `responseCompleted=true` 之前执行。

### 11.2 agent_respond("") 空字符串边界

**严重程度**: 低
**文件**: `tool-agent.ts:204-224`
**发现**: `runtime-contract.test.ts` 空字符串场景

`agent_respond("")` → `finalContent=""`（空字符串）. 补偿迭代空字符串产生 0 字符，
`sanitizeReActJSON` 块中 `if (finalAnswer)` 对空字符串为 falsy 跳过，
post-processing 因 `responseCompleted=true` 跳过。结果：用户看到 0 token。

**建议修复**: (a) 在 agent_respond 处理中检查非空 content；
或 (b) sanitize 块改为 `if (finalAnswer != null)`.

### 11.3 fallbackUsed 变量作用域 Bug（已修复）

**严重程度**: 高（已修复）
**文件**: `tool-agent.ts:289-328`
**发现**: `runtime-contract.test.ts` 全部集成场景

`fallbackUsed` 在 `if (!outputState.responseCompleted)` 块内声明，但在块外 `done` 事件中无条件引用。
正常流式路径（responseCompleted 已为 true）导致 `ReferenceError`。

**修复**: 将 `let fallbackUsed = false;` 提升到 if 块之前（2026-06-15）。

---

## 12. 变更日志

| 日期 | 变更 |
|------|------|
| 2026-06-13 | 初始重构：RESPOND_ONLY → AgentPhase + OutputState + ResponseEnvelope |
| 2026-06-14 | BusinessAgent 退役，ToolAgent 接管所有 TOOL 路由 |
| 2026-06-15 | **本文档冻结**——AgentForge Runtime V1 正式定义 |
| 2026-06-15 | 修复 `fallbackUsed` 变量作用域 Bug（ReferenceError on normal path） |
| 2026-06-15 | 新建 `runtime-contract.test.ts`（32 测试，守护 Runtime Contract） |
| 2026-06-15 | 发现 2 个已知问题：sanitizeReActJSON 时序 + 空字符串边界 |
| 2026-06-15 | P0-10: CitationVerifier + validateBusinessResponse 集成到 ToolAgent（L4 引证校验上线） |
| 2026-06-15 | P2-11: SmallTalkAgent LLM 失败时设置 `fallback_used: true` |
| 2026-06-15 | P1/P2: LRU 读提升、metrics 桶调优、快速通道 TTFT、单例修约、死代码清理 |
| 2026-06-15 | P0-1/2/3: 会话锁竞态、fallbackUsed Bug、TTFT 指标修复 |
