# AgentForge

渐进式 AI Agent 平台。pnpm + Turborepo monorepo。

## Architecture

Agent Runtime 是系统核心。统一 `AgentExecutor`（ReAct），5-route 分类器（SAFETY/CHAT/TASK/HUMAN/DIAGNOSIS）。新增能力必须复用现有 Runtime，禁止绕过 Agent Runtime 创建平行执行链路。

## Type Safety

- 业务代码禁止 `any`；第三方库类型缺失时允许 `unknown` 或临时 `any`，必须标注原因
- 禁止无注释 `as unknown as`
- 外部数据先校验再获得类型（Prisma Json、HTTP、LLM 输出、Redis、Queue、文件系统、MCP 返回值）
- 优先：Prisma 类型推导 → Zod `safeParse` → Type Guard → `instanceof` → Discriminated Union
- 禁止通过类型断言掩盖设计问题

## Reliability

- 禁止业务逻辑中的空 `catch {}`
- catch 必须记录日志或显式说明忽略原因
- 不允许静默吞掉错误
- `JSON.parse` 等可能失败的操作必须提供降级策略

## Refactoring

- 优先最小改动
- 不为消除告警而重构
- 不为拆文件而拆文件
- 外部 API 保持兼容
- 大规模重构前先提交设计方案

## Workflow

复杂需求（新功能、架构调整、跨 3 个以上文件修改、数据库 Schema 变更、API 协议变更）走 gated pipeline：

```
Architect → Architecture Review → Implementation → Compliance Review → Code Review
```

P0 问题禁止进入下一阶段。

以下情况可直接进入 Implementation：Bug Fix、Config、Docs、小型重构。

## Conventions

- **提交信息**：英文，Conventional Commits（`feat:` / `fix:` / `chore:` / `refactor:` / `docs:` / `test:`），清晰描述 what & why
- **中文 Prompt**：所有 LLM-facing 的 prompt 和 system message 必须使用中文，详见 `docs/engineering/chinese-prompts.md`
- **类型安全**：详见 `docs/engineering/type-safety.md`

## Docs (Load On Demand)

仅在当前任务需要时读取对应文档，禁止一次性加载全部文档。

Architecture:
  docs/architecture/routing.md
  docs/architecture/knowledge-hybrid-retrieval.md
  docs/runtime/execution-runtime-v1.md
  docs/agent-runtime.md

Engineering:
  docs/engineering/type-safety.md
  docs/engineering/chinese-prompts.md

Decisions:
  docs/decisions/adr-001-remove-langgraph.md

Process:
  docs/agents/pipeline.md

Project:
  docs/operations/development.md
  docs/operations/backup-restore.md
  docs/operations/deployment.md
