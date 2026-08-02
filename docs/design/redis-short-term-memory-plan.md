# Redis 短期记忆实现方案（server-py）

> 状态：**已实现（Step 2 完成，2026-08-02）** —— 设计稿 v2 经评审修订后落地。
> 实现：`src/agent/redis_memory.py`（RedisMemoryStore + mirror_message + 结构化日志）、`context_builder.py`（Redis-first 读 + verify 开关）、`summary_compressor.py`（摘要镜像）、`chat.py`（user/assistant 消息镜像钩子）、`config.py`（5 个配置项）。测试：新增 3 个单元测试文件 + 扩展 test_config，另增 `test_redis_memory_integration.py` 真实 Redis 集成测试（无 Redis 时自动 skip），全套件通过。
> 范围：`apps/server-py`。不引入 Mem0 / 长期记忆（与 `docs/memory-layered-storage-implementation-plan.md` 的 TS 侧方案无关，该文档已标注过时）。

## 1. 背景与目标

当前会话记忆完全依赖 PostgreSQL：

- **写**：`SummaryCompressor` 消息数超过阈值后，LLM 生成摘要写入 `conversation_memory` 表（异步非阻塞）。
- **读**：`ContextBuilder` 从 PG 加载最近 `raw_window*2=20` 条消息 + 摘要，组装 LangChain messages 供 AgentExecutor 消费。

目标：将**短期记忆**（最近消息滑动窗口 + 摘要）叠加/迁移到 Redis（带 TTL），`ContextBuilder` **优先读 Redis**，Redis 不可用时**自动降级读 PostgreSQL**。降级贯穿读写两条路径，PG 始终是 source of truth。

设计原则：

- **Redis 是 PG 之上的镜像缓存**，不是新的事实来源。所有消息/摘要仍先写 PG，再尽力镜像到 Redis。
- 镜像写入失败只记日志，不阻断主流程。
- 记忆注入沿用 `ContextBuilder` 现有 message 组装模式，不另起平行链路。

## 2. 现状分析（关键事实）

| 项 | 现状 | 影响 |
|---|---|---|
| 消息写入点 | `chat.py:_handle_chat` 仅两处：user_msg（L298-307）、assistant_msg（L380-389），覆盖 SAFETY/HUMAN/CHAT/DIAGNOSIS/TASK 全部路由 | 镜像钩子只需挂这两处，诊断流程自动覆盖 |
| 摘要写入点 | `SummaryCompressor._upsert_memory`（唯一） | 摘要镜像只需挂这一处 |
| 消息读取 | `ContextBuilder._load_recent_messages`：`WHERE conversation_id ORDER BY created_at DESC LIMIT raw_window*2=20` | Redis 窗口需保 20 条候选，行为才完全等价 |
| 摘要读取 | `ContextBuilder._load_memory`：`conversation_memory` 单行 | 摘要镜像为单 key |
| Redis 依赖 | server-py **无 redis-py 依赖**，仅 `config.redis_url` 配置 + `.env.example` | 需新增 `redis>=5.0` |
| 并发 | `_handle_chat` 内 `_acquire_lock(conversation_id)` 串行化同一会话 | 同一会话内写镜像与读上下文天然有序 |
| 消息排序 | PG 以 `created_at` 排序；列表 RPUSH 以追加顺序排序 | 镜像用列表顺序为准，`created_at` 仅作元数据 |

## 3. 架构概览

```
写路径（每轮对话）:
  chat.py 保存消息 → PG commit → 同步镜像 append_message → Redis 窗口（尽力而为，异常吞掉）
  SummaryCompressor（后台任务）→ PG conversation_memory commit → 镜像 set_summary → Redis 摘要（尽力而为）

读路径（ContextBuilder.build，默认 verify=off）:
  ① 摘要: Redis get_summary ──miss/异常──▶ PG _load_memory
  ② 窗口: Redis get_window ──miss/异常──▶ PG _load_recent_messages
          （verify=on 时：追加 PG 单行 last-id 核对，不一致 → 回退 PG）
  ③ 组装: 复用现有 budget + assemble 逻辑，输入统一为 {role, content} 序列
```

**一致性策略（回应「异步写一致性」关切）**：消息镜像在 PG commit 后**同步 inline await**（异常吞掉、短超时）。这保证「上一轮响应返回时，窗口已含该轮全部消息」→ 下一轮读取天然新鲜，因此默认无需核对。该设计等价于评审建议中的「同步写 Redis」，并保留 `verify_latest_id` 开关供强一致场景（见 §7）。

## 4. Redis key 与数据结构

### 4.1 消息窗口 —— List

| 项 | 值 |
|---|---|
| Key | `agentforge:conv:{conversation_id}:messages` |
| 类型 | Redis List |
| 元素 | JSON 字符串，见下 |
| 顺序 | index 0 = 最旧，尾 = 最新（RPUSH 追加） |
| 裁剪 | 每次追加后 `LTRIM 0 -(window_size-1)`，滑动窗口只留最近 N 条 |
| TTL | 每次追加刷新 `EXPIRE`（**滑动语义**），默认 7 天 |

元素 JSON（**v1 带版本字段**）：

```json
{
  "version": 1,
  "id": "uuid",
  "role": "user",
  "type": "text",
  "content": "...",
  "model": "gpt-4o-mini",
  "created_at": "2026-08-02T10:00:00+00:00"
}
```

- `role`: `user | assistant | system | tool`（原样保留；`ContextBuilder` 现有的 role 分支逻辑不变，tool 消息依旧跳过）。
- `version`: 结构演进位。未来扩展 `tool_call` / `function_call` / `agent` / `trace_id` / `token_usage` 时递增；读取端按版本迁移或降级重建（见 §4.4）。
- `created_at`: 镜像时刻的客户端 `now()`。**列表顺序（RPUSH）才是排序依据**；与 PG 的 `server_default` 时间仅理论边界上有毫秒级差异，不影响正确性。

### 4.2 摘要 —— String

| 项 | 值 |
|---|---|
| Key | `agentforge:conv:{conversation_id}:summary` |
| 类型 | Redis String（JSON） |
| TTL | 每次写入刷新 `EXPIRE`，默认 30 天 |

Value JSON（**保留 `covered_until_message_id` + 加版本**）：

```json
{
  "version": 1,
  "summary": "…",
  "covered_until_message_id": "uuid",
  "token_count": 123,
  "updated_at": "2026-08-02T10:00:00+00:00"
}
```

与 PG `conversation_memory` 字段一一对应。**`covered_until_message_id` 必须保留**：

- 压缩决策（是否增量压缩、取哪些新消息）由 `SummaryCompressor` 读 **PG `conversation_memory`** 决定 —— PG 是事实源，Redis 摘要不参与压缩判断，因此不存在「PG covered=msg100 / Redis covered=msg80 → 重复压缩」的问题。
- 但 Redis 摘要保留该字段用于**完整性对账与未来扩展**（例如让压缩器改读 Redis、或一致性校验），版本迁移时它也是数据完整性的关键锚点。

### 4.3 裁剪与 TTL 策略

- **滑动裁剪**：`append_message` 每次执行 `RPUSH → LTRIM 0 -(N-1) → EXPIRE`（MULTI pipeline 原子执行）。超过 `window_size` 的旧消息从 Redis 窗口移除，**仍在 PG**（长对话摘要压缩由现有 `SummaryCompressor` 负责，不受影响）。
- **TTL 区分消息与摘要**：消息窗口 7 天（客服场景「昨天聊的支付问题，今天继续」），摘要 30 天（摘要承载用户目标/历史结论/关键状态，重建成本更高、价值更高）。均滑动刷新。
- **自愈重建（本方案核心）**：`append_message` 时若 key 不存在（首次写入 / TTL 过期 / 被外部清理），**先基于 PG 重建完整窗口**（加载最近 N 条，含本次已提交消息，RLPUSH 全部）再追加。杜绝「过期后 RPUSH 只生成 1 元素残窗」导致 Agent 突然失忆的脏数据。

### 4.4 版本与迁移策略

- 读取时对每个元素 `json.loads` 后用 pydantic `model_validate`；**`version` 缺失或不等于当前版本 → 视作 miss** → 回退 PG，并在下次写入时由自愈重建以当前版本重写。
- 效果：半年前的历史 Redis 数据不会阻塞新代码；首次访问旧数据即被自愈迁移，无需离线脚本。
- 未来加字段（trace_id 等）时：新增字段给默认值即可向后兼容（version 不变或递增）；破坏性变更递增 version，旧数据走 miss+重建。

## 5. 读写接口

新增模块 `src/agent/redis_memory.py`（与 SummaryCompressor/ContextBuilder 同目录）：

```python
class RedisMemoryStore:
    """Redis 短期记忆存储。所有方法尽力而为：异常 catch + 结构化日志，返回降级信号。"""

    def __init__(self, client: redis.asyncio.Redis, *,
                 enabled: bool, message_ttl: int, summary_ttl: int, window_size: int): ...

    # ── 写（不抛异常，失败只记结构化日志）──
    async def append_message(self, conversation_id: str, message: StoredMessage) -> bool
    async def set_summary(self, conversation_id: str, summary: str,
                          covered_until_message_id: str | None, token_count: int) -> bool

    # ── 读（返回 None 表示 miss / 异常 / 禁用 / 版本不匹配）──
    async def get_window(self, conversation_id: str) -> list[StoredMessage] | None
    async def get_summary(self, conversation_id: str) -> StoredSummary | None

    # ── 维护 ──
    async def delete_conversation(self, conversation_id: str) -> None   # 会话删除时清理，可选
```

类型校验模型（Redis 是共享基础设施，外部数据先校验再获得类型，符合 CLAUDE.md）：

```python
class StoredMessage(BaseModel):
    version: int = 1
    id: str
    role: str
    type: str = "text"
    content: str
    model: str | None = None
    created_at: str                       # ISO8601

class StoredSummary(BaseModel):
    version: int = 1
    summary: str
    covered_until_message_id: str | None = None
    token_count: int = 0
    updated_at: str                       # ISO8601
```

单例与超时：

- `get_memory_store() -> RedisMemoryStore | None`：模块级懒加载单例；`settings.redis_memory_enabled=False` 时返回 `None`（调用方走纯 PG 路径）。懒连接保证 **Redis 不可用时应用可正常启动**。
- 客户端用 `redis.asyncio.Redis.from_url(settings.redis_url, socket_connect_timeout=0.5, socket_timeout=0.5)`：Redis 宕机时最多 ~0.5s 连接超时后立即降级，不悬挂请求路径。

### 结构化日志（写入失败可排查）

所有 Redis 失败统一走私有 `_log_failure`：

```python
def _log_failure(self, operation: str, conversation_id: str, exc: BaseException, duration_ms: float) -> None:
    logger.warning(
        "redis_memory_write_failed op=%s conversation_id=%s error=%s duration_ms=%.1f",
        operation, conversation_id, exc, duration_ms,
    )
```

- 禁止裸 `redis error`；必须含 `op`（append_message / set_summary / get_window / get_summary / rebuild）、`conversation_id`、`error`（异常类型+消息）、`duration_ms`。
- 线上按 `op` + `conversation_id` 即可定位失败的会话与操作。

### 写路径接入点

1. `chat.py:_handle_chat`
   - user 消息 PG commit 后：`await mirror_message(db, conv_id, user_msg)`
   - assistant 消息 PG commit 后：`await mirror_message(db, conv_id, assistant_msg)`
   - **同步 inline await**（非 create_task）：窗口极小（healthy 下 pipeline 约 0.1-0.5ms；Redis 宕机时 +0.5s 连接超时后吞掉），换来源源不断的新鲜窗口；异常永远被 `_log_failure` 吞掉，主流程不失败。
   - `mirror_message` 内部：key 存在 → pipeline(RPUSH+LTRIM+EXPIRE)；key 缺失 → 基于 PG 重建窗口（自愈）。
2. `SummaryCompressor`：构造可选接收 `memory_store`（默认共享单例）；`_upsert_memory` 的 PG commit 之后调用 `set_summary`。压缩器本身运行在后台任务（`_maybe_compress`），`set_summary` 在其内 await 不影响主流程。

### 读路径（ContextBuilder.build，最小改动）

```python
async def build(self, conversation_id, user_message):
    # ① 摘要：优先 Redis，miss/异常 → PG
    memory = (await memory_store.get_summary(conversation_id)) or await self._load_memory(conversation_id)

    # ② 窗口：优先 Redis；verify 开关决定是否做 last-id 核对
    window = await memory_store.get_window(conversation_id)
    if window is not None and (not settings.redis_memory_verify_latest_id or await self._is_window_fresh(window, conversation_id)):
        recent = window
    else:
        recent = await self._load_recent_messages(conversation_id)   # PG 回退（现有逻辑不变）

    # ③ 其余：system prompt 摘要注入、token 预算、组装 —— 逻辑不变
```

- **verify 开关（默认 `false`）**：
  - `false`（生产默认）：窗口由同步镜像保证新鲜，读路径**纯 Redis、零 PG 往返**。残余缺口：某次镜像写入失败且 Redis 恰好在下一次读前恢复时，窗口可能缺最近一条 —— 罕见且仅影响「上一轮最后一条」在历史里的呈现（当前用户消息始终单独注入），可接受。
  - `true`（强一致场景）：追加轻量核对 `SELECT id FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1`（单行索引读），要求 `window[-1].id == 该 id`；不一致 → 回退 PG。核对查询失败时按「可用窗口」处理（PG 不可用时 Redis 兜底更可用）。
- **摘要与窗口独立降级**：Redis 有窗口但无摘要 → 窗口用 Redis、摘要回退 PG；反之亦然。不做全有或全无。
- `ContextBuilder.__init__` 增加可选参数 `memory_store: RedisMemoryStore | None = None`，默认解析共享单例 → 现有 `ContextBuilder(db)` 调用与测试全部兼容。
- 组装部分把 budget + assemble 提取为接收「含 `.role`/`.content` 的序列」的私有方法，`Message`（ORM）与 `StoredMessage`（pydantic）duck-type 复用同一分支代码。`ContextResult` 字段不变。

## 6. 配置项（config.py Settings）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `redis_memory_enabled` | `True` | 总开关；`False` 时读写全走 PG（等价现状） |
| `redis_memory_window_size` | `20` | 滑动窗口原始消息条数 = 现有 `RAW_WINDOW * 2`（与 `ContextBuilder` 候选加载量一致，行为完全等价） |
| `redis_memory_message_ttl_seconds` | `604800`（7d） | 消息窗口 TTL，写入时滑动刷新 |
| `redis_memory_summary_ttl_seconds` | `2592000`（30d） | 摘要 TTL，写入时滑动刷新 |
| `redis_memory_verify_latest_id` | `False` | 读窗口时是否对 PG 做 last-id 新鲜度核对；生产默认关（纯 Redis 读），强一致场景开 |

- 窗口默认 20 = `RAW_WINDOW(10) * 2`；压缩阈值/摘要 token 仍由 `COMPRESSION_THRESHOLD=20`、`SUMMARY_MAX_TOKENS=300` 常量控制，不新增配置。
- `test_config.py` 的纯代码默认值断言模式（`_env_file=None`）沿用并扩展这 5 个字段。

依赖变更（`pyproject.toml`）：

```toml
dependencies += ["redis>=5.0"]                       # redis.asyncio
[dependency-groups.dev] += ["fakeredis>=2.23"]       # 单测用 asyncio 伪 Redis
```

## 7. 降级矩阵

| # | 场景 | 写路径（消息/摘要） | 读路径（verify=false 默认） | 读路径（verify=true） |
|---|---|---|---|---|
| 1 | Redis 正常 | PG commit 后同步镜像成功 | 窗口+摘要读 Redis，**零 PG 往返** | + 一次 PG 单行 last-id 核对 |
| 2 | Redis 不可用（连接失败/超时） | 镜像 catch + 结构化日志；请求最多 +0.5s 连接超时 | `get_*` 异常 → 回退 PG 全量读 | 同左 |
| 3 | Redis key 过期（TTL） | 下次 append 触发自愈重建（key 缺失 → 基于 PG 重建） | key miss → 回退 PG；会话闲置 >TTL 时摘要/窗口不丢 | 同左 |
| 4 | 窗口落后（镜像漏写一次） | — | 默认信任窗口（可能缺最近一条，罕见） | last-id 核对不一致 → 回退 PG 最近消息 |
| 5 | Redis 数据损坏（JSON/版本不匹配） | — | 解析/版本校验失败 → 视作 miss → 回退 PG + 下次写重建 | 同左 |
| 6 | LLM 摘要失败 | PG 摘要不更新（现有逻辑）；Redis 不写 | 无摘要注入（现有行为不变） | 同左 |
| 7 | `redis_memory_enabled=False` | 不镜像 | 等价现状，全走 PG | — |
| 8 | PG 不可用 | 现有行为（请求已失败于会话加载，Redis 无法替代 PG） | 现有行为不变；Redis 仅能兜底已缓存会话的历史读取 | — |

要点：**任何 Redis 异常都只是「少用缓存」，不产生数据丢失**——PG 始终持有全量消息与摘要，降级是无损的。

## 8. 兼容性说明

- **行为等价**：窗口 20 条与现状 `_load_recent_messages` 候选量一致；摘要注入、token 预算、message 组装逻辑不变；`ContextResult` 字段不变。
- **签名兼容**：`ContextBuilder(db)`、`SummaryCompressor(db)` 均新增可选参数，默认行为 = 纯 PG，现有调用与测试零改动。
- **执行器兼容**：CHAT 路由 `prebuilt_messages`、TASK 路由、DIAGNOSIS 路由的 `history`（由 `ctx_result.messages` 派生）——输出形状不变，LangGraph ReAct / 诊断图无感知。
- **不新增 LLM 调用与 prompt**：沿用现有中文压缩 prompt，无新 prompt。
- **类型安全**：Redis JSON 一律经 pydantic `model_validate` 校验；`json.loads` 必须有降级（解析失败 → miss → 回退 PG），禁止空 `catch {}`。

## 9. 测试计划

### 单元测试（fakeredis 伪 Redis + mock PG，不依赖真实 Redis）

`tests/test_redis_memory.py`（新增）：
1. `append_message` 窗口滑动：超过 `window_size` 后 `get_window` 只保留最近 N 条。
2. `append_message` 每次写入刷新 TTL（断言 EXPIRE 被调用 / key TTL 被重置）。
3. `append_message` key 缺失 → 基于 PG 重建完整窗口（mock `load_recent`），杜绝 1 元素残窗。
4. `get_window` / `get_summary` 往返解析正确，`version` 字段默认 1。
5. 窗口内混入非法 JSON / `version` 不匹配元素 → 整体视作 miss（返回 None）。
6. Redis 连接异常（client mock 抛 `ConnectionError` / `TimeoutError`）→ append/set/get 均结构化日志 + 返回失败信号，**不抛异常**；日志含 `op`/`conversation_id`/`duration_ms`。
7. `enabled=False` → `get_memory_store()` 返回 None / 方法直接 no-op。
8. **并发 append**：两个 append_message 并发执行（同/不同会话），验证两条都不丢、LTRIM 原子不互相覆盖。
9. **摘要幂等**：同一 `covered_until_message_id` 重复 `set_summary`，`get_summary` 结果与最后一次一致且 `covered_until` 保留。

`tests/test_context_builder.py`（新增，当前无该测试文件）：
10. Redis 正常（verify=off）：窗口 + 摘要来自 Redis，**断言 PG 查询数为 0**；`has_summary`/`history_count`/system prompt 含摘要/消息 role-content 正确。
11. Redis 窗口 miss → 回退 PG 最近消息。
12. Redis 摘要 miss → 回退 PG `_load_memory`。
13. verify=on：窗口 stale（`window[-1].id != PG last-id`）→ 回退 PG；verify=off：同窗口直接用。
14. Redis 抛异常 → 回退 PG，build 不抛异常。
15. `enabled=False` / `memory_store=None` → 全走 PG（现状回归）。

`tests/test_summary_compressor.py`（新增）：
16. `_upsert_memory` 后调用 `set_summary` 镜像（含 `covered_until_message_id`）；镜像失败 → 压缩流程与 PG 写入不受影响（只记日志）。
17. 摘要镜像的 `covered_until_message_id` 与 PG 写入值一致。

`tests/test_config.py`（扩展）：
18. `_env_file=None` 下断言 5 个新字段纯代码默认值。

**现有全部测试保持通过**（`test_agent.py`、诊断系列、`test_react_graph.py` 等不受影响）。

### 集成测试（可选，需真实 Redis）—— **已实现（2026-08-02）**

`tests/test_redis_memory_integration.py`（17 项，默认连 `redis://localhost:6379`，可用 `REDIS_TEST_URL` 覆盖；无真实 Redis 时整模块自动 skip，不影响 CI / 无 Redis 本地环境）。覆盖 fakeredis 无法验证的真实行为，并落地场景 19–23 中不依赖真实 PG 的部分：

19. 首次压缩全流程（25 条 → `SummaryCompressor.compress`）→ 摘要镜像到真实 Redis，`covered_until_message_id` 与被压缩旧消息最后一条一致（`TestCompressorIntegration`）。
20. `build()` 窗口 + 摘要来自真实 Redis，verify=off 零 PG 访问；verify=on 且窗口新鲜时同样用 Redis（`TestContextBuilderIntegration`）。
21. 真实连接错误（不可达端口）→ append/get 零影响 + 结构化日志（`TestRealConnectionError`）。
22. **TTL 过期流程**：写入 → 等真实过期 → `get_window` 为 None → 下一条 `mirror_message` 基于 PG 自愈重建完整窗口（`TestRebuild`）。
23. 消息 TTL 过期但摘要 TTL 更长 → 摘要命中 Redis、窗口回退 PG（`TestContextBuilderIntegration::test_summary_hits_redis_window_falls_back_pg`）。

其余真实行为：跨实例共享状态（fakeredis 每个 FakeRedis 相互隔离，无法验证）、真实 TTL 到期/刷新、messages=List / summary=String / EXISTS / TYPE / LLEN、并发 append 不丢、损坏 JSON / 版本不匹配整体 miss。

### 验收场景（来自需求 + 评审）

- Redis 正常：`ContextBuilder` 优先读 Redis，默认零 PG 往返（verify=off）。
- Redis 写入失败只记日志、对话不受影响。
- Redis 不可用 → 自动回退现有 PostgreSQL 方案，行为与现状一致。
- 窗口滑动裁剪不丢长对话摘要；消息/摘要 TTL 过期后经 PG 无损恢复。
- 版本字段保证未来扩展（tool_call / trace_id / token_usage）时历史 Redis 数据可迁移/自愈。

## 10. 实施清单（Step 2 预览）

1. `pyproject.toml`：加 `redis` 依赖 + `fakeredis` dev 依赖。
2. `src/config.py`：新增 5 个配置字段；`.env.example` 补注释。
3. `src/agent/redis_memory.py`：新增 `RedisMemoryStore` + pydantic 模型（含 version）+ 懒加载单例 + `_log_failure` 结构化日志。
4. `src/agent/context_builder.py`：可选 `memory_store` 参数 + Redis-first 读 + verify 开关 + 组装复用。
5. `src/agent/summary_compressor.py`：可选 `memory_store` + `_upsert_memory` 后镜像摘要（含 covered_until）。
6. `src/api/v1/chat.py`：两处消息同步镜像钩子（user/assistant）。
7. 单元测试 3 个新文件 + 扩展 `test_config.py`。
8. （可选）集成测试 —— ✅ 已实现（`tests/test_redis_memory_integration.py`，17 项）；会话删除端点清理 Redis key 仍未接入（无会话删除端点）。

## 11. 已确认决策与剩余问题

**按评审确认的调整**：
- ✅ 消息/摘要结构加 `version: 1` + 版本迁移/自愈策略
- ✅ 摘要保留 `covered_until_message_id`
- ✅ TTL 区分：message 7d / summary 30d
- ✅ 新鲜度核对做成配置开关 `redis_memory_verify_latest_id`，生产默认 `false`
- ✅ 消息镜像同步 inline 写入（回应异步一致性缺口），摘要镜像在后台压缩任务内
- ✅ 写入失败结构化日志（op / conversation_id / error / duration_ms）
- ✅ 测试补强：Redis 故障、TTL 过期、并发 append、摘要幂等、版本不匹配

**剩余待确认**（影响小，可默认推进）：
1. 是否同时做「会话删除端点清理 Redis key」（需先确认删除端点是否存在）。
2. 窗口元素不含 `msg_metadata`（ContextBuilder 不消费）；如需前端渲染 tool 链可后续随 version 扩展。
