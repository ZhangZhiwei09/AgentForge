# AgentForge Knowledge Agent Runtime —— 重构方案

> **状态：已完成 ✅** | 2026-06-16
>
> 本文档定义 `customer-chat` 模块重构为 `agent-runtime` 的完整方案。
> 从电商客服 Demo 升级为可扩展的 Knowledge Agent Runtime。

---

## 1. Context

当前 `customer-chat` 模块是一个电商物流客服 Demo（虚假订单数据 + 查物流/退换货工具 + 视频客服）。但它的架构内核 —— ToolRegistry、ReAct Agent、Citation Pipeline、ContentBlock、SSE Streaming —— 已经是一个 Agent Runtime 的雏形。

这次改造的定位不是"换个 Prompt 删掉订单模块"，而是**将领域模型从 Customer Service 提升到 Agent Runtime**，让同一套 Runtime 可以跑：电商客服、政务客服、IT Helpdesk、运维助手、HR 助手等任何知识库 + 工具驱动的 Agent 场景。

---

## 2. 目标架构

```
用户消息 → Rule First 快速路由（SAFETY / HUMAN 关键词命中）
         → Router LLM 分类（SAFETY / CHAT / TASK / HUMAN）
         → 对应执行：
              SAFETY → SafetyAgent（零 LLM，拒绝消息）
              CHAT   → ChatAgent（简单 LLM 对话，不查 KB，不调工具）
              TASK   → AgentExecutor（统一入口）
                         ├── ReAct 循环
                         ├── 工具：Builtin (search_knowledge_base) + Business (动态注册)
                         ├── KnowledgeContext（结构化 KB 检索上下文）
                         └── CitationVerifier（反幻觉校验）
              HUMAN  → HumanAgent（工单 + 转接话术）
         → ContentBlock SSE 流式返回（token + 富媒体卡片）
```

**核心收敛：** Router 只做 Intent 分类（SAFETY/CHAT/TASK/HUMAN），不替 Agent 决定执行策略。TASK 路由下 AgentExecutor 在 ReAct 循环中自主判断——可能只搜 KB、可能只调 Business Tool、也可能 KB + Tool 组合。

---

## 3. 核心设计决策

### 3.1 命名重构：`customer-chat` → `agent-runtime`

```
services/customer-chat/  →  services/agent-runtime/
routes/customer-chat.ts  →  routes/agent-runtime.ts
POST /api/customer-chat  →  POST /api/agent/chat
```

代码语义必须匹配架构定位。面试官打开代码看到 `customer-chat` 会觉得"这是个客服项目"，看到 `agent-runtime` 才会问"你这个 Runtime 怎么设计的"。

### 3.2 路由收敛：4 分类（语义升级）

```
旧: SAFETY | SMALL_TALK | TOOL | HUMAN
新: SAFETY | CHAT | TASK | HUMAN
```

| 路由 | 触发条件 | 执行方式 |
|------|---------|---------|
| `SAFETY` | 越狱/攻击/违规 | 零延迟拒绝（无 LLM） |
| `CHAT` | 问候/感谢/闲聊/能力询问 | 简单 LLM 对话，不查 KB，不调工具 |
| `TASK` | 所有业务问题 | 进入 AgentExecutor，Agent 自主决定：搜 KB、调 Business Tools、或组合使用 |
| `HUMAN` | 明确要求转人工/投诉升级 | 创建工单 + 转接话术 |

**不拆 KNOWLEDGE / ACTION。** 因为"查支付系统最近的错误率"既需要 KB（架构文档）又需要工具（query_prometheus），Intent 无法二选一。TASK 统一进入 AgentExecutor，工具选择权交还给 Agent 的 ReAct 循环。

### 3.3 工具分层：Builtin vs Business

```
Tools/
├── Builtin（Runtime 核心，始终可用）
│   └── search_knowledge_base    — KB 检索是任何知识 Agent 的基础能力
│
├── Business（业务工具，按场景注册，Agent 自主选择调用）
│   ├── create_support_ticket    — 工单（IT Helpdesk / 客服场景）
│   ├── query_monitoring         — 监控查询（运维场景，MCP）
│   ├── check_deploy_status      — 部署状态（DevOps 场景，MCP）
│   └── ...                      — 任意 MCP/API 工具，实现 RegisteredTool 即插即用
```

**`create_support_ticket` 不再是内置工具。** 它是 Business Tool，工单是一个业务概念，不是每个 Runtime 场景都需要。

### 3.4 AgentExecutor —— 唯一的 Agent 执行器

**不拆 `knowledge-agent.ts` / `action-agent.ts`。** 两者 ReAct 循环、Tool Calling、Memory、Validation、SSE Streaming 逻辑完全一致，唯一区别是工具集。统一为 `AgentExecutor`：

```typescript
AgentExecutor.run({
  tools: ToolRegistry.getAvailable(),   // 动态工具集
  context: RouteContext,                // 含 KnowledgeContext
  route: RouteName,                     // 透传，仅用于日志/指标
})
```

以后增加任何新场景（监控助手、HR 助手、IT Helpdesk），不需要新建 Agent 文件，只需要注册新工具到 ToolRegistry。

### 3.5 KnowledgeContext 层

Agent 不直接消费 `search_knowledge_base` 的原始 JSON 输出，中间插入一层 `KnowledgeContext`：

```
search_knowledge_base 工具结果
        ↓
KnowledgeContextBuilder.build(results)
        ↓
{
  docs:       Document[]      // 去重 + 排序后的文档列表
  citations:  Citation[]      // 每条文档的引用锚点
  confidence: number          // 检索置信度 0-1
  gaps:       string[]        // 用户问题中未覆盖的方面
  summary:    string          // 给 Agent 的结构化上下文摘要
}
        ↓
AgentExecutor 基于 KnowledgeContext 推理 + 回复
```

**收益：**
- Citation Pipeline 不再需要从 tool result string 中重新解析 KB chunks —— 直接从 KnowledgeContext 取
- 检索置信度 < 阈值时，Agent 不会强行"编造"答案
- 未来多 Knowledge Source（KB + Confluence + 内部文档）统一合并到一个 Context

### 3.6 保留的核心资产

| 模块 | 保留理由 | 加强方向 |
|------|---------|---------|
| **ToolRegistry** | 动态工具注册是平台化的基础设施 | 文档化 `RegisteredTool` 接口，按 `category` 分层查询 |
| **CitationVerifier** | 区别于普通 RAG Demo 的关键 | 从 tool result parse 升级为从 KnowledgeContext 直接消费 |
| **ContentBlock** | 富媒体输出通道 | 保留骨架，未来 VideoBlock/TableBlock/ImageBlock 统一挂载 |
| **5 层校验管线** | 幻觉控制的工程实现 | Layer 5 关键词从电商替换为通用业务词 |
| **ReAct Agent + SSE Streaming** | 完整的 Agent 推理 + 流式交付 | 不变 |
| **MemoryEngine** | 跨会话记忆 | 不变 |
| **Safety Guardrail** | 多语言 prompt injection 检测 | 不变 |

---

## 4. 文件变更清单

### 4.1 删除（整个文件）

| 文件 | 原因 |
|------|------|
| `services/customer-chat/order-service.ts` | 虚假种子数据 + 物流模拟 |
| `services/customer-video.ts` | 视频客服（不是本期范围） |
| `routes/customer-video.ts` | 视频路由 |
| `tools/customer-service-tools.ts` | 含 4 个电商工具，重建为 Builtin + Business 分层 |
| `web/.../CustomerVideoCall.tsx` | 视频通话 UI |
| `web/.../CustomerServiceDashboard.tsx` | 电商运营面板 |
| `web/.../CustomerFeedbackPanel.tsx` | 电商反馈面板 |
| `web/.../admin/CSAdminPage.tsx` | 电商管理后台 |
| `web/.../cards/OrderCard.tsx` | 电商订单卡片 |
| `web/.../cards/StatusCard.tsx` | 电商物流卡片 |
| `web/.../cards/PolicyCard.tsx` | 电商退换货卡片 |
| `services/customer-chat/decisions/` (4 ADR) | 旧架构决策文档 |

### 4.2 重命名（目录 + 文件 + 路由）

| 旧路径/名称 | 新路径/名称 |
|------------|-----------|
| `services/customer-chat/` | `services/agent-runtime/` |
| `services/customer-chat.ts` | `services/agent-runtime.ts` (orchestrator) |
| `routes/customer-chat.ts` | `routes/agent-runtime.ts` |
| `POST /api/customer-chat` | `POST /api/agent/chat` |
| `GET /api/customer-chat/history` | `GET /api/agent/chat/history` |
| `POST /api/customer-chat/rate` | `POST /api/agent/chat/rate` |
| 前端 `useCustomerChatStream.ts` | `useAgentChatStream.ts` |
| 前端 `CustomerChatPage.tsx` | `AgentChatPage.tsx` |
| 前端 `CustomerChat.tsx` | `AgentChatWidget.tsx` |
| 测试 `customer-chat-unit.test.ts` | `agent-runtime-unit.test.ts` |
| 测试 `customer-chat-quality.test.ts` | `agent-runtime-quality.test.ts` |
| 类型 `shared-types/src/customer-chat.ts` | `shared-types/src/agent-chat.ts` |

### 4.3 修改（关键文件）

**Agent Runtime 核心：**

| 文件 | 变更 |
|------|------|
| `services/agent-runtime/types.ts` | `RouteName` → `"SAFETY" \| "CHAT" \| "TASK" \| "HUMAN"`；移除 `ToolCallRecord`；保留 `ContentBlock` |
| `services/agent-runtime/router.ts` | Router Prompt 按 4 分类重写；移除电商映射；默认 → `TASK`；Router 不推荐工具列表 |
| `services/agent-runtime/agent-executor.ts` (原 `tool-agent.ts`) | 统一 AgentExecutor；移除电商卡片提取；保留 ContentBlock；工具从 ToolRegistry 动态获取 |
| `services/agent-runtime/chat-agent.ts` (原 `smalltalk-agent.ts`) | System Prompt 去电商化 |
| `services/agent-runtime/safety-agent.ts` | 基本不变 |
| `services/agent-runtime/human-agent.ts` | 去电商话术；调用 Business Tool `create_ticket` |
| `services/agent-runtime/validation.ts` | Layer 5 关键词替换为通用业务词 |
| `services/agent-runtime/knowledge-context.ts` (原 `business-agent.ts`) | 重构为 `KnowledgeContextBuilder` |
| `services/agent-runtime.ts` (orchestrator) | 去除电商问候语；路由调度适配 4 分类；TASK → AgentExecutor |

**工具层：**

| 文件 | 变更 |
|------|------|
| `tools/builtin/search-knowledge-base.ts` | 从旧文件迁移，独立为 Builtin 工具 |
| `tools/business/create-ticket.ts` | 通用工单，不依赖 OrderService，写 DB |
| `tools/registry.ts` | 按 `category` 区分 `builtin` / `business`；新增 `getToolsByCategory()` |

**前端：**

| 文件 | 变更 |
|------|------|
| `web/.../AgentChatPage.tsx` | 移除视频按钮、Dashboard 按钮 |
| `web/.../AgentChatWidget.tsx` | 嵌入式 Widget 形态 |
| `web/.../WelcomeScreen.tsx` | 重写：从 KB API 加载热门话题 |
| `web/.../SatisfactionRating.tsx` | 保留，简化 |
| `web/src/App.tsx` | 路由 `/*` → `AgentChatPage`；移除 `/admin/cs`；移除 Video 引用 |
| `web/.../RichMessageRenderer.tsx` | 移除 OrderCard/StatusCard/PolicyCard 分支，保留 ContentBlock switch |

**基础设施：**

| 文件 | 变更 |
|------|------|
| `server/src/app.ts` | 移除 `customerVideoRoutes`；挂载 `agentRuntimeRoutes` |
| `server/src/index.ts` | 移除视频 WebSocket upgrade |
| `observability/metrics.ts` | 指标 `cs_*` → `agent_*` |
| `database/prisma/schema.prisma` | 新增 `support_tickets` 表；conversations.type → `agent_chat` |

---

## 5. 最终目录结构

```
apps/server/src/
├── services/
│   ├── agent-runtime/              ← 原 customer-chat/
│   │   ├── types.ts                ← RouteName: SAFETY|CHAT|TASK|HUMAN
│   │   ├── router.ts               ← QueryRouter（4 分类）
│   │   ├── safety-agent.ts
│   │   ├── chat-agent.ts           ← 原 smalltalk-agent.ts
│   │   ├── agent-executor.ts       ← 原 tool-agent.ts，TASK 唯一执行器
│   │   ├── human-agent.ts
│   │   ├── validation.ts
│   │   ├── citation-verifier.ts
│   │   ├── knowledge-context.ts    ← 原 business-agent.ts，KnowledgeContextBuilder
│   │   └── decisions/
│   └── agent-runtime.ts            ← orchestrator
├── tools/
│   ├── registry.ts                 ← ToolRegistry（增强 category 查询）
│   ├── builtin/
│   │   └── search-knowledge-base.ts
│   └── business/
│       └── create-ticket.ts
├── routes/
│   └── agent-runtime.ts
└── __tests__/
    ├── agent-runtime-unit.test.ts
    ├── agent-runtime-quality.test.ts
    └── knowledge-context.test.ts

apps/web/src/
├── components/
│   ├── agent-chat/                 ← 原 customer-chat/
│   │   ├── AgentChatPage.tsx
│   │   ├── AgentChatWidget.tsx
│   │   ├── WelcomeScreen.tsx
│   │   ├── FAQSidebar.tsx
│   │   ├── QuickReplies.tsx
│   │   ├── SatisfactionRating.tsx
│   │   └── ChatSessionInfo.tsx
│   └── markdown/
│       ├── RichMessageRenderer.tsx  ← 保留 ContentBlock 通道
│       └── cards/
│           └── ActionCard.tsx       ← 保留，未来扩展 VideoCard/TableCard
└── hooks/
    └── useAgentChatStream.ts       ← 原 useCustomerChatStream.ts
```

**结构对比：**

```
旧: customer-chat/
    ├── tool-agent.ts           → 旧 tool-agent (TOOL 路由，电商工具)
    ├── smalltalk-agent.ts
    ├── business-agent.ts       → KB 检索 + Memory（混合职责）
    ├── order-service.ts        → 虚假电商数据
    └── ...

新: agent-runtime/
    ├── agent-executor.ts       → 统一 TASK 执行器
    ├── chat-agent.ts
    ├── knowledge-context.ts    → 职责单一：结构化 KB 上下文
    └── ...
```

---

## 6. 实施步骤

### Step 1: 重命名 —— 目录 + 文件 + 路由 + 导出

先把 `customer-chat` 重命名为 `agent-runtime`：
- 目录 `services/customer-chat/` → `services/agent-runtime/`
- 所有内部文件名和 class 名
- 路由路径 `/api/customer-chat` → `/api/agent/chat`
- 前端 hook、组件、类型
- 全局搜索替换所有 import 路径

**注意：** 这一步只做重命名，不改逻辑。确保 typecheck 通过后再进下一步。

### Step 2: 工具分层 —— Builtin / Business

- 新建 `tools/builtin/search-knowledge-base.ts`，迁移 `search_knowledge_base`
- 新建 `tools/business/create-ticket.ts`，通用工单创建（Prisma `support_tickets` 表）
- 更新 `tools/registry.ts`，增加 `category` 字段查询
- 删除 `tools/customer-service-tools.ts`
- 删除 `services/agent-runtime/order-service.ts`

### Step 3: KnowledgeContext 层

- 新建 `services/agent-runtime/knowledge-context.ts`
- 实现 `KnowledgeContextBuilder`：去重 + 质量分级 + 结构化输出
- AgentExecutor 的 System Prompt 改为接收 `{knowledge_context}` 结构化注入
- CitationVerifier 改为从 KnowledgeContext 直接消费

### Step 4: Router 收敛 —— 4 分类

- `types.ts`: `RouteName` → `"SAFETY" | "CHAT" | "TASK" | "HUMAN"`
- Router Prompt 按 4 分类重写
- TASK 涵盖所有业务问题；默认 → TASK
- Router 不再输出 `toolHints` / `execution_order`（工具选择权还给 AgentExecutor）

### Step 5: AgentExecutor —— 统一执行器

- `tool-agent.ts` → `agent-executor.ts`
- `class AgentExecutor` 实现 `RouteAgent` 接口
- 工具列表从 `ToolRegistry.getAvailable()` 动态获取
- ReAct 循环、ContentBlock yield、KnowledgeContext、Citation 校验全部在同一个类中

### Step 6: 清理 orchestrator

- 移除电商 `CONVERSATIONAL_RULES`
- 移除 `SERVICE_HOURS_*` / `SERVICE_DAYS`（或改为通用配置）
- 适配 4 路由调度
- 集成 `KnowledgeContextBuilder`

### Step 7: 删除视频客服

- 删除 `customer-video.ts`（service + routes）
- 删除 `CustomerVideoCall.tsx`
- 清理 `index.ts` 和 `app.ts` 中的视频相关引用

### Step 8: 清理前端

- 删除 3 个电商卡片组件
- 删除 `CustomerServiceDashboard.tsx`、`CustomerFeedbackPanel.tsx`、`CSAdminPage.tsx`
- 重写 `WelcomeScreen.tsx`（从 KB 加载话题）
- 更新 `RichMessageRenderer.tsx`（移除电商卡片分支，保留 ContentBlock switch）
- 更新 `App.tsx` 路由

### Step 9: 测试 + 类型 + Lint

- 重命名 + 更新已有测试
- 新建 `knowledge-context.test.ts`
- 确保 `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm build` 全部通过

### Step 10: 文档更新

- CLAUDE.md 更新
- plan.md 更新
- 新建 `decisions/001-agent-runtime-architecture.md`

---

## 7. 验证计划

```bash
# 1. 类型检查
pnpm typecheck

# 2. 全量测试
pnpm --filter @agentforge/server test

# 3. 构建
pnpm build

# 4. Lint
pnpm lint

# 5. 启动验证
pnpm dev
# → 客服页面可正常访问
# → "你好" → CHAT 路由 → 通用问候
# → 知识库问题 → TASK 路由 → AgentExecutor + KB search → 带 Citation 的回复
# → "转人工" → HUMAN 路由 → 工单 + 转接
# → 越狱攻击 → SAFETY 路由 → 拒绝
# → 确认无视频按钮、无订单/物流 UI、无电商话术
```

---

## 8. 简历定位建议

改造完成后，项目描述建议从：

> "基于 RAG 的智能客服系统"

升级为：

> **AgentForge Knowledge Agent Runtime** —— 可扩展的知识驱动 Agent 平台
>
> - 设计 **ToolRegistry 动态工具注册体系**，支持 Builtin 工具（Knowledge Search）和 Business 工具（Ticket、监控、部署等 MCP 服务）统一接入
> - 实现 **4 路由 Agent 分类器**（SAFETY / CHAT / TASK / HUMAN），Rule-First + LLM Fallback 混合决策，TASK 路由下 Agent 自主选择知识库 + 工具组合
> - 构建 **KnowledgeContext 抽象层**，将原始检索结果封装为结构化上下文（docs + citations + confidence + gaps），Agent 基于 Context 推理而非直接消费 Tool 输出
> - 实现 **Citation Validation Pipeline**（5 层校验 + 语义引证对齐），通过逐句余弦相似度检测降低 RAG 幻觉
> - 设计 **ContentBlock 富媒体协议**，支持文本、表格、视频等结构化知识呈现
> - 基于 **ReAct 循环 + SSE Streaming** 实现 Agent 推理过程实时可见
