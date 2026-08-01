"""DiagnosisRouteAgent 元事件契约测试。

meta 事件必须携带 conversation_id —— 前端靠 meta 事件的 conversation_id 持久化
会话（localStorage `agent_chat_conversation_id`，见 useAgentChatStream.ts），
缺失会导致每次诊断都新建会话、UI 上会话不连续。
行为对齐 TS: diagnosis-agent.ts 的 meta 事件（带 conversationId/sessionId）。
"""

import pytest

from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.tools.registry import ToolRegistry
from src.agent.types import RouteContext, StreamMeta


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
