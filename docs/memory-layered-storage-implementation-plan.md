# Redis + Mem0 分层记忆实现方案

> **⚠️ 状态: Mem0 未实现，Milvus 已移除（2026-08）** — Mem0 从未落地，无相关代码/配置/API Key。Milvus 已全部迁移到 PGVector。此方案中的 Mem0 长期记忆层和 Milvus 引用已过时。Redis 短期记忆部分可能仍有参考价值。保留作为设计参考。

## Summary

在现有 `MemoryService` 门面上完成记忆系统闭环：Redis 负责短期记忆的滑动窗口和摘要压缩，Mem0 负责长期记忆的用户级、会话级分层存储与检索；所有 Agent 对话统一通过 `MemoryService` 读取和写入，避免散落调用 `MemoryEngine`。

## Key Changes

- 短期记忆使用 `ShortTermMemoryStore`：
  - Redis ZSET 存储 `conv:{conversationId}:messages`，按时间戳维护最近 N 条消息。
  - Redis STRING 存储 `conv:{conversationId}:summary`，当窗口超过阈值时压缩旧消息为摘要。
  - Redis 不可用时降级到进程内 Map，保证对话不中断。
  - 每轮 Agent 回复完成后调用 `MemoryService.recordExchange()` 写入用户消息和助手回复。

- 长期记忆使用 `LongTermMemoryStore`：
  - 封装 Mem0 HTTP client，支持 `add`、`search`。
  - 用户级记忆：以 `userId` 为主 namespace，保存跨会话偏好、事实、长期需求。
  - 会话级记忆：写入 metadata，例如 `{ scope: "session", conversationId, sessionId }`，检索时按当前会话过滤。
  - Mem0 写入失败或未配置时，降级到现有 `MemoryEngine` 的 PG + Milvus 存储。

- 统一接入链路：
  - `injectMemories()` 继续只依赖 `getMemoryService()`，返回短期摘要、最近对话、长期用户/会话记忆。
  - `AgentRuntimeService` 中记忆抽取改为调用 `MemoryService.extractAndStore()`，不要直接 `new MemoryEngine()`。
  - 后台 BullMQ 记忆抽取 job 也改用 `MemoryService`，确保 Mem0 和 fallback 行为一致。
  - 上下文注入顺序固定为：短期摘要 -> 最近窗口消息 -> 会话级长期记忆 -> 用户级长期记忆。

- 配置与文档：
  - 保留 `MEM0_API_KEY`、`MEM0_BASE_URL`、`REDIS_URL`。
  - 增加可配置项：短期窗口大小、摘要触发阈值、TTL、长期记忆 topK。
  - 在 `.env.example` 和 README 中说明 Redis 短期记忆、Mem0 长期分层记忆、降级策略。

## Public Interfaces

- `MemoryService.buildContext({ userId, conversationId, query })` 返回：
  - `summary`
  - `recentMessages`
  - `longTermMemories`
  - `memoryCount`

- `MemoryService.recordExchange(conversationId, userMsg, assistantReply)`：
  - 写入 Redis 短期窗口。
  - 必须在助手回复持久化后调用。

- `MemoryService.extractAndStore(messages, userId, conversationId, sessionId?)`：
  - 从最近对话抽取长期记忆。
  - 同时支持 Mem0 用户级/会话级写入和本地 fallback。

## Test Plan

- 单元测试：
  - Redis mock 下验证滑动窗口只保留最近 N 条消息。
  - 超过阈值后生成摘要并删除旧消息。
  - Redis 异常时 fallback Map 可读写。
  - Mem0 配置存在时调用 Mem0 add/search。
  - Mem0 不可用时回退 `MemoryEngine`。
  - 会话级记忆只返回当前 `conversationId/sessionId` 的结果。

- 集成测试：
  - 调用 `/api/agent/chat` 多轮对话后，下一轮 prompt 能注入短期摘要和最近消息。
  - 抽取出的用户偏好在新会话中可被用户级记忆召回。
  - 当前会话内的事项只在对应会话级记忆中召回。
  - Redis/Mem0 分别不可用时，对话仍能完成且日志记录降级原因。

- 验收场景：
  - 用户说“我喜欢用 TypeScript，以后回答代码优先 TS”，新会话再次提问时能记住偏好。
  - 长对话超过窗口阈值后，早期关键信息出现在摘要中，最近 N 条仍完整保留。
  - 同一用户两个会话的会话级任务不串话，用户级偏好可以跨会话复用。

## Assumptions

- Mem0 使用 HTTP API，不新增官方 SDK 依赖。
- PostgreSQL + Milvus 继续作为长期记忆 fallback 和本地可观测存储。
- 不新增前端管理页；本次重点是后端记忆能力和项目亮点可验证。
- 默认窗口大小 20，摘要触发阈值 30，TTL 7 天，长期记忆默认 topK 为 5。
