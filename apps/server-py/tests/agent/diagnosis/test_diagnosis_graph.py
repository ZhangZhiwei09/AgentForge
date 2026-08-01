"""LangGraph 版 DiagnosisMode 的图级测试。

对应 multi-agent-langgraph-plan.md §7 新增图级测试。
使用注入的 fake phase_runner 替代真实 LLM 调用，覆盖：
编译、Fast Track、升级链路、规则覆盖、事件序列、决议分支、取消。
"""

import asyncio
import json

import pytest

from src.agent.diagnosis.graph import (
    build_diagnosis_graph,
    run_langgraph_diagnosis,
)
from src.agent.diagnosis.mode import (
    AgentCompleted,
    AgentRole,
    AgentStarted,
    DiagnosisMode,
    TeamCompleted,
    TeamFailed,
    TeamStarted,
)
from src.agent.tools.registry import ToolRegistry
from src.config import settings


@pytest.fixture(autouse=True)
def _disable_team_checkpoint(monkeypatch):
    """图单测测的是图逻辑/事件序列（fake runner），不测 checkpoint。

    关闭团队级 checkpoint，避免每个用例真实创建 AsyncPostgresSaver
    （DB 依赖 + 与 test_checkpoint_resume 的模块级 saver 缓存互相污染）。
    checkpoint 行为由 test_checkpoint_resume.py 专项验证。
    """
    monkeypatch.setattr(settings, "langgraph_diagnosis_checkpoint_enabled", False)


# ── 测试用角色 ────────────────────────────────────────────


def _roles() -> dict[str, AgentRole]:
    return {
        "frontend_agent": AgentRole(
            name="frontend_agent",
            display_name="前端排查专家",
            description="",
            system_prompt="你是前端排查专家",
            tools=[],
            max_iterations=3,
        ),
        "backend_agent": AgentRole(
            name="backend_agent",
            display_name="后端排查专家",
            description="",
            system_prompt="你是后端排查专家",
            tools=[],
            max_iterations=3,
        ),
        "leader": AgentRole(
            name="leader",
            display_name="诊断汇总",
            description="",
            system_prompt="你是诊断汇总专家",
            tools=[],
            max_iterations=3,
        ),
    }


# ── 固定 LLM 输出样本 ─────────────────────────────────────

FRONTEND_NO_ESC = json.dumps({
    "conclusion": "摄像头权限被拒绝",
    "evidence": [{"type": "observation", "detail": "getUserMedia denied"}],
    "need_escalation": False,
    "escalation_reason": None,
    "context_for_backend": {},
}, ensure_ascii=False)

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


def _scoring(fe_score: int = 8, be_score: int = 4) -> str:
    return json.dumps({
        "frontend_score": fe_score,
        "backend_score": be_score,
        "frontend_breakdown": {
            "evidence_quality": 2, "verifiability": 2,
            "coverage": 2, "domain_authority": 2,
        },
        "backend_breakdown": {
            "evidence_quality": 1, "verifiability": 1,
            "coverage": 1, "domain_authority": 1,
        },
        "reasoning": "前端证据更充分",
        "synthesis": "以前端结论为主",
        "missing_fields": [],
        "message": "",
    }, ensure_ascii=False)


def _make_runner(**overrides):
    """构造 fake runner：按角色返回固定 JSON 输出。"""
    async def runner(role, task_prompt, conversation_id, registry, cancel_event):
        name = role.name
        if name == "frontend_agent":
            return overrides.get("frontend", FRONTEND_ESC)
        if name == "backend_agent":
            return overrides.get("backend", BACKEND)
        if name == "leader":
            return overrides.get("leader", _scoring())
        raise AssertionError(f"unexpected role: {name}")
    return runner


async def _collect(roles, runner, cancel=None):
    events = []
    async for ev in run_langgraph_diagnosis(
        roles=roles,
        task="用户刷脸失败，报错 FACE_TIMEOUT",
        conversation_id="conv-1",
        tools_registry=ToolRegistry(),
        cancel_event=cancel,
        phase_runner=runner,
    ):
        events.append(ev)
    return events


# ── 测试 ──────────────────────────────────────────────────


class TestDiagnosisGraphCompile:
    """图可编译、节点/边存在。"""

    @pytest.mark.asyncio
    async def test_compile(self):
        graph = build_diagnosis_graph(
            roles=_roles(),
            task="t",
            conversation_id="c",
            tools_registry=ToolRegistry(),
            queue=asyncio.Queue(),
        )
        node_names = {
            n for n in graph.nodes
            if n not in ("__start__", "__end__")
        }
        assert node_names == {
            "frontend", "backend", "leader", "resolve", "fast_track",
        }


class TestDiagnosisGraphFastTrack:
    """只跑 frontend 阶段 → TeamCompleted(frontend_only)。"""

    @pytest.mark.asyncio
    async def test_fast_track(self):
        events = await _collect(
            _roles(), _make_runner(frontend=FRONTEND_NO_ESC)
        )
        assert isinstance(events[0], TeamStarted)
        assert isinstance(events[-1], TeamCompleted)

        agent_names = [
            ev.agent_name for ev in events if isinstance(ev, AgentStarted)
        ]
        assert agent_names == ["frontend_agent"]
        assert sum(
            isinstance(ev, AgentCompleted) for ev in events
        ) == 1

        completed = events[-1]
        assert completed.output["resolution"] == "frontend_only"
        assert completed.output["escalated"] is False
        assert completed.output["conclusion"] == "摄像头权限被拒绝"
        assert completed.rounds_count == 1


class TestDiagnosisGraphEscalationPath:
    """frontend → backend → leader → resolve 全链路。"""

    @pytest.mark.asyncio
    async def test_escalation_path(self):
        events = await _collect(_roles(), _make_runner())
        agent_names = [
            ev.agent_name for ev in events if isinstance(ev, AgentStarted)
        ]
        assert agent_names == ["frontend_agent", "backend_agent", "leader"]
        assert sum(
            isinstance(ev, AgentCompleted) for ev in events
        ) == 3

        completed = events[-1]
        assert completed.rounds_count == 3
        assert completed.output["escalated"] is True
        # frontend 8 vs backend 4 → 采纳前端
        assert completed.output["resolution"] == "adopt_frontend"


class TestDiagnosisGraphRuleOverride:
    """LLM 漏判但 check_rule_escalation 命中 → 强制升级。"""

    @pytest.mark.asyncio
    async def test_rule_override(self):
        frontend = json.dumps({
            "conclusion": "FACE_TIMEOUT occurred at upload stage",
            "evidence": [],
            "need_escalation": False,
            "escalation_reason": None,
            "context_for_backend": {},
        }, ensure_ascii=False)
        events = await _collect(_roles(), _make_runner(frontend=frontend))
        agent_names = [
            ev.agent_name for ev in events if isinstance(ev, AgentStarted)
        ]
        # 文本含 FACE_TIMEOUT → 即便 LLM 标记不升级也强制走升级链路
        assert agent_names == ["frontend_agent", "backend_agent", "leader"]
        completed = events[-1]
        assert completed.output["escalated"] is True


class TestDiagnosisGraphEventSequence:
    """完整 TeamStreamEvent 序列与手写版一致。"""

    @pytest.mark.asyncio
    async def test_event_sequence(self):
        events = await _collect(_roles(), _make_runner())
        seq = [type(ev).__name__ for ev in events]
        assert seq == [
            "TeamStarted",
            "AgentStarted", "AgentCompleted",
            "AgentStarted", "AgentCompleted",
            "AgentStarted", "AgentCompleted",
            "TeamCompleted",
        ]


class TestDiagnosisGraphResolutionBranches:
    """needs_human / adopt_* / divergent 各分支。"""

    @pytest.mark.asyncio
    async def test_needs_human(self):
        events = await _collect(
            _roles(), _make_runner(leader=_scoring(2, 2))
        )
        assert events[-1].output["resolution"] == "needs_human"

    @pytest.mark.asyncio
    async def test_adopt_backend(self):
        events = await _collect(
            _roles(), _make_runner(leader=_scoring(3, 7))
        )
        assert events[-1].output["resolution"] == "adopt_backend"

    @pytest.mark.asyncio
    async def test_divergent(self):
        events = await _collect(
            _roles(), _make_runner(leader=_scoring(6, 5))
        )
        assert events[-1].output["resolution"] == "divergent"


class TestDiagnosisGraphCancel:
    """cancel_event.set() → TeamFailed，不产出 TeamCompleted。"""

    @pytest.mark.asyncio
    async def test_cancel(self):
        cancel = asyncio.Event()
        cancel.set()
        events = await _collect(_roles(), _make_runner(), cancel=cancel)
        assert isinstance(events[-1], TeamFailed)
        assert not any(isinstance(ev, TeamCompleted) for ev in events)


class TestDiagnosisModeGraphPath:
    """DiagnosisMode.execute 恒走 LangGraph 图路径（Phase 2 删除旧编排后）。

    缺失 frontend_role 时图路径产出 TeamFailed（无需 LLM 即可验证路由）。
    """

    @pytest.mark.asyncio
    async def test_missing_frontend_yields_team_failed(self):
        events = []
        async for ev in DiagnosisMode().execute(
            {}, "task", "conv-1", ToolRegistry()
        ):
            events.append(ev)
        assert len(events) == 1
        assert isinstance(events[0], TeamFailed)
