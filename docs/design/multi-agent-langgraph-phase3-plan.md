# Multi-Agent LangGraph 化 —— Phase 3 增强方案

> 状态：**待实施**（Phase 0/1/2 已完成）
> 范围：`apps/server-py` DIAGNOSIS 路由 Multi-Agent 编排
> 前置：`docs/design/multi-agent-langgraph-plan.md`（Phase 0-2 的完整演进记录）
> 本方案**自包含** —— 新窗口可直接据此实施，无需回读旧方案主体；关键文件与当前代码结构见 §0。

---

## 0. 当前状态快照（2026-08-01）

### 0.1 已完成（勿回退）

- ✅ Phase 0 — `build_react_graph` 工厂抽取（`executor.py`）
- ✅ Phase 1 — LangGraph 版 DiagnosisMode（Feature Flag）
- ✅ Phase 2 — 默认开启 + 团队级 Checkpointing（`AsyncPostgresSaver`，`thread_id = team_run_id`）

### 0.2 关键文件（本阶段涉及）

| 文件 | 职责 | 本阶段改动点 |
|---|---|---|
| `src/agent/diagnosis/mode.py` | 事件/输出 dataclass（`TeamStarted`/`AgentStarted`/`AgentCompleted`/`AgentError`/`TeamCompleted`/`TeamFailed`、`AgentRole`、`FrontendOutput`/`BackendOutput`/`ScoringResult`/`DiagnosisResolution`）、纯函数（`parse_*`/`check_rule_escalation`/`resolve_diagnosis`/`build_fallback_scoring`）、中文 prompt builders（`_build_frontend_task`/`_build_backend_task`/`_build_leader_task`） | 3b 新增 `TeamWaitingForInput` 事件；3c 新增输出 Schema |
| `src/agent/diagnosis/graph.py` | 胖阶段节点（`frontend_node`/`backend_node`/`leader_node`/`resolve_node`/`fast_track_node`）、条件边 `_escalate_router`、`_run_phase_agent`（内层 ReAct 驱动器）、`run_langgraph_diagnosis`（外部入口，`ainvoke` + `asyncio.Queue` 侧信道）、`_build_team_completed` | **3a/3b/3c 的核心改动都在此文件** |
| `src/agent/diagnosis/state.py` | `DiagnosisState`（TypedDict：task/conversation_id/frontend_output/backend_output/scoring/resolution/blackboard） | 3b 增加 `user_supplement` 字段 |
| `src/agent/diagnosis/route_agent.py` | `DiagnosisRouteAgent.execute`：外层 180s 整体超时（`DIAGNOSIS_TIMEOUT_MS = 180_000`）+ `_translate_team_event`（Team SSE → Chat SSE）+ `_check_info_sufficiency`（诊断前澄清） | 3a 超时语义变更；3b 持久化 team_run_id + 续跑入口 |
| `src/config.py` | `langgraph_diagnosis_enabled=True`、`langgraph_diagnosis_checkpoint_enabled=True`、`langgraph_checkpoint_enabled=False` | 3a/3b/3c 各加独立开关 |
| `src/agent/checkpoint.py` | `get_checkpointer(required=...)` | 3b 续跑复用，不改 |

### 0.3 当前事件契约（不可变基线）

Team 内部事件：

```
TeamStarted → (AgentStarted → AgentCompleted | AgentError)* → TeamCompleted
                                                            └→ TeamFailed
```

翻译到 Chat SSE（`route_agent._translate_team_event`）：

```
meta → diagnosis_started → diagnosis_phase(N) → diagnosis_phase_done(N) → diagnosis_completed
                                    └ AgentError → stream_error
                                    └ TeamFailed  → stream_error
（信息不足时不进诊断：clarification_needed → 逐字 token → done）
```

### 0.4 已知潜伏 Bug（Phase 3a 顺带修复）

`graph.py::_emit_agent_run`（graph.py:157-186）捕获异常后返回 `("", True)`，但三个阶段节点**忽略了 `errored` 标志**：
- frontend 失败 → `parse_frontend_output("")` → 空 `FrontendOutput` → `need_escalation=False` → `_escalate_router` 误判为 **fast_track**，产出无意义的 `frontend_only` 结果，掩盖真实失败。
- 应在阶段失败（重试后仍失败）时中止整场诊断并产出 `TeamFailed`（见 §1.3）。

### 0.5 死代码提示

- `mode.py:60` 的 `DIAGNOSIS_TIMEOUT_MS = 60_000` **未被引用**（route_agent.py 另有自己的 `180_000`），清理时机顺带删除或统一。

---

## 1. Phase 3a — 每阶段超时下沉 + 局部重试

> 触发条件：外层 180s 无法区分"哪个阶段耗时瓶颈"，需要单阶段独立控制。
> 前端配合：**无**（纯后端，事件契约不变）。
> 建议**最先实施** —— 自包含且顺带修复 §0.4 潜伏 Bug。

### 1.1 现状

- 唯一超时在 `route_agent.py:452` 的 drain 循环里：`elapsed > DIAGNOSIS_TIMEOUT_MS` → 整个诊断中断，已收集部分返回。
- 粒度太粗：无法判断是哪一阶段慢；也无法对该阶段单独重试。

### 1.2 设计

**超时下沉位置**：`graph.py::_emit_agent_run`（每个阶段节点唯一调用点），用 `asyncio.wait_for` 包 `runner(...)`。

**配置项（`src/config.py`）**：

```python
# Phase 3a：每阶段超时（毫秒）。0 = 禁用（保持外层整体 180s 超时）。
langgraph_diagnosis_stage_timeout_ms: int = Field(default=0)
# 阶段超时后的重试次数（仅超时触发重试，异常不重试）。
langgraph_diagnosis_stage_max_retries: int = Field(default=1)
```

**按角色覆盖**：`AgentRole`（mode.py:156）新增 `timeout_ms: int | None = None`，None 时回落到全局配置：

```python
stage_timeout_ms = role.timeout_ms if role.timeout_ms else settings.langgraph_diagnosis_stage_timeout_ms
```

**重试语义**：仅对 `asyncio.TimeoutError` 重试，静默重试（不重复发射 `AgentStarted`，避免前端阶段号重开）；重试仍失败 → 发射 `AgentError`（含"超时"文案）并中止团队。异常（非超时）不重试，直接失败。

**失败中止（修复 §0.4）**：`_emit_agent_run` 返回 `errored=True` 时，节点**不再继续**，而是：

```python
if errored:
    await queue.put(TeamFailed(error=f"阶段「{role.display_name}」执行失败，诊断中止。"))
    raise _StageAbort()
```

- `_StageAbort` 为 graph.py 内定义的 `class _StageAbort(Exception)` 哨兵。
- `run_langgraph_diagnosis` 的 `finally`（graph.py:484-493）对 `driver.exception()` 判断：`isinstance(exc, _StageAbort)` → **吞掉不重抛**（TeamFailed 已进队列、已 yield，避免再抛一次被 route_agent 当普通异常转成通用 StreamError）。
- `final_state` 为 None（ainvoke 中断）→ 尾部不派发 `TeamCompleted`，行为正确。

### 1.3 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| MODIFY | `src/config.py` | 新增 `langgraph_diagnosis_stage_timeout_ms` / `langgraph_diagnosis_stage_max_retries` |
| MODIFY | `src/agent/diagnosis/mode.py` | `AgentRole` 加 `timeout_ms: int | None = None`；删除死常量 `DIAGNOSIS_TIMEOUT_MS` |
| MODIFY | `src/agent/diagnosis/graph.py` | `_emit_agent_run` 加超时 + 重试；三节点检查 `errored` → TeamFailed + `_StageAbort`；driver finally 吞 `_StageAbort` |
| MODIFY | `tests/agent/diagnosis/test_diagnosis_graph.py` | 新增超时/重试用例（注入慢/失败的 `phase_runner`） |

### 1.4 验收

- 注入 `phase_runner`（sleep 超过 stage_timeout）→ 完整事件序列 `TeamStarted → AgentStarted → AgentError → TeamFailed`，无 `TeamCompleted`。
- `phase_runner` 首次超时、第二次成功（重试上限 1）→ 正常 `AgentCompleted`。
- frontend 失败 → 产出 `TeamFailed`（不再是无声 `frontend_only`）。
- `langgraph_diagnosis_stage_timeout_ms=0`（默认）→ 行为与现状完全一致。
- 全量单测回归：145 passed 基线，2 个既有失败不变（stale `test_config` + DB 依赖 `search_knowledge`）。

---

## 2. Phase 3b — HITL：`interrupt` 阶段边界暂停

> 触发条件：产品确认"Leader 判定信息不足时暂停等用户补充"交互 + 前端配合。
> 前端配合：**需要**（新 Chat SSE 事件 `diagnosis_waiting_input` + 续跑入口）。

### 2.1 现状

- Leader 判定"信息不足"只能走 `resolve_diagnosis` 的 `needs_human` 分支，诊断已结束，用户需要重新发起一轮新诊断。
- 无法在阶段边界暂停、等用户补齐字段后**从同一 thread 继续**。

### 2.2 设计

**新增事件**（mode.py，加入 `TeamStreamEvent` 联合类型）：

```python
@dataclass
class TeamWaitingForInput:
    type: str = "team_waiting_input"
    team_run_id: str = ""
    message: str = ""          # 中文提示（Leader scoring.message 或默认文案）
    missing_fields: list[str] = field(default_factory=list)
```

**配置开关**（config.py）：

```python
# Phase 3b：HITL —— Leader 判定信息不足时 interrupt 暂停等用户补充。
langgraph_diagnosis_hitl_enabled: bool = Field(default=False)
```

**图拓扑变更**（graph.py）：`leader → (条件边 `_clarify_router`) → ask_clarification → resolve` / 直达 resolve。

- `_clarify_router(state)`：`hitl_enabled and state["scoring"] 存在 missing_fields → "ask_clarification"`，否则 `"resolve"`。
- `ask_clarification_node`：

```python
async def ask_clarification_node(state: DiagnosisState) -> dict:
    sc = state.get("scoring")
    answer = interrupt({
        "type": "diagnosis_clarification",
        "message": sc.message if sc and sc.message else "需要补充以下信息以完成诊断。",
        "missing_fields": sc.missing_fields if sc else [],
    })
    # answer：用户补充的消息文本 / 字段 dict（由 route_agent 透传）
    return {"user_supplement": answer, "blackboard": state.get("blackboard")}
```

- `DiagnosisState` 增加 `user_supplement: str | dict | None`（state.py）。

**driver 变更**（`run_langgraph_diagnosis`）：

- `ainvoke` 包 try/except `GraphInterrupt`（langgraph 1.x 在节点 `interrupt()` 时从 `ainvoke` 抛出）。捕获后 `yield TeamWaitingForInput(team_run_id=..., message=..., missing_fields=...)` 并正常结束迭代（**不**派发 TeamCompleted，也不重抛）。
- 注意：`_run` 的 `finally` 里 `queue.put_nowait(None)` 已兜底，drain 循环正常 break。

**续跑入口**（graph.py 新增公开 async 生成器）：

```python
async def resume_langgraph_diagnosis(
    roles, conversation_id, tools_registry, team_run_id,
    user_input: str | dict,
    cancel_event=None,
) -> AsyncIterator[TeamStreamEvent]:
    # 重建同一图（roles/bb 相同），用同一 thread_id，ainvoke(Command(resume=user_input))
    # 不传 initial_state（Phase 2 实证：传全量状态会重置、从 START 重跑）。
    # 从 checkpoint 恢复，自被 interrupt 的 ask_clarification 节点继续 → resolve → END。
    ...
    final_state = await graph.ainvoke(Command(resume=user_input), config={"configurable": {"thread_id": team_run_id}})
    yield _build_team_completed(final_state)
```

**route_agent.py 变更**：

- 模块级（或按会话）保存 `_active_hitl: dict[str, str]`（conversation_id → team_run_id）。
- 诊断流中收到 `TeamWaitingForInput` → 翻译为新的 Chat SSE 事件 `DiagnosisWaitingInput`（`src/agent/types.py` 新增），并记 `_active_hitl[conversation_id] = team_run_id`。
- 下次同一会话 `execute()`：若 `conversation_id in _active_hitl` → 走 `resume_langgraph_diagnosis`（用户新消息即 `user_input`），事件照常翻译；结束后清除记录。
- 内存 Map 的局限：进程重启丢失（MVP 可接受，注释标注）。如需持久化 → 复用 `conversation_id → team_run_id` 落库，列为后续工作。

**前端（记录范围，不在本仓库 python 侧实施）**：
- 收到 `diagnosis_waiting_input` → 渲染补充信息表单（missing_fields 提示）。
- 提交时走正常 chat 发送 → 后端命中 `_active_hitl` 走续跑。

### 2.3 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| MODIFY | `src/agent/diagnosis/mode.py` | 新增 `TeamWaitingForInput` 并加入联合类型 |
| MODIFY | `src/agent/diagnosis/state.py` | `DiagnosisState` 加 `user_supplement` |
| MODIFY | `src/agent/diagnosis/graph.py` | `ask_clarification_node`、`_clarify_router`、interrupt 捕获、`resume_langgraph_diagnosis` |
| MODIFY | `src/config.py` | `langgraph_diagnosis_hitl_enabled` |
| MODIFY | `src/agent/types.py` | 新增 `DiagnosisWaitingInput`（RouteStreamEvent） |
| MODIFY | `src/agent/diagnosis/route_agent.py` | `_active_hitl` + 续跑分支 + `_translate_team_event` 新分支 |
| CREATE | `tests/agent/diagnosis/test_hitl.py` | interrupt/续跑用例 |

### 2.4 验收

- `hitl_enabled=True` + 注入 Leader 产出带 `missing_fields` → 流产出 `TeamWaitingForInput` 且无 `TeamCompleted`。
- 同 thread `resume_langgraph_diagnosis`（`Command(resume=...)`）→ `resolve` 续跑至 `TeamCompleted`；`user_supplement` 可用（断言 `DiagnosisState` 中携带）。
- `hitl_enabled=False`（默认）→ 行为与现状一致（needs_human 走完）。
- 不传 `initial_state` 续跑（防重置）用现有 `test_checkpoint_resume.py` 的 `ainvoke(None)` 模式为参照。

---

## 3. Phase 3c — 每节点结构化输出（`with_structured_output`）

> 触发条件：角色间 JSON 文本交接解析失败率偏高时。
> 前端配合：**无**（纯后端）。
> ⚠️ **PoC 前置**：`ProviderChatModel`（langchain_adapter.py:38）当前**未显式实现** `with_structured_output`，依赖 `BaseChatModel` 默认实现（function-calling 或 JSON mode）。实施第一步必须先在本仓库 venv 实证两件事：
> 1. `model.with_structured_output(Schema).ainvoke(...)` 在 `deepseek-v4-flash` provider 上是否可用；
> 2. 不可用时 `method="function_calling"` 经现有 tool-call 通道是否可行。
> PoC 不过 → 本项不实施，维持 `parse_*` 兜底。

### 3.1 现状

- 三阶段靠"文本输出 → `extract_json` → `parse_*`"交接，`parse_*` 已有降级兜底（解析失败 → 截断文本 + 零分）。
- 解析失败率高时诊断质量不稳定。

### 3.2 设计（推荐：保留 ReAct + 追加一次结构化抽取，最低风险）

- **不动 ReAct 循环**（工具推理路径不变）；在 `_run_phase_agent` 收集完 token 后，若开关开启，**追加一次** `with_structured_output` 抽取：

```python
# _run_phase_agent（graph.py:76）内，token 收集后：
if settings.langgraph_diagnosis_structured_output:
    try:
        obj = await model.with_structured_output(output_schema).ainvoke([
            SystemMessage(content=role.system_prompt),
            HumanMessage(content=task_prompt),
        ])
        return obj.model_dump() if hasattr(obj, "model_dump") else obj
    except Exception:
        logger.warning("structured output failed, fallback to raw text: %s", exc)
        # 回落：仍返回累积 token 文本，由节点 parse_* 走原路径
```

- 节点侧：`_emit_agent_run` 返回的 output 若已是结构化 dict → 直接用；否则走现有 `parse_*`。即 **`parse_*` 保留为兜底**，结构化成功时不经历 JSON 文本。
- 需要 `output_schema` 与 role 对应：`AgentRole` 加 `output_schema: type[BaseModel] | None = None`（可选，3c 实施时注入）。
- `with_structured_output` 的抽取 prompt 必须是**中文**（`docs/engineering/chinese-prompts.md` 约束）——用既有中文 task_prompt + system_prompt 即可，无需新文案。
- 成本诚实说明：开启后每阶段多一次 LLM 调用（抽取 + 校验），换取 JSON 交接健壮性。默认关，触发才开。

### 3.3 替代方案（记录，不默认）

- 让 ReAct 的**最终回复本身走结构化 tool-call**（`__structured_output__` 伪工具），省一次额外调用，但需改 ReAct 图输出契约，改动面大、收益与方案 A 相当。不采用。

### 3.4 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| MODIFY | `src/config.py` | `langgraph_diagnosis_structured_output: bool = Field(default=False)` |
| MODIFY | `src/agent/diagnosis/mode.py` | `AgentRole.output_schema`；三角色 Schema（pydantic，字段镜像 `FrontendOutput`/`BackendOutput`/`ScoringResult`） |
| MODIFY | `src/agent/diagnosis/graph.py` | `_run_phase_agent` 结构化抽取分支；`_emit_agent_run`/节点兼容 dict 产物 |
| CREATE | `tests/agent/diagnosis/test_structured_output.py` | 命中/兜底用例 |

### 3.5 验收

- 开关关（默认）→ 行为与现状完全一致（纯 `parse_*`）。
- 开关开 + 注入 stub `with_structured_output` → 节点拿到校验后的 dict，跳过 `parse_*`。
- 开关开 + 结构化调用抛异常 → 回落 `parse_*` 正常降级，不抛错。
- PoC 实证记录：`docs/design/` 追加一节或在 §3 标注验证结果。

### 3.6 PoC 实证结果（2026-08-01）—— ❌ 不实施

**结论：PoC 不过，Phase 3c 不实施，维持 `parse_*` 兜底。**

在 `apps/server-py/.venv`（Python 3.12.10，langchain_core 1.5.1）实证：

1. `model.with_structured_output(Schema)` → **同步抛 `NotImplementedError`**
   （在发起任何 LLM 调用之前）。原因：`ProviderChatModel` 未覆写 `bind_tools`，
   langchain_core 1.5.1 默认实现首行检查
   `type(self).bind_tools is BaseChatModel.bind_tools` → 成立即抛错。
   该失败与 provider / 模型无关，是适配器层面的确定性失败。
2. `method="function_calling"` 逃生通道 → **在该版本无效**：默认实现
   `with_structured_output` 用 `kwargs.pop("method", None)` **丢弃** 该参数，
   仍走 `bind_tools` + tool-call 解析，依旧抛 `NotImplementedError`。
   现有 tool-call 通道本身可用（ReAct 已在经 `bind_tools` 透传 tools），但
   `with_structured_output` 无法经此通道触达 —— 需要给共享适配器
   `langchain_adapter.py::ProviderChatModel` 补 `bind_tools` 覆写，
   超出 §3.4 文件范围且影响 TASK 路由，不采纳。

若后续要启用：需先给 `ProviderChatModel` 增加最小 `bind_tools` 覆写并回归
TASK 路由，再回到 §3.2 设计重新验证。

---

## 4. 测试策略

**保留（不因本阶段删除）**：
- `tests/agent/diagnosis/test_mode.py`、`test_blackboard.py`、`test_nodes.py`、`test_route_agent.py`、`test_diagnosis_graph.py`、`test_checkpoint_resume.py`；`tests/agent/test_agent.py`（TASK 回归）

**新增/扩展**：

| 测试 | 归属 | 内容 |
|---|---|---|
| `test_stage_timeout_aborts` | 3a | 慢 runner → AgentError → TeamFailed，无 TeamCompleted |
| `test_stage_timeout_retry_once` | 3a | 首次超时重试成功 → AgentCompleted |
| `test_frontend_failure_no_silent_fasttrack` | 3a | frontend 失败 → TeamFailed（回归 §0.4） |
| `test_hitl_interrupt` | 3b | hitl 开 + missing_fields → TeamWaitingForInput，无 TeamCompleted |
| `test_hitl_resume` | 3b | `Command(resume=...)` 续跑 → TeamCompleted，user_supplement 携带 |
| `test_hitl_disabled_by_default` | 3b | 默认关 → needs_human 走完 |
| `test_structured_output_happy_path` | 3c | stub 结构化命中 → 跳过 parse_* |
| `test_structured_output_fallback` | 3c | 结构化抛错 → 回落 parse_* |

**端到端**（每项合并前手 curl 一条 DIAGNOSIS 请求，断言 SSE 事件序列与预期分支一致）。

---

## 5. 实施顺序建议

1. **3a 先行** —— 自包含、无前端依赖、顺带修复 §0.4 潜伏 Bug；独立 flag 默认关，零回归风险。
2. **3c 次之** —— 纯后端，需先过 PoC；默认关。
3. **3b 最后** —— 依赖产品确认 + 前端配合（新事件类型 + 续跑表单），跨 repo，单列排期。

三项相互独立、各有独立开关，**可单独触发实施**，不阻塞。

---

## 6. 明确不做（Scope Exclusions）

- 不改 TS `teams/` 模块（ADR-001 约束）
- 不引入 `create_react_agent` / 不改 ReAct 图输出契约（3c 走"追加抽取"而非"结构化最终回复"）
- 不解决诊断质量问题本身（T4 mock 工具、P1 会话持久化为独立工作项）
- 不改中文 prompt 与既有外部 SSE 事件语义（3b 新增事件类型，不改旧语义）
- `_active_hitl` 内存 Map 的进程重启丢失为 MVP 已知局限，持久化列为后续工作
