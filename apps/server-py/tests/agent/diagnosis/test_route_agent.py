"""DiagnosisRouteAgent 元事件契约测试。

meta 事件必须携带 conversation_id —— 前端靠 meta 事件的 conversation_id 持久化
会话（localStorage `agent_chat_conversation_id`，见 useAgentChatStream.ts），
缺失会导致每次诊断都新建会话、UI 上会话不连续。
行为对齐 TS: diagnosis-agent.ts 的 meta 事件（带 conversationId/sessionId）。
"""

import pytest

from src.agent.diagnosis.mode import TeamWaitingForInput
from src.agent.diagnosis.route_agent import (
    DiagnosisRouteAgent,
    _translate_team_event,
)
from src.agent.tools.registry import ToolRegistry
from src.agent.types import (
    DiagnosisWaitingInput,
    RouteContext,
    StreamMeta,
)
from src.api.v1.chat import _to_sse


async def _first_event(ctx: RouteContext):
    agent = DiagnosisRouteAgent()
    async for ev in agent.execute(ctx, ToolRegistry()):
        return ev
    return None


@pytest.mark.asyncio
async def test_meta_carries_conversation_id():
    """meta 事件首个产出，必须带 conversation_id 与 session_id。"""
    ctx = RouteContext(
        conversation_id="conv-route-agent",
        session_id="sess-1",
        assistant_msg_id="msg-1",
        resolved_model="deepseek-v4-pro",
        provider_name="openai",
        intent="diagnosis",
    )
    ev = await _first_event(ctx)
    assert isinstance(ev, StreamMeta)
    assert ev.conversation_id == "conv-route-agent"
    assert ev.session_id == "sess-1"
    assert ev.route == "DIAGNOSIS"
    assert ev.message_id == "msg-1"


@pytest.mark.asyncio
async def test_translate_waiting_input():
    """TeamWaitingForInput → DiagnosisWaitingInput，message/missing_fields 必须携带。

    前端靠该字段渲染补充表单（Phase 3b），缺失会导致用户不知道缺什么。
    """
    team_ev = TeamWaitingForInput(
        team_run_id="team-hitl-1",
        message="请补充 traceId 与具体失败时间。",
        missing_fields=["traceId", "具体失败时间"],
    )
    ev = _translate_team_event(team_ev, "msg-1")
    assert isinstance(ev, DiagnosisWaitingInput)
    assert ev.message == "请补充 traceId 与具体失败时间。"
    assert ev.missing_fields == ["traceId", "具体失败时间"]
    assert ev.message_id == "msg-1"


@pytest.mark.asyncio
async def test_waiting_input_sse_payload():
    """chat.py SSE 序列化必须输出 message/missing_fields（此前掉进 else 兜底被丢弃）。"""
    ev = DiagnosisWaitingInput(
        message_id="msg-1",
        message="请补充 traceId 与具体失败时间。",
        missing_fields=["traceId", "具体失败时间"],
    )

    async def gen():
        yield ev

    lines = [line async for line in _to_sse(gen())]
    assert len(lines) == 1
    payload = lines[0]
    assert '"diagnosis_waiting_input"' in payload
    assert '"message"' in payload
    assert '"请补充 traceId 与具体失败时间。"' in payload
    assert '"traceId"' in payload and '"具体失败时间"' in payload
