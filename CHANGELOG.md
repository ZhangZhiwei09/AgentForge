# Changelog

## 2026-07-13 — Production Hardening

### Added
- `/api/ready` 端点：数据库 + LLM Provider 连通性检测，供 K8s readiness probe
- `agentRouteInvocations` Prometheus 指标：按路由（SAFETY/CHAT/TASK/HUMAN/DIAGNOSIS）统计 Agent 调用次数
- 数据库备份脚本 `infra/scripts/backup.sh` + 恢复脚本 `restore.sh`
- ESLint flat config (`eslint.config.mjs`) + Prettier config (`prettier.config.js`)

### Fixed
- HumanAgent 数据库更新失败时补充 `errorCode: HM_ESCALATE_FAILED`
- AgentExecutor fire-and-forget 记忆记录空 catch 增加 `agentMemoryRecordFailures` 指标
- `l2-semantic.ts` 向量检索查询改用 `$queryRaw` tagged template（消除 `$queryRawUnsafe`）

### Changed
- `resolveModel()` 返回类型从 `[string, string]` 元组改为 `ResolvedModel { providerName, modelId }` 结构化类型
- SIGTERM 优雅关闭增强：close server → disconnect prisma → flush observability
- CI workflow：分离 lint 与 typecheck step
- README：移除已删除的 LangChain/LangGraph 依赖引用
- 架构概览文档：`apps/web` → 实际 app 结构

---

## 2026-07-12 — Agent Runtime Refactor

### Changed
- AgentExecutor 方法提取重构（handleComplexTask / handleSimpleQA / handleInterruption）
- 路由管线模块化：routing/ 目录，5 层分离
- 统一错误码体系（AE_* / AR_* / RT_* / VL_*）

### Added
- 路由分类审计日志
- ReAct JSON 5-key 检测与泄漏防护
- 信息充分性门控：ClarificationCard 前置检查

---

## 2026-06 — LangChain/LangGraph 移除

### Removed
- LangChain 和 LangGraph 依赖
- 遗留 adapters
- 相关类型桥接层

---

## 2026-05 — Agent Runtime V1

### Added
- 统一 `AgentExecutor`（ReAct）执行器
- 4-route 分类器：SAFETY / CHAT / TASK / HUMAN
- ToolRegistry 工具注册中心（含熔断器）
- AgentGuard 安全守卫（token budget + cost budget + PII scan）
- SSE 流式响应协议
