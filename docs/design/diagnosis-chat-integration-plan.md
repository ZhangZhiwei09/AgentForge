# DiagnosisMode 聊天集成实施方案

> **✅ 状态: 大部分已实现（2026-07）** — DIAGNOSIS 已作为第 5 条路由接入 Agent Runtime 主链路，`DiagnosisRouteAgent` 已就位。本文档中的"文件变更清单"可能与实际实现有差异，保留作为设计参考。

## 目标

用户在客服聊天框（5173）输入问题 → 系统自动判断是否需要多 Agent 诊断 → 如果需要，聊天气泡内展示渐进式诊断过程（前端排查 → 后端升级 → 领导评分）→ 输出最终结论。

---

## 1. 总体架构

```
用户输入 "刷脸失败怎么办"
    │
    ▼
POST /api/agent/chat  （现有端点，不新增路由）
    │
    ▼
AgentRuntimeService.streamChat()
    │
    ├── 传统对话快通道（你好/谢谢/再见）→ 零延迟返回
    │
    ▼
QueryRouter.classify()
    │
    ├── SAFETY / HUMAN → 关键词规则（现有）
    ├── DIAGNOSIS        → 关键词规则 + LLM 确认（新增）
    └── CHAT / TASK      → LLM 路由（现有）
    │
    ▼
DIAGNOSIS → DiagnosisRouteAgent.execute()
    │
    ├── Step 1: 从模板 instantiate identity-diagnosis team
    ├── Step 2: teamService.runTeam() → 获取 TeamStreamEvent 迭代器
    ├── Step 3: 将 TeamStreamEvent 翻译为 RouteStreamEvent（新增事件类型）
    └── Step 4: 翻译后的 SSE 流推给前端
    │
    ▼
前端 useAgentChatStream
    │
    ├── 识别 diagnosis_* 事件类型
    ├── 在 assistant bubble 内渲染「诊断进度卡片」
    └── 卡片内容随 SSE 逐步更新
```

**核心决策：不新增 API 端点，不改变前端聊天入口。** 所有逻辑收敛在 `AgentRuntimeService` 内部，对前端来说仍然是 `POST /api/agent/chat`，只是 SSE 事件里多了一种 `diagnosis_*` 类型。

---

## 2. 后端改造

### 2.1 路由扩展：新增 DIAGNOSIS 路由

**文件：** `apps/server/src/services/agent-runtime/types.ts`

```typescript
// 现有：  "SAFETY" | "CHAT" | "TASK" | "HUMAN"
// 改为：
export type RouteName = "SAFETY" | "CHAT" | "TASK" | "HUMAN" | "DIAGNOSIS";
```

**文件：** `apps/server/src/services/agent-runtime/router.ts`

- `RouterDecisionSchema` 的 `z.enum` 新增 `"DIAGNOSIS"`
- 新增 L1 关键词规则（在 `quickRouteScan` 中）：

```typescript
const DIAGNOSIS_KEYWORDS = [
  // 强信号：错误码 + traceId
  /traceId\s*[:：]\s*\w+/i,
  /error[_ ]?code\s*[:：]\s*\w+/i,
  // 故障关键词
  /(报错|失败|超时|打不开|连不上|崩溃|闪退|白屏|卡死)/,
  /(排查|诊断|定位|帮我看下|帮我查下).*(问题|原因|怎么回事|什么情况)/,
  /(摄像头|麦克风|活体|刷脸|人脸|认证|识别).*(失败|打不开|不能用|没反应)/,
  /(WebSocket|网络|连接).*(断开|超时|失败)/,
];
```

L1 命中 → route: "DIAGNOSIS", confidence: 0.85。未命中但 LLM 判断为诊断类 → confidence 由 LLM 输出。

- `fallbackClassify` 中：IntentDetector 识别到特定意图（如"故障排查"）→ 也可路由到 DIAGNOSIS

### 2.2 新增 DiagnosisRouteAgent

**新文件：** `apps/server/src/services/agent-runtime/diagnosis-agent.ts`

实现 `RouteAgent` 接口，内部逻辑：

```typescript
export class DiagnosisRouteAgent implements RouteAgent {
  readonly route: RouteName = "DIAGNOSIS";

  async *execute(context: RouteContext, scope?: ExecutionScope): AsyncGenerator<RouteStreamEvent> {
    // 1. 发送 meta 事件（标注 route: "DIAGNOSIS"）
    yield { type: "meta", route: "DIAGNOSIS", ... };

    // 2. Instantiate identity-diagnosis team template
    const team = await teamService.createFromTemplate(
      AGENT_USER_ID,
      "identity-diagnosis",
      { name: `诊断-${context.sessionId}` }
    );

    // 3. 运行 Team，翻译事件流
    for await (const teamEvent of teamService.runTeam(
      team.id, AGENT_USER_ID, context.userMessage, {}, context.conversationId, scope
    )) {
      const chatEvent = translateTeamEvent(teamEvent);
      if (chatEvent) yield chatEvent;
    }

    // 4. 发送 done 事件
    yield { type: "done", ... };
  }
}
```

### 2.3 Team SSE → Chat SSE 事件翻译

**关键设计：新增 4 个 SSE 事件类型用于渐进式卡片渲染**

| Team SSE 事件 | Chat SSE 事件 | 前端渲染 |
|---|---|---|
| `team_started` | `type: "diagnosis_started"`, `agents: [...]` | 创建诊断卡片骨架 |
| `agent_started` (frontend_agent) | `type: "diagnosis_phase"`, `phase: 1`, `agent: "frontend_agent"` | 卡片显示「🔍 前端排查中…」 |
| `agent_completed` (frontend_agent) | `type: "diagnosis_phase_done"`, `phase: 1`, `output: ...` | 折叠 P1，展开 P2 |
| `agent_started` (backend_agent) | `type: "diagnosis_phase"`, `phase: 2` | 卡片显示「🖥 后端排查中…」 |
| `agent_completed` (backend_agent) | `type: "diagnosis_phase_done"`, `phase: 2` | 折叠 P2，展开 P3 |
| `agent_started` (leader) | `type: "diagnosis_phase"`, `phase: 3` | 卡片显示「📊 综合分析中…」 |
| `team_completed` | `type: "diagnosis_completed"`, `output: DiagnosisResult` | 渲染最终结论 |
| `agent_error` / `team_failed` | `type: "error"` | 错误提示 |

**不需要新增 `RouteStreamEvent` 类型**——在现有 `RouteStreamEvent` union 中增量添加这些 `type` 值即可。每个新类型的 data 格式在 `types.ts` 中定义。

### 2.4 AgentRuntimeService 集成

**文件：** `apps/server/src/services/agent-runtime.ts`

在 `agentRegistry` 中注册：

```typescript
this.agentRegistry = {
  SAFETY: this.safetyAgent,
  CHAT: this.chatAgent,
  TASK: this.agentExecutor,
  HUMAN: this.humanAgent,
  DIAGNOSIS: this.diagnosisAgent,  // 新增
};
```

### 2.5 兜底策略

| 场景 | 处理 |
|------|------|
| Team instantiate 失败 | 降级为普通 TASK Agent 处理 |
| 诊断过程中用户取消 | `scope.controller.shouldStop` → 中断 team run |
| 诊断超时（60s） | 中断，返回已有结果 + "诊断超时，建议转人工" |
| 模板缺失 | 降级为 TASK |
| 置信度 < 0.7 的 L2 分类 | 走普通 CHAT/TASK，不触发诊断 |

---

## 3. 前端改造

### 3.1 AgentMessage 类型扩展

**文件：** `packages/shared-types/src/agent-chat.ts`

```typescript
export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  knowledge?: KnowledgeResult[];
  contentBlocks?: ContentBlock[];
  // 新增：诊断过程数据
  diagnosis?: DiagnosisProgress;
}

export interface DiagnosisProgress {
  status: "running" | "done" | "error";
  phases: DiagnosisPhase[];
  resolution?: string;          // "frontend_only" | "adopt_backend" | "divergent" | "needs_human"
  finalConclusion?: string;     // 最终诊断结论文本
}

export interface DiagnosisPhase {
  phase: number;                // 1 | 2 | 3
  label: string;                // "前端排查" | "后端排查" | "综合分析"
  agent: string;                // "frontend_agent" | "backend_agent" | "leader"
  status: "pending" | "running" | "done";
  summary?: string;             // 完成后的一句话摘要
}
```

### 3.2 useAgentChatStream 改造

**文件：** `apps/customer-service/src/hooks/useAgentChatStream.ts`

在 SSE 消费循环中新增事件处理：

```typescript
// 在 for (const line of lines) 循环中

if (chunk.type === "diagnosis_started") {
  // 创建诊断进度对象，挂到当前 stream message 上
  setDiagnosisProgress({
    status: "running",
    phases: chunk.agents.map((a: {name: string, role: string}) => ({
      phase: a.name === "frontend_agent" ? 1 : a.name === "backend_agent" ? 2 : 3,
      label: a.role,
      agent: a.name,
      status: "pending",
    })),
  });
}

if (chunk.type === "diagnosis_phase") {
  // 更新指定 phase 为 running
  updatePhaseStatus(chunk.phase, "running");
}

if (chunk.type === "diagnosis_phase_done") {
  // 更新指定 phase 为 done，填入 summary
  updatePhaseStatus(chunk.phase, "done", chunk.summary);
}

if (chunk.type === "diagnosis_completed") {
  // 诊断完成
  setDiagnosisProgress(prev => ({
    ...prev,
    status: "done",
    resolution: chunk.output.resolution,
    finalConclusion: extractConclusion(chunk.output),
  }));
}
```

诊断进度作为 `AgentMessage` 的 `diagnosis` 字段存储，消息列表中的 assistant message 会携带这个字段。

### 3.3 诊断卡片组件

**新文件：** `apps/customer-service/src/components/chat/DiagnosisCard.tsx`

渲染逻辑：

```
┌─────────────────────────────────────────┐
│ 🔍 多 Agent 协同诊断                      │
│                                         │
│  ● Phase 1: 前端排查 ✓                  │
│    用户浏览器 NotAllowedError，           │
│    摄像头权限被拒绝，与后端无关            │
│                                         │
│  ○ Phase 2: 后端排查 (已跳过-快速通道)     │
│                                         │
│  ● Phase 3: 综合分析 ✓                  │
│    前端结论成立，无需后端介入              │
│                                         │
│  ─────────────────────────────          │
│  ✅ 结论：请在浏览器设置中允许摄像头权限    │
└─────────────────────────────────────────┘
```

状态动画：
- `pending` → 灰色圆点
- `running` → 蓝色旋转 spinner + 文字闪烁
- `done` → 绿色对勾 + 可展开看细节

### 3.4 RichMessageRenderer 集成

**文件：** `apps/customer-service/src/components/markdown/RichMessageRenderer.tsx`

在渲染 assistant message 时，如果 `message.diagnosis` 存在，优先渲染 `<DiagnosisCard>` 组件，再渲染后续的 markdown 文本。

---

## 4. 数据流示意（时序）

```
用户                浏览器              服务端
 |                   |                   |
 |  输入消息          |                   |
 |──────────────────>|                   |
 |                   | POST /api/agent/chat
 |                   |──────────────────>|
 |                   |                   | QueryRouter.classify()
 |                   |                   | → route: DIAGNOSIS
 |                   |                   |
 |                   |                   | DiagnosisRouteAgent.execute()
 |                   |                   | → instantiate template
 |                   |                   | → teamService.runTeam()
 |                   |                   |
 |                   | SSE: meta         |
 |                   |<──────────────────|
 |                   | SSE: diagnosis_started
 |                   |<──────────────────|
 |  显示诊断卡片骨架   |                   |
 |                   | SSE: diagnosis_phase (P1 running)
 |                   |<──────────────────|
 |  卡片更新: P1 执行中|                   |
 |                   |                   | Phase 1: Frontend Agent
 |                   |                   | → 调用 mock 工具
 |                   |                   | → 输出结论
 |                   |                   |
 |                   | SSE: diagnosis_phase_done (P1)
 |                   |<──────────────────|
 |  卡片更新: P1 ✓    |                   |
 |                   |                   |
 |                   |                   | checkRuleEscalation()
 |                   |                   | → need_escalation: false
 |                   |                   | → Fast Track!
 |                   |                   |
 |                   | SSE: diagnosis_completed
 |                   |<──────────────────|
 |  卡片更新: 最终结论 |                   |
 |                   | SSE: done         |
 |                   |<──────────────────|
 |  显示完整结论       |                   |
```

---

## 5. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/server/src/services/agent-runtime/types.ts` | 改 | RouteName 新增 "DIAGNOSIS"；RouteStreamEvent 新增 diagnosis_* 类型 |
| `apps/server/src/services/agent-runtime/router.ts` | 改 | L1 诊断关键词；RouterDecisionSchema 新增 DIAGNOSIS |
| `apps/server/src/services/agent-runtime/diagnosis-agent.ts` | **新建** | DiagnosisRouteAgent 实现 |
| `apps/server/src/services/agent-runtime.ts` | 改 | 注册 DiagnosisRouteAgent |
| `packages/shared-types/src/agent-chat.ts` | 改 | AgentMessage 新增 diagnosis 字段 |
| `apps/customer-service/src/hooks/useAgentChatStream.ts` | 改 | 消费 diagnosis_* SSE 事件 |
| `apps/customer-service/src/components/chat/DiagnosisCard.tsx` | **新建** | 诊断进度卡片组件 |
| `apps/customer-service/src/components/markdown/RichMessageRenderer.tsx` | 改 | 渲染 DiagnosisCard |

**预计净增代码：~400 行（后端 200 + 前端 150 + 类型 50）**

---

## 6. 测试策略

### 后端
- `router.test.ts`：新增诊断关键词命中/LLM 分类测试
- `diagnosis-agent.test.ts`：Team SSE → Chat SSE 翻译正确性
- 集成测试：Mock AgentService，验证端到端 SSE 流

### 前端
- 手动验证 3 个场景（快速通道/升级通道/信息不足）
- 验证取消中断
- 验证会话历史中诊断卡片正确回显

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 诊断耗时过长（LLM 多轮调用） | 前端显示进度卡片让用户感知进展；超时 60s 兜底 |
| 分类误判（不该诊断的走了诊断） | L1 关键词偏保守，L2 LLM 阈值 0.7；误触发时用户可点"取消诊断" |
| 模板依赖硬编码 agent 名称 | DiagnosisRouteAgent 直接构造 context，不依赖模板持久化 |
| SSE 事件翻译丢失信息 | TeamStreamEvent 的 key 字段原样保留在 diagnosis_* 事件中 |
