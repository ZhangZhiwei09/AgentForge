"""test_nested_checkpoint —— 父图 checkpoint 实验（multi-agent-langgraph-plan.md §7）。

验证（需要真实 Postgres + AsyncPostgresSaver，DB 不可用时跳过）：
1. 父图挂 AsyncPostgresSaver 后正常跑完，最终状态派生 TeamCompleted 正确。
2. `get_state_history` 能列出中间态快照（frontend 之后、backend 之前）。
3. 模拟阶段崩溃（runner 抛 BaseException，_emit_agent_run 的 except Exception 不捕获）
   后，用同一 thread_id 重新驱动（新图实例模拟新进程）：
   - frontend 不再重跑（断点恢复生效）
   - checkpoint 中的 frontend_output 保留（崩溃前阶段产物不丢）
   - 恢复后继续 backend → leader → resolve 至完成

结论将决定 Phase 2 是否可交付、以及是否需要处理 resume 时的 state 合并语义。
"""

import asyncio
import json
import sys
import uuid

import pytest

from src.agent.checkpoint import get_checkpointer
from src.agent.diagnosis.graph import _build_team_completed, build_diagnosis_graph
from src.agent.diagnosis.mode import (
    AgentCompleted,
    AgentError,
    AgentRole,
    TeamCompleted,
)
from src.agent.tools.registry import ToolRegistry


# ── 最小角色 ────────────────────────────────────────────────


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
    "conclusion": "摄像头权限被拒绝",
    "evidence": [{"type": "observation", "detail": "getUserMedia denied"}],
    "need_escalation": True,
    "escalation_reason": "monitoring_indicates_backend",
    "context_for_backend": {"traceId": "t-1", "failedStage": "upload"},
}, ensure_ascii=False)

BACKEND = json.dumps({
    "conclusion": "算法节点超时",
    "evidence": [{"type": "trace", "detail": "P95 3200ms"}],
}, ensure_ascii=False)

SCORING = json.dumps({
    "frontend_score": 8, "backend_score": 4,
    "frontend_breakdown": {"a": 2}, "backend_breakdown": {"b": 1},
    "reasoning": "前端证据更充分", "synthesis": "以前端结论为主",
    "missing_fields": [], "message": "",
}, ensure_ascii=False)


def _initial_state() -> dict:
    return {
        "task": "用户刷脸失败，报错 FACE_TIMEOUT",
        "conversation_id": "conv-ckpt",
        "frontend_output": None,
        "backend_output": None,
        "scoring": None,
        "resolution": None,
        "blackboard": None,
    }


def _run_events(queue: asyncio.Queue) -> list[str]:
    """把 queue 里已放入的事件名取出来（非阻塞）。"""
    names = []
    while True:
        try:
            names.append(queue.get_nowait().__class__.__name__)
        except asyncio.QueueEmpty:
            return names


class _SimulatedCrash(BaseException):
    """模拟进程崩溃 —— BaseException，不被 _emit_agent_run 的 except Exception 捕获。"""


# ── 实验 ────────────────────────────────────────────────────


@pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning")
def test_nested_checkpoint_parent_checkpoint_and_resume():
    """同步测试壳 —— psycopg 需要 SelectorEventLoop，本测试自管 loop。

    不改全局事件循环策略（避免污染其他测试的 ProactorEventLoop）。
    过滤 Unraisable 警告：AsyncConnectionPool 后台维护任务在 loop.close() 后
    抛 "Event loop is closed"，与本测试断言无关，属资源清理副作用。
    """
    # win32 下显式创建 SelectorEventLoop（psycopg AsyncConnectionPool 依赖）
    loop = (
        asyncio.SelectorEventLoop()
        if sys.platform == "win32"
        else asyncio.new_event_loop()
    )
    try:
        loop.run_until_complete(_run_experiment())
    finally:
        # 不调用 close_checkpointer：AsyncConnectionPool 的后台维护任务在 loop
        # 关闭时会阻塞。直接清掉模块级缓存，防止后续用例复用到绑定已关闭 loop
        # 的 saver/pool（避免 "Lock bound to a different event loop"）。
        _reset_checkpoint_cache()
        loop.close()


def _reset_checkpoint_cache() -> None:
    """丢弃模块级 saver/pool 引用（连接池随进程退出清理）。"""
    import src.agent.checkpoint as ckpt

    ckpt._saver = None
    ckpt._pool = None


async def _run_experiment():
    try:
        saver = await get_checkpointer(required=True)
    except Exception:
        saver = None
    if saver is None:
        pytest.skip("checkpointer unavailable（DB 不可用或事件循环不兼容）")

    thread_id = f"ckpt-experiment-{uuid.uuid4().hex[:8]}"

    # ── 场景 1：正常跑完，检查 checkpoint 中间态快照 ──
    calls = {"frontend": 0, "backend": 0, "leader": 0}

    async def ok_runner(role, task_prompt, conversation_id, registry, cancel_event):
        name = role.name
        calls[name] = calls.get(name, 0) + 1
        if name == "frontend_agent":
            return FRONTEND_ESC
        if name == "backend_agent":
            return BACKEND
        if name == "leader":
            return SCORING
        raise AssertionError(f"unexpected role: {name}")

    queue1 = asyncio.Queue()
    graph1 = build_diagnosis_graph(
        roles=_roles(), task="t", conversation_id="c",
        tools_registry=ToolRegistry(), queue=queue1,
        phase_runner=ok_runner, checkpointer=saver,
    )
    config = {"configurable": {"thread_id": thread_id}}
    final1 = await graph1.ainvoke(_initial_state(), config=config)

    completed = _build_team_completed(final1)
    assert isinstance(completed, TeamCompleted)
    assert completed.output["escalated"] is True

    # checkpoint 历史里应存在"frontend 之后"的中间态：frontend_output 有值、backend_output 为 None
    history = [c async for c in graph1.aget_state_history(config)]
    assert history, "checkpoint 历史不应为空"
    intermediate = next(
        (
            c for c in history
            if (c.values.get("frontend_output") is not None
                and c.values.get("backend_output") is None)
        ),
        None,
    )
    assert intermediate is not None, (
        "未找到 frontend 之后的中间态快照（父图 checkpoint 未按超步粒度保存）"
    )
    assert (
        intermediate.values["frontend_output"].conclusion == "摄像头权限被拒绝"
    ), "中间态快照应含崩溃前阶段产物"

    # ── 场景 2：backend 阶段模拟崩溃 → 同一 thread 恢复 ──
    thread2 = f"{thread_id}-crash"
    config2 = {"configurable": {"thread_id": thread2}}
    crash_calls = {"frontend_agent": 0, "backend_agent": 0, "leader": 0}

    async def crash_runner(role, task_prompt, conversation_id, registry, cancel_event):
        name = role.name
        crash_calls[name] = crash_calls.get(name, 0) + 1
        if name == "frontend_agent":
            return FRONTEND_ESC
        if name == "backend_agent":
            raise _SimulatedCrash("simulated crash in backend phase")
        if name == "leader":
            return SCORING
        raise AssertionError(f"unexpected role: {name}")

    queue2 = asyncio.Queue()
    graph2 = build_diagnosis_graph(
        roles=_roles(), task="t", conversation_id="c",
        tools_registry=ToolRegistry(), queue=queue2,
        phase_runner=crash_runner, checkpointer=saver,
    )
    with pytest.raises(_SimulatedCrash):
        await graph2.ainvoke(_initial_state(), config=config2)

    assert crash_calls["frontend_agent"] == 1
    assert crash_calls["backend_agent"] == 1
    assert crash_calls["leader"] == 0  # 崩溃发生在 backend，leader 未执行
    queue2_names = _run_events(queue2)
    assert "AgentStarted" in queue2_names and "AgentCompleted" in queue2_names
    assert "AgentError" not in queue2_names  # 是崩溃，不是降级

    # ── 恢复：新图实例（模拟新进程）、同 saver、同 thread，backend 改为成功 ──
    # 续跑方式：ainvoke(None) —— 带 None 输入继续同 thread 的 pending 位置（get_state.next），
    # 而不是重传全量 initial_state（那会重置状态、从 START 重跑）。
    # 实验实证：get_state.next=('backend',)，ainvoke(None) 从 backend 续跑，frontend 不重跑。
    recover_calls = {"frontend_agent": 0, "backend_agent": 0, "leader": 0}

    async def recover_runner(role, task_prompt, conversation_id, registry, cancel_event):
        name = role.name
        recover_calls[name] = recover_calls.get(name, 0) + 1
        if name == "frontend_agent":
            return FRONTEND_ESC
        if name == "backend_agent":
            return BACKEND
        if name == "leader":
            return SCORING
        raise AssertionError(f"unexpected role: {name}")

    # 确认崩溃线程确实有待续位置
    pending = await graph2.aget_state(config2)
    assert "backend" in pending.next, f"崩溃线程应待续到 backend，实际 next={pending.next}"

    queue3 = asyncio.Queue()
    graph3 = build_diagnosis_graph(
        roles=_roles(), task="t", conversation_id="c",
        tools_registry=ToolRegistry(), queue=queue3,
        phase_runner=recover_runner, checkpointer=saver,
    )
    final3 = await graph3.ainvoke(None, config=config2)

    # frontend 不重跑（断点恢复生效）
    assert recover_calls["frontend_agent"] == 0, (
        "恢复后 frontend 不应重跑（应从 backend 继续）"
    )
    assert recover_calls["backend_agent"] == 1
    assert recover_calls["leader"] == 1

    # 崩溃前阶段产物保留
    fe = final3.get("frontend_output")
    assert fe is not None and fe.conclusion == "摄像头权限被拒绝", (
        "恢复后 frontend_output 应保留崩溃前产物"
    )

    # 恢复后完整跑完 → TeamCompleted 可派生
    completed3 = _build_team_completed(final3)
    assert completed3.output["escalated"] is True
    assert completed3.output["resolution"] == "adopt_frontend"
