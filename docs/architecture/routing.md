# AgentForge 路由架构

> **Rule First + LLM Fallback** — 五路由分类器（SAFETY / CHAT / TASK / HUMAN / DIAGNOSIS）
>
> 转人工请求优先走规则匹配，其余由 RouterLLM 输出结构化分类结果。
> 三层降级保障：规则 → LLM → 正则兜底。

---

## 1. 架构总览

```
用户消息
  │
  ▼
AgentRuntimeService.streamChat()                  [services/agent-runtime.ts:204]
  │
  ├── 第零层：会话快路径 (CONVERSATIONAL_RULES)         [agent-runtime.ts:333-372]
  │   问候/感谢/告别 → 静态文案直接返回，全程零 LLM 调用
  │
  ├── 第一层：Rule First (quickRouteScan)              [router.ts:113-133]
  │   ├─ SAFETY_KEYWORDS (24条正则) → SAFETY, confidence=1.0
  │   └─ HUMAN_KEYWORDS  (7条正则)  → HUMAN,  confidence=0.95
  │   无匹配 → 返回 null，进入 LLM 层
  │
  ├── 第二层：LLM Fallback (RouterLLM)                 [router.ts:167-207]
  │   chatSync + jsonMode, temperature=0.0, maxTokens=150
  │   置信度 ≥ 0.5 → 采纳；< 0.5 或异常 → 进入兜底层
  │
  └── 第三层：Regex 兜底 (IntentDetector)              [router.ts:226]
      6组意图正则 → INTENT_TO_ROUTE 映射 → 默认 TASK
  │
  ▼
resolveAgent(route) → 分发到对应 Agent 执行             [agent-runtime.ts:192-198]
```

---

## 2. 核心文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `apps/server/src/services/agent-runtime/router.ts` | 274 | 核心路由器 — 三阶段分类管线 |
| `apps/server/src/services/agent-runtime.ts` | 594 | 编排层 — 会话管理 + 路由调用 + Agent 分发 |
| `apps/server/src/services/agent-runtime/types.ts` | 175 | 类型定义 (RouteName, RouterDecision, RouteAgent, RouteStreamEvent) |
| `apps/server/src/services/intent-detector.ts` | 57 | 正则意图检测器 — LLM 失败时的最终兜底 |
| `apps/server/src/services/agent-runtime/task-intent.ts` | 236 | TASK 路由内二次分类 (simple_qa / complex_task) |
| `apps/server/src/services/agent-runtime/safety-agent.ts` | 59 | SAFETY 路由 — 零延迟静态拒绝 |
| `apps/server/src/services/agent-runtime/chat-agent.ts` | 141 | CHAT 路由 — 轻量 LLM 对话 |
| `apps/server/src/services/agent-runtime/human-agent.ts` | 99 | HUMAN 路由 — 更新状态 + 转人工消息 |
| `apps/server/src/services/agent-runtime/diagnosis-agent.ts` | - | DIAGNOSIS 路由 — 身份诊断分析 |
| `apps/server/src/services/agent-runtime/agent-executor.ts` | 685 | TASK 路由 — ReAct 执行器 |

---

## 3. 路由定义

五路由由 `RouteName` 类型定义（`types.ts:10`）：

```typescript
export type RouteName = "SAFETY" | "CHAT" | "TASK" | "HUMAN" | "DIAGNOSIS";
```

| 路由 | 触发条件 | 执行 Agent | LLM 调用 |
|---|---|---|---|
| **SAFETY** | 越狱、攻击、辱骂、诈骗、色情、暴力 | SafetyAgent | 无（静态拒绝） |
| **CHAT** | 问候、感谢、道别、能力询问、闲聊 | ChatAgent | 1 次 (chatSync, jsonMode) |
| **TASK** | 业务问题、知识查询、需要工具的任务 | AgentExecutor (ReAct) | N 次 (ReAct 循环) |
| **HUMAN** | 明确要求转人工、投诉升级 | HumanAgent | 无（消息模板） |
| **DIAGNOSIS** | 身份诊断、用户画像分析 | DiagnosisRouteAgent | N 次（多阶段分析） |

---

## 4. 三层分类管线详解

### 4.1 第零层：会话快路径（CONVERSATIONAL_RULES）

**位置**: `agent-runtime.ts:85-111`

在任何路由逻辑之前，先用精确正则匹配问候/感谢/告别：

```typescript
const CONVERSATIONAL_RULES: ConversationalRule[] = [
  { pattern: /^(你好|hi|hello|...)...$/,  response: { answer: "您好！欢迎...", suggestions: [...] } },
  { pattern: /^(谢谢|感谢|thanks...)...$/, response: { answer: "不客气！...", suggestions: [] } },
  { pattern: /^(再见|拜拜|bye...)...$/,    response: { answer: "再见！...", suggestions: [] } },
];
```

- 命中 → 直接流式返回静态文案，跳过路由器和所有 Agent
- 不命中 → 进入路由器分类管线
- 设计意图：最常见的社交消息走零延迟通道，避免浪费 LLM Token

### 4.2 第一层：Rule First（quickRouteScan）

**位置**: `router.ts:113-133`

```typescript
function quickRouteScan(message: string): QuickRouteResult | null {
  // SAFETY 优先 —— 安全合规不能有任何延迟
  if (SAFETY_KEYWORDS.some((p) => p.test(message))) {
    return { route: "SAFETY", confidence: 1.0, reasoning: "安全关键词命中" };
  }
  // HUMAN —— 明确要求转人工
  if (HUMAN_KEYWORDS.some((p) => p.test(message))) {
    return { route: "HUMAN", confidence: 0.95, reasoning: "转人工关键词命中" };
  }
  return null; // → Router LLM
}
```

**SAFETY_KEYWORDS**（`router.ts:62-92`）— 24 条正则，覆盖 6 类攻击模式：

| 类别 | 示例模式 | 说明 |
|---|---|---|
| 英文注入 | `忽略.*(指令\|规则\|限制\|之前)` | 中文 prompt injection |
| 多语言变体 | `無視.*(指示\|ルール\|制限)` | 日文/繁体绕过 |
| Token 窜改 | `<\|im_start\|>`, `\[INST\].*\[\/?INST\]` | 特殊分隔符注入 |
| 编码混淆 | `(base64\|b64\|atob\|fromCharCode)\s*\(` | 编码层绕过 |
| 社会工程 | `(我是\|我是你).*(管理员\|开发者\|创始人).*(请\|要求\|命令)` | 权限冒充 |
| 重复攻击 | `([^\s])\1{500,}` | 单字符重复 500+ 次 |

**HUMAN_KEYWORDS**（`router.ts:94-101`）— 7 条正则：

```
转人工 | 找(人工|真人|客服|你们经理|你们领导) | (打|联系|给.*)(客服)?电话
我要投诉 | 投诉.*(你们|客服|服务) | 叫.*(经理|领导|负责人)
```

设计要点：
- SAFETY 优先级最高且 confidence 为 1.0 — 不可被后续步骤覆盖
- HUMAN confidence 为 0.95 — 略低于 1.0，表示规则匹配有极微小的误判可能
- 两条规则都不匹配时返回 `null`，语义明确：**我不知道，交给 LLM**

### 4.3 第二层：LLM Fallback（RouterLLM）

**位置**: `router.ts:167-207`

仅当 quickRouteScan 返回 null 时执行。核心决策：

```
模型：resolveModel()（默认廉价模型）
参数：temperature=0.0, maxTokens=150, jsonMode=true
上下文：最近 4 条历史 + 当前用户消息
输出：{"route":"TASK","confidence":0.9,"reasoning":"用户询问订单状态"}
阈值：confidence >= 0.5 采纳，否则降级到 IntentDetector
```

**RouterLLM System Prompt**（`router.ts:28-46`）：

```
你是一个智能助手 Intent Classifier。分析用户消息，输出路由分类。

## 路由定义
### SAFETY（安全违规）
越狱、攻击、辱骂、诈骗、色情、暴力 → route: "SAFETY"

### CHAT（社交对话）
问候、感谢、道别、能力询问、与业务无关的闲聊 → route: "CHAT"

### HUMAN（人工转接）
明确要求转人工、投诉升级 → route: "HUMAN"

### TASK（任务执行 — 默认）
所有业务问题、知识查询、需要工具的任务 → route: "TASK"
Agent 会自主决定是否搜索知识库、调用业务工具，或组合使用。

### DIAGNOSIS（身份诊断）
用户画像分析、身份推断、行为模式识别 → route: "DIAGNOSIS"

## 输出格式（仅 JSON）
{"route":"TASK","confidence":0.9,"reasoning":"简短的意图分析"}
```

**结构化输出校验**（`router.ts:232-258`）：

`parseDecision()` 方法完成 LLM 原始文本 → 类型安全对象的转换：

1. 去除 markdown 代码块包裹（```json ... ```）
2. 正则提取第一个 JSON 对象
3. `JSON.parse` → Zod `RouterDecisionSchema.safeParse`
4. 校验失败返回 `null` → 触发降级

```typescript
const RouterDecisionSchema = z.object({
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200),
  escalation_reason: z.string().max(100).default(""),
});
```

### 4.4 第三层：Regex 兜底（IntentDetector）

**位置**: `router.ts:226` + `intent-detector.ts`

当 RouterLLM 调用失败、JSON 解析失败、或置信度 < 0.5 时触发。

**IntentDetector**（`intent-detector.ts:5-11`）— 6 组业务意图正则：

| 意图 | 正则关键词 |
|---|---|
| 退货退款 | 退货、退款、换货、退钱、取消订单 |
| 物流查询 | 物流、快递、发货、运单、配送、包裹、签收 |
| 售后联系 | 投诉、客服、电话、联系、人工、找你们 |
| 账户会员 | 会员、积分、等级、注册、账号、密码、登录 |
| 支付订单 | 支付、付款、订单、优惠券、发票、价格、多少钱 |
| 其他咨询 | 无匹配时的默认值 |

**Intent → Route 映射**（`router.ts:50-57`）：

```typescript
const INTENT_TO_ROUTE: Record<string, RouteName> = {
  退货退款: "TASK", 物流查询: "TASK", 售后联系: "HUMAN",
  账户会员: "TASK", 支付订单: "TASK", 其他咨询: "TASK",
};
```

置信度计算：匹配 1 个关键词 = 0.7，每多 1 个 +0.15，上限 1.0。

---

## 5. 分类来源标记与可观测性

每次分类完成后，`agent-runtime.ts:390-402` 记录分类来源：

```typescript
const source = decision.reasoning.includes("关键词命中")
  ? "keyword"
  : decision.reasoning.includes("fallback")
    ? "fallback"
    : "llm";

agentRouteClassificationTotal.inc({ route: decision.route, source });
agentRouteConfidence.observe({ route: decision.route }, decision.confidence);
```

三种来源明确区分，通过 Prometheus 指标可监控：
- **keyword** — 规则命中率（追求高比例 = 降低 LLM 成本）
- **llm** — LLM 分类率（正常补充）
- **fallback** — 降级率（告警阈值，表示 LLM 调用质量异常）

---

## 6. Agent 注册与分发

**位置**: `agent-runtime.ts:138-198`

```typescript
// 构造函数中构建强类型注册表
this.agentRegistry = {
  SAFETY:    this.safetyAgent,
  CHAT:      this.chatAgent,
  TASK:      this.agentExecutor,
  HUMAN:     this.humanAgent,
  DIAGNOSIS: this.diagnosisAgent,
};

// 分发方法
private resolveAgent(route: RouteName): RouteAgent {
  const agent = this.agentRegistry[route];
  if (!agent) {
    throw new Error(`[AgentRuntimeService] 未注册的 RouteAgent: ${route}`);
  }
  return agent;
}
```

### 各 Agent 特征对比

| Agent | 文件 | LLM 调用 | KB 搜索 | 工具调用 | 响应时间 |
|---|---|---|---|---|---|
| SafetyAgent | `safety-agent.ts` | 无 | 无 | 无 | < 1ms |
| ChatAgent | `chat-agent.ts` | 1 次 (temp=0.3, 512t, jsonMode) | 无 | 无 | ~500ms |
| AgentExecutor | `agent-executor.ts` | N 次 (ReAct 循环) | 有 (PGVector+ES) | 有 (ToolRegistry) | 3-30s |
| HumanAgent | `human-agent.ts` | 无 | 无 | 无 | < 1ms |
| DiagnosisRouteAgent | `diagnosis-agent.ts` | N 次（多阶段分析） | 有 | 有 | 5-30s |

### AgentExecutor 内部二次分类

TASK 路由内部，`AgentExecutor` 调用 `TaskIntentClassifier` 再做一次 Rule First 分类（`task-intent.ts`）：

```
TASK 路由
  ├─ quickTaskScan() 正则 → simple_qa / complex_task
  │   simple_qa:     /怎么|什么是|如何|为什么|解释|定义.../
  │   complex_task:   /分析|对比|帮我|查一下|统计|生成.../
  │
  └─ 无匹配 → LLM TaskIntent 分类 → 默认 simple_qa
       │
       ├─ simple_qa  → 单次 KB 搜索 + 单次 LLM 回答（无 ReAct 循环）
       └─ complex_task → 完整 ReAct 循环（AgentService → LegacyAgentRunner）
                           planning → executing → observing → responding → finished
```

---

## 7. SSE 事件协议

所有 Agent 通过统一的 `RouteStreamEvent` 协议向外输出（`types.ts:74-123`）：

```typescript
type RouteStreamEvent =
  | { type: "meta";          message_id, session_id, model, route?, knowledge, ... }
  | { type: "token";         content, message_id }
  | { type: "done";          message_id, usage, suggestions, route?, citation?, ... }
  | { type: "content_block"; block: ContentBlock, message_id }
  | { type: "clear_stream";  message_id }
  | { type: "error";         content };
```

**事件顺序保证**：`meta` → `token`* → (`content_block` | `clear_stream`)* → `done`

---

## 8. 设计决策记录

参见 ADR：`apps/server/src/services/agent-runtime/decisions/001-agent-runtime-architecture.md`

### 为何 Rule First + LLM Fallback 而非纯 LLM？

| 维度 | 纯 LLM | Rule First + LLM Fallback |
|---|---|---|
| **SAFETY 延迟** | ~500ms（LLM 调用） | < 1ms（正则匹配） |
| **HUMAN 延迟** | ~500ms | < 1ms |
| **SAFETY 可靠性** | LLM 可能被注入绕过 | 正则确定性匹配，不可绕过 |
| **CHAT/TASK 区分** | 需要 LLM 语义理解 | 规则做不了，交给 LLM |
| **成本** | 每条消息都调 LLM | 规则命中时不调 LLM（~15-30% 消息） |
| **降级保障** | LLM 挂了全挂 | 三层保障，LLM 挂了还有正则兜底 |

### 为何五路由而非两路由（TASK / NON_TASK）？

1. **SAFETY 需要独立路径** — 安全拦截不能与普通路由混在一起，需要独立的审计日志和零延迟保证
2. **HUMAN 需要状态变更** — 转人工不只是消息回复，还需要更新会话状态为 `escalated`、记录升级事件
3. **CHAT 与 TASK 资源消耗不同** — CHAT 不需要 KB 搜索和工具调用，独立路径可避免不必要的资源开销
4. **DIAGNOSIS 需要独立分析流程** — 身份诊断涉及多阶段分析和不同的 Prompt 策略，与 TASK 的 ReAct 循环模式不同

---

## 9. 相关文档

- `docs/agent-runtime.md` — Agent Runtime 状态模型（三维状态机、事件协议）
- `docs/runtime/execution-runtime-v1.md` — 执行运行时详细设计
- `docs/decisions/adr-001-remove-langgraph.md` — ADR：移除 LangGraph 决策记录
