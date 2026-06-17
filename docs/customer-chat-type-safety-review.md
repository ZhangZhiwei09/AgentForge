# 智能客服模块类型安全改造方案 -- 架构审查

**审查日期**: 2026-06-17
**审查范围**: `CustomerChat.tsx`, `useCustomerChatStream.ts`, `FAQSidebar.tsx`, `customer-chat.ts`, `content-block.ts`

---

## 总体评价

方案正确识别了 SSE chunk 解析处 `JSON.parse` 产生 `any` 的根因问题，提出的 Zod Schema 边界校验策略与项目 `docs/engineering/type-safety.md` 规范对齐。但方案存在四个严重问题：对 SSE 协议类型认知有误（声称 7 种 chunk 类型，实际后端契约仅定义 5 种）、未识别前后端协议不一致（前端处理 `tool_call`/`tool_result` 但后端 RouteStreamEvent 不含这两种）、忽略了两个文件中 ~90% 重复的 SSE 解析逻辑、未考虑 shared-types 包引入 Zod 依赖的架构影响。**REWORK_REQUIRED**。

---

## 严重问题（必须修复才能 APPROVED）

### 问题 1：SSE Chunk 类型定义与实际后端协议不一致

- **问题描述**：方案声称需覆盖 "meta/token/tool_call/tool_result/content_block/done/error" 七种 chunk 类型。但经审查后端源码：
  - `apps/server/src/services/agent-runtime/types.ts` 定义的 `RouteStreamEvent` 联合类型仅包含 5 种：`meta | token | done | content_block | error`
  - `apps/server/src/providers/types.ts` 定义的 `StreamChunk` 仅包含 3 种：`token | tool_call | done`
  - `tool_call` 和 `tool_result` 定义在 `packages/shared-types/src/tool.ts` 中，但**未包含在任何后端 SSE 流事件联合类型中**
  - `AgentExecutor.execute()` 和 `ChatAgent.execute()` 的返回类型均为 `AsyncGenerator<RouteStreamEvent>`，不包含 `tool_call`/`tool_result`
  - 后端 `AgentRuntimeService.streamChat()` 的返回类型（line 207）甚至是 `AsyncGenerator<Record<string, unknown>>` -- 这是后端自身的类型漏洞
- **根本原因**：方案基于对前端消费代码的反向推测来定义 Schema，而未审查后端实际的事件发射契约。这导致 Schema 与实际协议之间存在 Gap。
- **风险**：
  - 如果 `tool_call`/`tool_result` 在 customer-chat 场景下实际**不会**被发射，则对应的 Zod schema variant 永远不会匹配（死代码），且会增加 Schema 维护负担
  - 如果 `tool_call`/`tool_result` 确实在某些路由（如 TASK 路由经过 AgentService 处理后再发射）被发射，则后端的 `RouteStreamEvent` 类型定义存在 bug（类型声明与实际运行时行为不一致）
  - 无论哪种情况，基于不准确的协议认知构建的 Zod Schema 都将是脆弱的
- **建议**：
  1. 先与后端团队确认 customer-chat SSE 流的实际事件类型，比对 `agent-executor.ts:138-260` 的事件映射逻辑
  2. 如果实际只有 5 种类型，修正 Schema 为 5 种 Discriminated Union
  3. 如果实际有 7 种，请先修复后端的 `RouteStreamEvent` 类型定义和 `streamChat` 返回类型，然后前端再跟进
  4. 建议在 shared-types 中定义统一的 `CustomerChatSSEChunk` 类型（而非仅依赖 Zod schema），作为前后端共享的契约

### 问题 2：`/api/customer-chat` 端点在后端不存在

- **问题描述**：前端 `CustomerChat.tsx:122` 和 `useCustomerChatStream.ts:115` 均调用 `/api/customer-chat`，但在服务端路由代码中搜索该路径无结果。实际存在的路由是 `/api/agent/chat`（在 `agent-runtime.ts` 中定义）。FAQSidebar 则调用 `/api/agent/chat/faq*`。
- **风险**：
  - 如果 `/api/customer-chat` 通过 Vite proxy 或反向代理映射到 `/api/agent/chat`，则实际 SSE 协议是 Agent Runtime 协议而非专用的 customer-chat 协议
  - 如果该端点确实不存在，则前端功能完全无法工作（这意味着测试覆盖有盲区）
  - 无论哪种情况，在未澄清路由映射关系之前，无法确定 Zod Schema 应该校验的数据格式
- **建议**：检查 Vite 配置或反向代理规则，确认 `/api/customer-chat` 的实际后端对应端点。如果映射到 `/api/agent/chat`，则应使用统一的 AgentRuntime SSE Schema。

### 问题 3：shared-types 引入 Zod 依赖的架构影响

- **问题描述**：方案要求在 `packages/shared-types` 中定义 Zod Schema。审查发现该包当前 `package.json` 仅依赖 `typescript` -- 无 Zod 依赖（Zod 仅在 `apps/server` 中使用）。引入 Zod 会导致：
  - 所有消费 shared-types 的包（包括纯类型消费方）都会间接获取 Zod 作为传递依赖
  - shared-types 的角色从"纯类型定义包"变为"运行时校验包"
- **风险**：
  - 破坏了 shared-types 包的单一职责
  - 前端 bundle 中引入 Zod（~12KB gzip）作为运行时依赖
  - 如果未来有其他共享类型包需要类似的运行时校验，会导致依赖膨胀
- **建议**：
  - 方案 A（推荐）：将 Schema 定义在消费方（`apps/web` 下），或新建 `packages/shared-schemas` 包
  - 方案 B：如果确定要在 shared-types 中引入 Zod，需要在设计文档中说明理由，并评估前端 bundle size 影响
  - 方案 C：使用手写 Type Guard（判别 `type` 字段 + `in` 操作符收窄），无需额外依赖，与项目已存在的 `type-safety.md` 中"优先 Zod，但 Type Guard 也是合法选项"的指引一致

### 问题 4：CustomerChat.tsx 与 useCustomerChatStream.ts 存在约 90% 重复的 SSE 解析逻辑

- **问题描述**：两个文件包含几乎完全相同的 SSE 读取、行分割、JSON 解析、7 种 chunk 类型分发的逻辑（约 150 行重复代码）。方案要求在这两个位置各自实施 `safeParse`。
- **风险**：
  - 两个文件各自维护 Zod Schema 的 `safeParse` 调用，将来协议变更需要双倍修改
  - 容易出现两个文件的 Schema 或错误处理逻辑不一致的漂移
  - 增加维护成本和出错概率
- **建议**：
  - 在实施类型安全改造之前，先将 SSE 解析逻辑抽取到一个共享 hook 或工具函数中
  - 注意：`useCustomerChatStream.ts` 是 hook（有状态管理），而 `CustomerChat.tsx` 直接在组件内实现 -- 这两者是否应该统一为一种模式？
  - 如果 `CustomerChat.tsx` 是旧实现而 `useCustomerChatStream.ts` 是重构版本，应确认哪个是主实现，消除冗余副本

---

## 重要问题（应该修复）

### 问题 5：`loadHistory()` API 响应校验被遗漏

- **问题描述**：`useCustomerChatStream.ts:48-62` 的 `loadHistory` 函数中，`data.messages` 直接断言为 `{id, role, content, timestamp}[]`，其中 `m.role as "user" | "assistant"` 是裸类型断言。方案未提及对历史消息 API 响应的校验。
- **原因**：`res.json()` 返回值是 `any`，且此数据源于 Prisma 查询结果经过 JSON 序列化，属于 `type-safety.md` 要求校验的外部数据源（HTTP Response）。
- **风险**：若后端数据格式变更或数据库中出现异常 role 值，前端会在运行时产生不可预期的行为。
- **建议**：增加 History API 响应的 Zod Schema 校验，或至少为 `m.role` 添加 Type Guard。

### 问题 6：`blockKey` 函数的 exhaustiveness 问题未被方案真正解决

- **问题描述**：方案声称通过"穷尽 switch/case + TS exhaustiveness check"替代 `blockKey` 中的 `as unknown as Record<string, unknown>`。但 `ContentBlock` 联合类型包含 6 种成员（text/order_card/policy_card/action_card/status_card/table），且属于开放扩展类型（未来会增加新卡片类型）。`blockKey` 的 fallthrough 分支是特意设计的合理降级（对未知类型用 JSON.stringify 做唯一性标记），而非类型安全问题。
- **原因**：TypeScript exhaustiveness check 要求覆盖所有 union 成员，当后端新增 ContentBlock 类型时，前端如果未同步更新（典型的前后端分离开发场景），exhaustive switch 会导致编译失败，反而阻塞开发流程。
- **风险**：
  - 过于严格地追求 exhaustiveness 可能导致开发体验下降
  - JSON.stringify 作为 fallback 是合理的防御性策略，不应被视为需要消除的类型安全问题
- **建议**：
  - 保留 fallback 逻辑，但改为更明确的类型收窄方式：对已知类型使用 switch，对 `text` 和 `table` 类型补充明确的 key 生成逻辑，对 fallthrough 添加 `// SAFE: fallback for future ContentBlock types` 注释
  - 参考 `type-safety.md` 中对例外处理的规范：有明确注释的 fallback 可以接受

### 问题 7：方案对死代码处理缺乏策略

- **问题描述**：如果 `tool_call`/`tool_result` 事件在 customer-chat SSE 流中实际不出现（见严重问题 1），则前端中约 60 行处理这两个类型的代码（包括 `toolCalls` 状态管理、`chunk.tool_result!.tool_call_id` 非空断言等）为死代码。
- **风险**：方案如果为不存在的 chunk 类型定义了 Zod Schema，这些 Schema 永远不会被激活，造成维护负担和认知误导。
- **建议**：在确认实际协议后，如果 `tool_call`/`tool_result` 不应在 customer-chat 中出现，则删除前端相关死代码，而非为其定义 Zod Schema。

### 问题 8：空 catch 处理粒度不一致

- **问题描述**：方案声称"所有空 catch 添加 console.error"，但实际空 catch 场景有三个不同层级：
  1. SSE JSON parse 失败（line 307/305）：`catch { continue; }` -- 跳过损坏 chunk
  2. `loadHistory` 失败（line 74/76）：`catch {}` -- 静默回退到默认欢迎消息
  3. FAQ `loadDocDetail` 失败（line 83）：`catch { setDocContent("加载失败"); }` -- 有用户可见降级但无日志
- **原因**：这三种 catch 的语义不同 -- SSE chunk 跳过是正常降级（网络乱码），history 加载失败是合法场景（新用户无历史），FAQ 加载失败需要用户可见降级。
- **风险**：简单地全部加上 `console.error` 会导致正常的降级场景产生噪音日志。
- **建议**：
  - SSE JSON parse 失败：使用 `console.warn`（非错误，预期内的降级）
  - `loadHistory` 失败：添加 `console.warn` + 区分网络错误（应重试）和空历史（合法）
  - FAQ `loadDocDetail` 失败：已有用户可见降级，加 `console.error` 用于运维排查即可

---

## 建议优化（可选修复）

### 优化 1：Zod Schema 与后端契约的同步机制

- **问题描述**：方案未讨论当后端 SSE 协议变更时如何确保前端 Zod Schema 同步更新。
- **建议**：
  - 将 Schema 定义在 shared-types 或 shared-schemas 包中，作为单一事实来源
  - 后端和前端都从此包导入类型 + Schema
  - 可选：在 CI 中添加 contract test，验证后端实际发射的事件结构符合 Schema 定义

### 优化 2：SSE chunk 性能考量

- **问题描述**：SSE token 流中每个 token chunk 都需经过 `Zod.safeParse`。虽然 Zod 解析速度通常足够（单次 < 0.1ms），但在长回复（数百个 token）场景下累计开销值得评估。
- **建议**：
  - 对最高频的 `token` 类型使用轻量 Type Guard（检查 `typeof chunk.type === "string" && chunk.type === "token" && typeof chunk.content === "string"`），其他低频类型使用 Zod
  - 或使用 Zod 的预编译 schema + `z.object().passthrough()` 减少解析开销
  - 前提：先通过 profiling 确认 Zod 确实是瓶颈

### 优化 3：FAQ API 响应校验

- **问题描述**：FAQSidebar 有三处 `res.json()` 未校验（categories、documents、doc detail），方案仅提到"添加 Zod schema 校验"但未给出具体设计。
- **建议**：
  - FAQ 的 API 响应（categories、documents）对应后端的 `/api/agent/chat/faq*` 路由，应直接使用 Prisma 推导出来的类型作为 Zod schema 的 source of truth
  - `docList as FAQDocument[]` 的断言应改为 `FAQDocumentArraySchema.safeParse(docList)`

### 优化 4：`CustomerChat.tsx` vs `useCustomerChatStream.ts` 的架构选择

- **问题描述**：两个文件提供了几乎相同的功能，但是否两者都在使用中？`CustomerChat.tsx` 直接在组件中实现 SSE 逻辑，`useCustomerChatStream.ts` 是自定义 hook。这与项目的"最小改动"重构原则相关。
- **建议**：在类型安全改造前确认两者的使用关系和演进方向。如果 `useCustomerChatStream` 是新架构而 `CustomerChat.tsx` 是遗留代码，则应优先改造 hook 版本并逐步废弃组件内实现。

---

## 审核结论

**REWORK_REQUIRED**

需要解决以下问题后才能进入 Implementation 阶段：

1. **[严重]** 确认 customer-chat SSE 流的实际事件类型（与后端团队对齐），基于实际协议修正 Zod Schema 的 Discriminated Union 成员（当前声称 7 种，后端契约仅 5 种）
2. **[严重]** 澄清 `/api/customer-chat` 的路由映射关系，确认实际的后端端点
3. **[严重]** 决定 Zod Schema 的放置位置：shared-types / shared-schemas / apps/web，需说明架构理由
4. **[严重]** 先消除 `CustomerChat.tsx` 与 `useCustomerChatStream.ts` 的 SSE 解析代码重复，再将类型安全改造应用于单一实现
5. **[重要]** 补充 History API 响应校验方案
6. **[重要]** 补充关于 `blockKey` 中合理 fallback 的处理策略（区分类型安全问题和防御性编程）
7. **[重要]** 提供空 catch 的分级处理策略（warn / error / 保留静默但加注释）

---

*审查标准：`docs/engineering/type-safety.md`, `CLAUDE.md` 架构规范*
