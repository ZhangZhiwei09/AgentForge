# AgentForge 路由架构

> **规则优先 + 一次业务模型分类**，默认使用企业知识咨询与故障排查入口。
>
> 新入口直接替换旧五层路由，不需要环境开关。SAFETY / CHAT / TASK / HUMAN / DIAGNOSIS 保留为执行与协议标签。
> 规则优先级：安全 → 明确人工/取消 → 等待诊断 → 已发布配置 → 精确问候 → 模型分类。
> 模型区分 consultation / diagnosis / unclear；不明确则澄清，服务失败则提示不可用。

---

## 1. 架构总览

```
用户消息
  │
  ▼
AgentRuntimeService.streamChat()
  │
  ├── 安全检查 → SAFETY
  ├── 明确转人工 → HUMAN；取消排查 → 取消本会话等待任务并如实回复
  ├── 等待补充 → 原诊断快照续跑
  │
  ├── 已发布一级流程 → TS 确定性条件图
  │   ├─ reply → 配置正文、建议问题、保存历史；无模型/工具/记忆注入
  │   ├─ route → 校验请求与配置分流一致后分发；冲突则明确提示配置错误
  │   └─ continue → 一次业务模型分类
  │
  └── 没有已发布流程 → 精确问候直接回复；其余进入一次业务模型分类
  │
  ▼
classifyBusinessIntent(当前消息 + 最近四条用户/助手历史)：
  consultation → TASK
  diagnosis → DIAGNOSIS
  unclear → Runtime 直接澄清
  provider 错误或非法输出 → Runtime 明确提示不可用
  │
  ▼
resolveAgent(route) → 现有 Agent 执行 → 消息与引用等后处理
```

入口不再实例化 QueryRouter，也不调用 L2 意图向量分类或电商 IntentDetector。
知识库向量检索仍保留。当前 TASK 仍复用 AgentExecutor，其内部复杂度分类将在后续咨询执行器改造中移除；入口一次分类不等于完整请求只调用一次模型。

---

## 2. 核心文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/services/entry-route-flows/` | 条件 DSL、图校验、执行、发布快照和运行记录 |
| `apps/server/src/routes/entry-route-flows.ts` | TS 原生管理员配置与试运行接口 |
| `apps/server/src/services/agent-runtime/entry-decision.ts` | 安全、控制、状态、配置、问候与一次业务分类的统一决策 |
| `apps/server/src/services/agent-runtime/routing/business-classifier.ts` | 中文模型提示词、最近四条历史、输出结构校验 |
| `apps/server/src/services/agent-runtime/routing/l1-keyword.ts` | 主入口复用 safetyRouteScan；旧业务关键词扫描不参与主入口 |
| `apps/server/src/services/agent-runtime.ts` | 会话管理、统一入口、Agent 分发、SSE、审计和消息保存 |
| `apps/server/src/services/agent-runtime/types.ts` | 内部上下文和 SSE 契约 |
| `apps/server/src/services/intent-detector.ts` | 仍有 analytics 消费者，主入口不调用 |
| `apps/server/src/services/agent-runtime/task-intent.ts` | TASK 内部二次分类 |
| `apps/server/src/services/agent-runtime/safety-agent.ts` | 安全拒绝 |
| `apps/server/src/services/agent-runtime/chat-agent.ts` | 普通问答 |
| `apps/server/src/services/agent-runtime/human-agent.ts` | 会话升级，支持可信配置话术 |
| `apps/server/src/services/agent-runtime/diagnosis-agent.ts` | 已启用诊断流程或原诊断团队 |
| `apps/server/src/services/agent-runtime/agent-executor.ts` | 业务任务执行 |

---

## 3. 路由定义

五路由由 `RouteName` 类型定义（`types.ts:10`）：

```typescript
export type RouteName = "SAFETY" | "CHAT" | "TASK" | "HUMAN" | "DIAGNOSIS";
```

| 路由 | 触发条件 | 执行 Agent | LLM 调用 |
|---|---|---|---|
| **SAFETY** | 越狱、攻击、辱骂、诈骗、色情、暴力 | SafetyAgent | 无（静态拒绝） |
| **CHAT** | 固定回复、精确问候、澄清与不可用输出；也支持有效配置分发 | Runtime 直接响应；配置分发时 ChatAgent | 直接响应无调用；配置分发时 1 次 |
| **TASK** | consultation 或已发布配置的咨询分流 | 当前 AgentExecutor | 内部分类及回答/工具调用，尚待专用咨询执行器改造 |
| **HUMAN** | 明确请求人工支持 | HumanAgent | 无（消息模板） |
| **DIAGNOSIS** | 具体故障排查意图、等待排查续跑或有效配置分流 | DiagnosisRouteAgent | N 次（多阶段分析） |

---

## 4. 历史模块

本节记录仓库仍存在的旧分类模块，供独立测试与脚本定位。它们已经退出主聊天入口，无法通过环境开关或停用一级流程恢复为聊天主链。以下算法和阈值是历史模块行为，不代表当前请求流程。

L2 为 Embedding 样本检索：置信度 >= 0.8 直接采纳；0.5～0.8 且有样本时进入 L3 Few-Shot。L3 和 L4 的普通路由门槛为 0.5，DIAGNOSIS 为 0.7。未获得可接受结果时进入 L5，原算法、提示词和阈值均保持。

### 4.1 第零层：会话快路径（CONVERSATIONAL_RULES）

**位置**: `agent-runtime.ts:85-111`

当前无发布流程、没有安全命中或等待任务时，精确问候仍由统一决策处理。历史问候快通道曾独立于入口保存消息，现在固定回复统一经 `streamEntryResponse` 保存：

```typescript
const CONVERSATIONAL_RULES: ConversationalRule[] = [
  { pattern: /^(你好|hi|hello|...)...$/,  response: { answer: "您好！欢迎...", suggestions: [...] } },
  { pattern: /^(谢谢|感谢|thanks...)...$/, response: { answer: "不客气！...", suggestions: [] } },
  { pattern: /^(再见|拜拜|bye...)...$/,    response: { answer: "再见！...", suggestions: [] } },
];
```

- 命中 → 直接流式返回静态文案，跳过路由器和所有 Agent
- 不命中 → 当前入口进入一次业务模型分类
- 设计意图：最常见的社交消息走零延迟通道，避免浪费 LLM Token

### 4.2 第一层：Rule First（quickRouteScan）

**位置**: `routing/l1-keyword.ts`

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
  if (DIAGNOSIS_KEYWORDS.some((p) => p.test(message))) {
    return { route: "DIAGNOSIS", confidence: 0.85, reasoning: "诊断关键词命中" };
  }
  return null; // → L2
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
- 没有命中时返回 `null`，进入 L2。

### 4.3 L4：LLM Fallback（RouterLLM）

**位置**: `routing/l3-llm-router.ts`

当 L2 和 L3 都未给出可接受结果时执行。核心决策：

```
模型：resolveModel()（默认廉价模型）
参数：temperature=0.0, maxTokens=150, jsonMode=true
上下文：最近 4 条历史 + 当前用户消息
输出：{"route":"TASK","confidence":0.9,"reasoning":"用户询问订单状态"}
阈值：confidence >= 0.5 采纳；DIAGNOSIS 至少 0.7，否则降级到 IntentDetector
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
核身故障、错误码与系统诊断 → route: "DIAGNOSIS"

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

### 4.4 L5：Regex 兜底（IntentDetector）

**位置**: `routing/l5-fallback.ts` + `intent-detector.ts`

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

统一入口返回显式 `action` 和 `source`，Runtime 直接使用来源标签：

```typescript
const route = decision.action === "dispatch" ? decision.route : "CHAT";
agentEntryDecisionsTotal.inc({ action: decision.action, source: decision.source });
agentRouteClassificationTotal.inc({ route, source: decision.source });
if (decision.source !== "business_llm") {
  agentRouteConfidence.observe({ route }, 1);
}
```

来源包括 `safety_rule`、`control_rule`、`session_state`、`entry_flow`、`conversational_rule` 和 `business_llm`。直接回复兼容 CHAT 标签，动作由入口指标及消息 metadata 区分。

`recordEntryAudit` 保存路由来源，写入失败记录日志并继续响应；取消发生在审计期间则停止分发。模型结果的旧 confidence 必填列记为 0，表示未知占位，不作为概率，也不计入 confidence histogram。分类模型次数及耗时由独立指标记录。

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
| **明确控制请求** | 依赖模型识别 | 规则直接处理人工与取消 |
| **等待任务** | 可能重新分类 | 可信会话状态优先恢复 |
| **安全检查** | 依赖模型判断 | 复用安全规则；规则覆盖范围仍需验证 |
| **咨询/排查区分** | 模型判断 | 规则未确定时，结合历史做一次模型分类 |
| **成本** | 每条消息都分类 | 命中确定规则时不调用分类模型；比例未测量 |
| **模型失败** | 需要设计异常处理 | 明确提示不可用，不伪装咨询成功或回旧路由 |

### 两个业务意图与五个执行标签

业务分类只有 consultation、diagnosis，以及意图不明时的 unclear。SAFETY、HUMAN 和固定回复属于控制与响应行为；五个执行标签保留已有 API 与 Agent 注册表契约，不表示仍使用五层分类。

现有诊断执行器与知识咨询能力继续复用；统一咨询执行、监控事实契约和业务可读报告属于后续单元，本次入口替换不代表这些能力已经完成。

---

## 9. 相关文档

- `docs/design/lightweight-entry-route-flow-implementation.md` — 配置契约、验证结果、模板差异和停用操作
- `docs/design/lightweight-entry-route-flow-plan.md` — 实施范围与验收 checklist
- `docs/agent-runtime.md` — Agent Runtime 状态模型（三维状态机、事件协议）
- `docs/runtime/execution-runtime-v1.md` — 执行运行时详细设计
