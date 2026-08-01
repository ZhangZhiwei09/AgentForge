"""LangGraph 版 Multi-Agent 诊断编排 —— 胖阶段节点设计。

对应 multi-agent-langgraph-plan.md §3（v2，基于 PoC 实证）。

图拓扑:
    START → frontend ─(escalate_router)─→ backend → leader → resolve → END
                      └─(无需升级)─→ fast_track → END

设计要点：
- **胖阶段节点**：frontend/backend/leader 是父图里的普通 async 节点，内部经
  `_run_phase_agent` 驱动 ReAct 图（复用 `AgentExecutor`，其内部使用
  `build_react_graph` 工厂，与 TASK 路由同一执行基座），把解析后的产物
  **显式 return** 进父图状态。
- **事件经单个 asyncio.Queue 侧信道**：节点把 AgentStarted/AgentCompleted/
  AgentError 推入 queue，外层 `run_langgraph_diagnosis` 按序转发；TeamCompleted
  由 ainvoke 返回的最终状态派生。token 文本由节点内部收集（当前契约不逐 token
  流出，与手写版 `DiagnosisMode.execute` 一致）。
- **取消**：外层 drain 在阶段边界（AgentCompleted/AgentError 之后）检测
  cancel_event → TeamFailed；节点内部 `_run_phase_agent` 也在循环中检测取消。
- **纯函数与中文 prompt 原样复用**：`parse_*`、`check_rule_escalation`、
  `resolve_diagnosis`、`build_fallback_scoring` 及 `mode.py` 的 `_build_*_task`
  （经无状态 `DiagnosisMode()` 实例调用，方法不使用 self）。
"""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from src.agent.diagnosis.blackboard import Blackboard
from src.agent.diagnosis.mode import (
    AgentRole,
    AgentCompleted,
    AgentError,
    AgentStarted,
    BackendOutput,
    DiagnosisMode,
    DiagnosisResolution,
    FrontendOutput,
    ScoringResult,
    TeamCompleted,
    TeamFailed,
    TeamStarted,
    TeamStreamEvent,
    build_fallback_scoring,
    check_rule_escalation,
    parse_backend_output,
    parse_frontend_output,
    parse_scoring_output,
    resolve_diagnosis,
)
from src.agent.checkpoint import get_checkpointer
from src.agent.diagnosis.state import DiagnosisState
from src.agent.executor import AgentExecutor
from src.agent.tools.registry import ToolRegistry
from src.config import settings
from src.agent.types import RouteContext, StreamToken

logger = logging.getLogger(__name__)

# 复用 mode.py 的 prompt builder（不使用 self，实例仅作命名空间）
_PROMPT_BUILDER = DiagnosisMode()


# ═══════════════════════════════════════════════════════════
# 阶段 Agent 驱动器（真实 runner）
# ═══════════════════════════════════════════════════════════


async def _run_phase_agent(
    role: AgentRole,
    task_prompt: str,
    conversation_id: str,
    tools_registry: ToolRegistry,
    cancel_event: asyncio.Event | None,
) -> str:
    """驱动单个阶段 Agent，收集全部 token 文本作为该 Agent 的输出。

    与 DiagnosisMode._run_agent 相同的 token 收集逻辑：复用 AgentExecutor
    （其内部经 build_react_graph 工厂构建 ReAct 图并 astream_events 驱动），
    收集 executor 流出的全部 StreamToken。
    """
    filtered_registry = (
        tools_registry.filter(role.tools) if role.tools else tools_registry
    )
    # 内层 ReAct 保持瞬态（checkpoint=False）：父图是唯一被 checkpoint 的图
    # （multi-agent-langgraph-plan.md §4.3）。即便未来激活 G1 全局门控，也不挂。
    executor = AgentExecutor(registry=filtered_registry, checkpoint=False)

    context = RouteContext(
        conversation_id=conversation_id,
        user_message=task_prompt,
        resolved_model="",
        provider_name="",
        assistant_msg_id=f"diag-{role.name}-{int(time.time() * 1000)}",
        intent="diagnosis",
    )

    tokens: list[str] = []
    async for event in executor.execute(context, system_prompt=role.system_prompt):
        if cancel_event and cancel_event.is_set():
            logger.info("LangGraph diagnosis: agent %s cancelled", role.name)
            break
        if isinstance(event, StreamToken):
            tokens.append(event.content)
    return "".join(tokens)


PhaseRunner = Callable[
    [AgentRole, str, str, ToolRegistry, asyncio.Event | None],
    Awaitable[str],
]


# ═══════════════════════════════════════════════════════════
# 图构建
# ═══════════════════════════════════════════════════════════


def build_diagnosis_graph(
    roles: dict[str, AgentRole],
    task: str,
    conversation_id: str,
    tools_registry: ToolRegistry,
    queue: asyncio.Queue[TeamStreamEvent | None],
    cancel_event: asyncio.Event | None = None,
    phase_runner: PhaseRunner | None = None,
    blackboard: Blackboard | None = None,
    checkpointer: Any | None = None,
) -> CompiledStateGraph:
    """构建 LangGraph 诊断父图（胖阶段节点）。

    Args:
        roles: {"frontend_agent": AgentRole, "backend_agent": AgentRole, "leader": AgentRole}
        task: 用户原始问题。
        conversation_id: 会话 ID。
        tools_registry: 工具注册中心（已注册所有必要工具）。
        queue: 事件侧信道 —— 节点将 AgentStarted/AgentCompleted/AgentError 推入。
        cancel_event: 可选取消信号，set 后中断诊断。
        phase_runner: 可注入的阶段 runner（测试用）；默认走真实 _run_phase_agent。
        blackboard: 可注入的共享 Blackboard；缺省时新建并写入 task。
        checkpointer: 团队级 checkpointer（Phase 2，thread_id=team_run_id）。
            父图是唯一被 checkpoint 的图；内部 ReAct（阶段 runner）保持瞬态不挂载。
    """
    bb = blackboard or Blackboard()
    if not bb.has("task"):
        bb.write("task", task, "system")

    runner = phase_runner or _run_phase_agent

    async def _emit_agent_run(
        role: AgentRole,
        task_prompt: str,
    ) -> tuple[str, bool]:
        """驱动单个 Agent 并推送 AgentStarted/AgentCompleted/AgentError。

        Returns:
            (output, errored): output 为累积 token 文本；errored 表示发生异常。
        """
        await queue.put(AgentStarted(
            agent_name=role.name,
            role=role.display_name,
            task=task_prompt,
        ))
        try:
            output = await runner(
                role, task_prompt, conversation_id, tools_registry, cancel_event
            )
        except Exception as exc:
            logger.error(
                "LangGraph diagnosis: agent %s failed: %s", role.name, exc
            )
            await queue.put(AgentError(agent_name=role.name, error=str(exc)))
            return "", True
        await queue.put(AgentCompleted(
            agent_name=role.name,
            output=output or "",
            duration_ms=0,
        ))
        return output or "", False

    # ── 节点 ──────────────────────────────────────────────

    async def frontend_node(state: DiagnosisState) -> dict:
        role = roles["frontend_agent"]
        task_prompt = _PROMPT_BUILDER._build_frontend_task(role, state["task"], bb)
        output, _ = await _emit_agent_run(role, task_prompt)

        fe = parse_frontend_output(output)

        # 规则兜底：LLM 漏判但 check_rule_escalation 命中 → 强制升级
        if check_rule_escalation(output):
            if not fe.need_escalation:
                logger.info(
                    "LangGraph diagnosis: rule-based escalation triggered "
                    "(LLM missed it)"
                )
                fe.need_escalation = True
                fe.escalation_reason = (
                    "rule_override: backend error code or stage detected "
                    "in frontend output"
                )

        bb.write("frontend_conclusion", {
            "conclusion": fe.conclusion,
            "evidence": fe.evidence,
            "need_escalation": fe.need_escalation,
        }, "frontend_agent")

        return {"frontend_output": fe, "blackboard": bb.serialize()}

    async def backend_node(state: DiagnosisState) -> dict:
        role = roles.get("backend_agent")
        if role is None:
            logger.warning(
                "LangGraph diagnosis: escalated but no backend_agent in team"
            )
            be = BackendOutput(
                conclusion="后端排查 Agent 未配置，无法执行独立排查。",
                evidence=[],
            )
            bb.write("backend_conclusion", {
                "conclusion": be.conclusion,
                "evidence": be.evidence,
            }, "backend_agent")
            return {"backend_output": be, "blackboard": bb.serialize()}

        context_for_backend = {}
        fe = state.get("frontend_output")
        if fe is not None:
            context_for_backend = fe.context_for_backend or {}

        task_prompt = _PROMPT_BUILDER._build_backend_task(
            role, state["task"], context_for_backend, bb
        )
        output, _ = await _emit_agent_run(role, task_prompt)

        be = parse_backend_output(output)

        bb.write("backend_conclusion", {
            "conclusion": be.conclusion,
            "evidence": be.evidence,
        }, "backend_agent")

        return {"backend_output": be, "blackboard": bb.serialize()}

    async def leader_node(state: DiagnosisState) -> dict:
        role = roles.get("leader")
        fe = state.get("frontend_output") or FrontendOutput()
        be = state.get("backend_output") or BackendOutput()

        if role is None:
            logger.warning(
                "LangGraph diagnosis: escalated but no leader agent in team"
            )
            sc = build_fallback_scoring(fe, be, "团队未配置 leader Agent。")
            bb.write("scoring_result", {
                "frontend_score": sc.frontend_score,
                "backend_score": sc.backend_score,
                "synthesis": sc.synthesis,
            }, "leader")
            return {"scoring": sc, "blackboard": bb.serialize()}

        task_prompt = _PROMPT_BUILDER._build_leader_task(role, state["task"], fe, be, bb)
        output, _ = await _emit_agent_run(role, task_prompt)

        sc = parse_scoring_output(output)

        bb.write("scoring_result", {
            "frontend_score": sc.frontend_score,
            "backend_score": sc.backend_score,
            "synthesis": sc.synthesis,
        }, "leader")

        return {"scoring": sc, "blackboard": bb.serialize()}

    async def resolve_node(state: DiagnosisState) -> dict:
        fe = state.get("frontend_output") or FrontendOutput()
        be = state.get("backend_output") or BackendOutput(
            conclusion="后端排查 Agent 未配置，无法执行独立排查。",
            evidence=[],
        )
        sc = state.get("scoring") or build_fallback_scoring(
            fe, be, "缺少评分结果。"
        )
        return {"resolution": resolve_diagnosis(fe, be, sc)}

    async def fast_track_node(state: DiagnosisState) -> dict:
        return {"resolution": DiagnosisResolution(resolution="frontend_only")}

    # ── 条件边 ────────────────────────────────────────────

    def _escalate_router(state: DiagnosisState) -> str:
        """条件边：保留 check_rule_escalation 规则覆盖后，判断是否升级。"""
        fe = state.get("frontend_output")
        if fe is not None and fe.need_escalation:
            return "backend"
        return "fast_track"

    # ── 组装 ──────────────────────────────────────────────

    workflow = StateGraph(DiagnosisState)
    workflow.add_node("frontend", frontend_node)
    workflow.add_node("backend", backend_node)
    workflow.add_node("leader", leader_node)
    workflow.add_node("resolve", resolve_node)
    workflow.add_node("fast_track", fast_track_node)
    workflow.add_edge(START, "frontend")
    workflow.add_conditional_edges(
        "frontend",
        _escalate_router,
        {"backend": "backend", "fast_track": "fast_track"},
    )
    workflow.add_edge("backend", "leader")
    workflow.add_edge("leader", "resolve")
    workflow.add_edge("resolve", END)
    workflow.add_edge("fast_track", END)

    return workflow.compile(checkpointer=checkpointer)


# ═══════════════════════════════════════════════════════════
# TeamCompleted 派生
# ═══════════════════════════════════════════════════════════


def _build_team_completed(final_state: dict[str, Any]) -> TeamCompleted:
    """从最终状态派生 TeamCompleted（与手写版 execute 输出一致）。"""
    fe = final_state.get("frontend_output")
    resolution_obj = final_state.get("resolution")
    resolution_str = (
        getattr(resolution_obj, "resolution", "")
        if resolution_obj is not None
        else ""
    )

    if resolution_str == "frontend_only":
        fe_conclusion = fe.conclusion if fe is not None else ""
        fe_evidence = fe.evidence if fe is not None else []
        frontend_scoring = ScoringResult(
            frontend_score=9,
            backend_score=0,
            synthesis=fe_conclusion,
        )
        return TeamCompleted(
            output={
                "conclusion": fe_conclusion,
                "evidence": fe_evidence,
                "resolution": "frontend_only",
                "escalated": False,
                "scoring": asdict(frontend_scoring),
            },
            rounds_count=1,
        )

    scoring = final_state.get("scoring")
    return TeamCompleted(
        output={
            "resolution": resolution_str,
            "final_diagnosis": (
                resolution_obj.final_diagnosis if resolution_obj is not None else {}
            ),
            "scoring": asdict(scoring) if scoring is not None else {},
            "escalated": True,
        },
        rounds_count=3,
    )


# ═══════════════════════════════════════════════════════════
# 外部入口（async generator，事件序列与手写版 execute 一致）
# ═══════════════════════════════════════════════════════════


async def run_langgraph_diagnosis(
    roles: dict[str, AgentRole],
    task: str,
    conversation_id: str,
    tools_registry: ToolRegistry,
    cancel_event: asyncio.Event | None = None,
    phase_runner: PhaseRunner | None = None,
) -> AsyncIterator[TeamStreamEvent]:
    """LangGraph 图路径的诊断入口。

    事件序列与 `DiagnosisMode.execute` 手写版一致：
        TeamStarted → (AgentStarted/AgentCompleted|AgentError)* → TeamCompleted

    取消语义与手写版一致：阶段边界（AgentCompleted/AgentError 之后）检测到
    cancel_event → TeamFailed 并中断图运行。
    """
    queue: asyncio.Queue[TeamStreamEvent | None] = asyncio.Queue()

    bb = Blackboard()
    bb.write("task", task, "system")

    if not roles.get("frontend_agent"):
        yield TeamFailed(
            error="DiagnosisMode requires 'frontend_agent' in roles dict"
        )
        return

    # Phase 2：团队级 checkpointing —— 父图是唯一被 checkpoint 的图。
    # 由 langgraph_diagnosis_checkpoint_enabled 门控（与 G1 全局门控隔离）；
    # 创建失败（DB 不可用）时降级为无状态执行，不阻断诊断。
    checkpointer = None
    if settings.langgraph_diagnosis_checkpoint_enabled:
        try:
            checkpointer = await get_checkpointer(required=True)
        except Exception as exc:  # noqa: BLE001 - 降级而非中断诊断
            logger.warning(
                "LangGraph diagnosis: checkpointer unavailable, "
                "falling back to stateless run: %s",
                exc,
            )
    graph = build_diagnosis_graph(
        roles=roles,
        task=task,
        conversation_id=conversation_id,
        tools_registry=tools_registry,
        queue=queue,
        cancel_event=cancel_event,
        phase_runner=phase_runner,
        blackboard=bb,
        checkpointer=checkpointer,
    )

    # team_run_id 同时作为 checkpoint 的 thread_id（诊断实例级隔离）
    team_run_id = str(uuid.uuid4())
    run_config: dict[str, Any] = {
        "configurable": {"thread_id": team_run_id}
    }

    agents_info = [
        {"name": r.name, "role": r.display_name}
        for r in roles.values()
    ]
    yield TeamStarted(
        team_run_id=team_run_id,
        team_name="核身诊断团队",
        mode="diagnosis",
        agents=agents_info,
    )

    initial_state: DiagnosisState = {
        "task": task,
        "conversation_id": conversation_id,
        "frontend_output": None,
        "backend_output": None,
        "scoring": None,
        "resolution": None,
        "blackboard": bb.serialize(),
    }

    final_state: dict[str, Any] | None = None
    cancelled = False

    async def _run() -> None:
        nonlocal final_state
        try:
            final_state = await graph.ainvoke(initial_state, config=run_config)
        finally:
            queue.put_nowait(None)

    driver = asyncio.create_task(_run())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
            # 阶段边界取消检测（对应手写版 execute 每阶段后的取消检查）
            if isinstance(item, (AgentCompleted, AgentError)):
                if cancel_event and cancel_event.is_set():
                    yield TeamFailed(error="诊断已被用户取消。")
                    cancelled = True
                    break
    finally:
        if not driver.done():
            driver.cancel()
            try:
                await driver
            except asyncio.CancelledError:
                pass
        elif not driver.cancelled():
            exc = driver.exception()
            if exc is not None:
                raise exc

    # 图正常结束时，若取消在 TeamCompleted 派生前被触发，同样转 TeamFailed
    if not cancelled and cancel_event and cancel_event.is_set():
        yield TeamFailed(error="诊断已被用户取消。")
        cancelled = True

    if not cancelled and final_state is not None:
        yield _build_team_completed(final_state)
