"""Phase 3b HITL —— interrupt 阶段边界暂停 + 同 thread 续跑。

对应 multi-agent-langgraph-phase3-plan.md §2。验收（§2.4）：
- hitl_enabled=True + Leader 产出 missing_fields → TeamWaitingForInput，无 TeamCompleted。
- 同 thread resume（Command(resume=...)）→ resolve 续跑至 TeamCompleted，user_supplement 携带。
- hitl_enabled=False（默认）→ 行为与现状一致（needs_human 走完）。
- 不传 initial_state 续跑（防重置）—— 参照 test_checkpoint_resume 的 ainvoke(None) 模式。

用 InMemorySaver 注入替代真实 Postgres（HITL 依赖 checkpointer，但测试不依赖 DB）。
"""

import asyncio
import json

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from src.agent.diagnosis.graph import (
    _build_team_completed,
    build_diagnosis_graph,
    resume_langgraph_diagnosis,
    run_langgraph_diagnosis,
)
from src.agent.diagnosis.mode import (
    AgentRole,
    TeamCompleted,
    TeamStarted,
    TeamWaitingForInput,
)
from src.agent.tools.registry import ToolRegistry
from src.config import settings


@pytest.fixture(autouse=True)
def _hitl_defaults(monkeypatch):
    """每个用例显式配置 HITL 开关/超时，避免串扰；默认关闭 checkpoint（测试注入 saver）。"""
    monkeypatch.setattr(settings, "langgraph_diagnosis_checkpoint_enabled", False)
    monkeypatch.setattr(settings, "langgraph_diagnosis_hitl_enabled", False)
    monkeypatch.setattr(settings, "langgraph_diagnosis_stage_timeout_ms", 0)
    monkeypatch.setattr(settings, "langgraph_diagnosis_stage_max_retries", 0)


def _roles() -> dict[str, AgentRole]:
    return {
        "frontend_agent": AgentRole(
            name="frontend_agent", display_name="前端排查专家", description="",
            system_prompt="你是前端排查专家", tools=[], max_iterations=3,
        ),
        "backend_agent": AgentRole(
            name="backend_agent", display_name="后端排查专家", description="",
            system_prompt="你是后端排查专家", tools=[], max_iterations=3,
        ),
        "leader": AgentRole(
            name="leader", display_name="诊断汇总", description="",
            system_prompt="你是诊断汇总专家", tools=[], max_iterations=3,
        ),
    }


FRONTEND_ESC = json.dumps({
    "conclusion": "请求已到达后端但返回异常",
    "evidence": [{"type": "log", "detail": "FACE_TIMEOUT"}],
    "need_escalation": True,
    "escalation_reason": "monitoring_indicates_backend",
    "context_for_backend": {"traceId": "t-1", "failedStage": "upload"},
}, ensure_ascii=False)

BACKEND = json.dumps({
    "conclusion": "算法节点超时",
    "evidence": [{"type": "trace", "detail": "P95 3200ms"}],
}, ensure_ascii=False)

SCORING_WITH_MISSING = json.dumps({
    "frontend_score": 1, "backend_score": 1,
    "frontend_breakdown": {}, "backend_breakdown": {},
    "reasoning": "信息不足，无法定论",
    "synthesis": "需要补充信息",
    "missing_fields": ["traceId", "具体失败时间"],
    "message": "请补充 traceId 与具体失败时间。",
}, ensure_ascii=False)


def _runner_with_missing_fields():
    """fake runner：Leader 产出带 missing_fields 的评分 → 触发 clarify 分支。"""
    async def runner(role, task_prompt, conversation_id, registry, cancel_event):
        name = role.name
        if name == "frontend_agent":
            return FRONTEND_ESC
        if name == "backend_agent":
            return BACKEND
        if name == "leader":
            return SCORING_WITH_MISSING
        raise AssertionError(f"unexpected role: {name}")
    return runner


def _initial_state() -> dict:
    return {
        "task": "用户刷脸失败，报错 FACE_TIMEOUT",
        "conversation_id": "conv-hitl",
        "frontend_output": None,
        "backend_output": None,
        "scoring": None,
        "resolution": None,
        "blackboard": None,
        "user_supplement": None,
    }


async def _collect_run(monkeypatch, *, hitl: bool, saver=None):
    monkeypatch.setattr(settings, "langgraph_diagnosis_hitl_enabled", hitl)
    events = []
    async for ev in run_langgraph_diagnosis(
        roles=_roles(),
        task="用户刷脸失败，报错 FACE_TIMEOUT",
        conversation_id="conv-hitl",
        tools_registry=ToolRegistry(),
        phase_runner=_runner_with_missing_fields(),
        checkpointer=saver,
    ):
        events.append(ev)
    return events


class TestHitlInterrupt:
    """hitl 开 + Leader 判定信息不足 → TeamWaitingForInput，无 TeamCompleted。"""

    @pytest.mark.asyncio
    async def test_hitl_interrupt(self, monkeypatch):
        events = await _collect_run(monkeypatch, hitl=True, saver=InMemorySaver())
        seq = [type(ev).__name__ for ev in events]
        assert seq == [
            "TeamStarted", "AgentStarted", "AgentCompleted",
            "AgentStarted", "AgentCompleted",
            "AgentStarted", "AgentCompleted",
            "TeamWaitingForInput",
        ]
        assert not any(isinstance(ev, TeamCompleted) for ev in events)
        waiting = events[-1]
        assert isinstance(waiting, TeamWaitingForInput)
        assert waiting.missing_fields == ["traceId", "具体失败时间"]
        assert waiting.message == "请补充 traceId 与具体失败时间。"
        assert waiting.team_run_id  # 供 route_agent 记录续跑点


class TestHitlResume:
    """同一 thread 续跑 → TeamCompleted；user_supplement 携带。"""

    @pytest.mark.asyncio
    async def test_hitl_resume_generator(self, monkeypatch):
        """经 resume_langgraph_diagnosis 公开入口续跑 → TeamCompleted。"""
        monkeypatch.setattr(settings, "langgraph_diagnosis_hitl_enabled", True)
        saver = InMemorySaver()

        events = []
        async for ev in run_langgraph_diagnosis(
            roles=_roles(),
            task="用户刷脸失败，报错 FACE_TIMEOUT",
            conversation_id="conv-hitl",
            tools_registry=ToolRegistry(),
            phase_runner=_runner_with_missing_fields(),
            checkpointer=saver,
        ):
            events.append(ev)
        assert isinstance(events[-1], TeamWaitingForInput)
        team_run_id = events[0].team_run_id
        assert team_run_id

        resumed = []
        async for ev in resume_langgraph_diagnosis(
            roles=_roles(),
            conversation_id="conv-hitl",
            tools_registry=ToolRegistry(),
            team_run_id=team_run_id,
            user_input="补充：traceId=abc，具体失败时间 10:03",
            checkpointer=saver,
        ):
            resumed.append(ev)
        assert isinstance(resumed[-1], TeamCompleted)
        # scoring 1/1 → needs_human（resolve 续跑产物）
        assert resumed[-1].output["resolution"] == "needs_human"

    @pytest.mark.asyncio
    async def test_hitl_resume_carries_user_supplement(self, monkeypatch):
        """图级断言：Command(resume=...) 续跑后 DiagnosisState 携带 user_supplement。"""
        monkeypatch.setattr(settings, "langgraph_diagnosis_hitl_enabled", True)
        saver = InMemorySaver()
        config = {"configurable": {"thread_id": "hitl-thread-1"}}

        graph = build_diagnosis_graph(
            roles=_roles(), task="t", conversation_id="c",
            tools_registry=ToolRegistry(), queue=asyncio.Queue(),
            phase_runner=_runner_with_missing_fields(), checkpointer=saver,
        )
        final1 = await graph.ainvoke(_initial_state(), config=config)
        assert final1.get("__interrupt__"), "应触发 interrupt 暂停"

        # 续跑：不传 initial_state（防重置），Command(resume=...) 恢复
        user_input = "补充：traceId=abc，具体失败时间 10:03"
        final2 = await graph.ainvoke(
            Command(resume=user_input), config=config
        )
        assert final2.get("user_supplement") == user_input, (
            "user_supplement 应携带用户补充内容"
        )
        completed = _build_team_completed(final2)
        assert isinstance(completed, TeamCompleted)
        assert completed.output["resolution"] == "needs_human"


class TestHitlDisabledByDefault:
    """默认关 → needs_human 走完，无 TeamWaitingForInput（与现状一致）。"""

    @pytest.mark.asyncio
    async def test_hitl_disabled_by_default(self, monkeypatch):
        events = await _collect_run(monkeypatch, hitl=False, saver=None)
        assert isinstance(events[-1], TeamCompleted)
        assert events[-1].output["resolution"] == "needs_human"
        assert not any(isinstance(ev, TeamWaitingForInput) for ev in events)

    @pytest.mark.asyncio
    async def test_hitl_no_checkpointer_degrades(self, monkeypatch):
        """hitl 开但 checkpointer 不可用 → 自动降级 needs_human，不抛错。"""
        events = await _collect_run(monkeypatch, hitl=True, saver=None)
        assert isinstance(events[-1], TeamCompleted)
        assert events[-1].output["resolution"] == "needs_human"
        assert not any(isinstance(ev, TeamWaitingForInput) for ev in events)
