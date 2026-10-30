"""Real SQL, graph, provider-adapter and HTTP task contract regression tests."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import select

from src.agent.tools.base import RegisteredTool, RiskLevel, ToolDefinition, ToolFunction
from src.agent.tools.registry import ToolRegistry
from src.config import settings
from src.models.agent_session import AgentApproval, AgentSession
from src.models.chat import Conversation, Message
from src.schemas.chat import StreamChunk
from src.services import agent_tasks

USER = {"X-Test-Actor": "user"}
OTHER = {"X-Test-Actor": "other"}


class ScriptedProvider:
    def __init__(self):
        self.responses = []
        self.requests = []

    async def stream_chat(self, **kwargs):
        self.requests.append(kwargs)
        if not self.responses:
            raise RuntimeError("Unexpected model call")
        chunks = self.responses.pop(0)
        for chunk in chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


def tool_call(name="write_file", args=None, *, call_id="call-1"):
    return StreamChunk(type="tool_call", tool_call={
        "id": call_id, "name": name, "arguments": json.dumps(args or {"path": "test.txt"}),
    })


def decision(action, **args):
    return tool_call("agent_decide", {
        "action": action, "observation": "观察", "analysis": "分析", "plan": "计划", **args,
    })


def answer(content="操作完成"):
    return [StreamChunk(type="token", content=content), StreamChunk(type="done", usage={
        "prompt_tokens": 100, "completion_tokens": 20,
    })]


def events(response):
    assert response.status_code == 200, response.text
    frames = [line[6:] for line in response.text.splitlines() if line.startswith("data: ")]
    assert frames[-1] == "[DONE]"
    assert frames.count("[DONE]") == 1
    return [json.loads(frame) for frame in frames[:-1]]


@pytest_asyncio.fixture
async def task_api(entry_api, monkeypatch):
    client, sessions = entry_api
    async with sessions() as db:
        db.add(Conversation(id="conv", user_id="user", title="任务"))
        await db.commit()
    provider = ScriptedProvider()
    execute = AsyncMock(return_value={"status": "success", "output": "saved"})
    registry = ToolRegistry()
    registry._initialized = True
    # Explicitly authorize synthetic adapters, never the production file tools.
    monkeypatch.setattr(settings, "agent_allowed_tools", [
        "search_knowledge_base", "write_file", "read_file",
    ])
    for name, approve in [("write_file", True), ("read_file", False)]:
        registry.register(RegisteredTool(
            definition=ToolDefinition(function=ToolFunction(name=name, description="测试工具")),
            execute=execute, require_approval=approve,
            risk_level=RiskLevel.MUTATION if approve else RiskLevel.READ_ONLY,
        ))
    monkeypatch.setattr(agent_tasks, "resolve_model", lambda model: {
        "provider_name": "test", "model_id": model or "test-model",
    })
    monkeypatch.setattr(agent_tasks, "get_provider", lambda name: provider)
    monkeypatch.setattr(agent_tasks, "tool_registry", registry)
    return client, sessions, provider, execute


async def run(client, **kwargs):
    return events(await client.post("/api/agent/run", headers=USER, json={
        "conversation_id": "conv", "task": "保存排查结果", **kwargs,
    }))


async def pause_for_approval(client, provider, *, native=True):
    provider.responses.append([
        tool_call() if native else decision(
            "tool_call", tool="write_file", args_json='{"path":"test.txt"}', reason="保存结果",
        ),
    ])
    stream = await run(client)
    approval = next(event for event in stream if event["type"] == "agent_approval_required")
    assert not any(event["type"] == "agent_done" for event in stream)
    return approval


@pytest.mark.asyncio
async def test_task_completes_and_persists_compatible_dtos(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.append(answer())
    stream = await run(client, max_iterations=20)
    assert stream[0]["type"] == "agent_meta"
    assert stream[-1]["type"] == "agent_done"
    assert stream[0]["max_iterations"] == 20
    session_id = stream[0]["session_id"]
    detail = (await client.get(f"/api/agent-sessions/{session_id}", headers=USER)).json()
    assert detail["status"] == "completed"
    assert detail["conversationId"] == "conv"
    assert detail["scratchpad"][0]["decision"]["action"] == "respond"
    assert detail["completedAt"]
    listing = (await client.get("/api/agent-sessions?conversation_id=conv", headers=USER)).json()
    assert listing[0]["id"] == session_id
    async with sessions() as db:
        saved = list(await db.scalars(select(Message).where(Message.conversation_id == "conv")))
    assert [(message.role, message.content) for message in saved] == [("user", "保存排查结果"), ("assistant", "操作完成")]
    execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [True, False])
async def test_native_and_decision_tools_require_approval_and_modified_args_are_executed(task_api, native):
    client, sessions, provider, execute = task_api
    approval = await pause_for_approval(client, provider, native=native)
    execute.assert_not_awaited()
    provider.responses.append(answer())
    payload = {
        "session_id": approval["session_id"], "approval_id": approval["approval_id"],
        "action": "approve", "modified_args": {"path": "reviewed.txt"},
    }
    stream = events(await client.post("/api/agent/approve", headers=USER, json=payload))
    execute.assert_awaited_once_with({"path": "reviewed.txt"}, "conv")
    assert any(event["type"] == "agent_approval_result" and event["status"] == "approved" for event in stream)
    assert stream[-1]["session_id"] == approval["session_id"]
    listing = (await client.get(
        f"/api/agent/approvals?session_id={approval['session_id']}", headers=USER,
    )).json()
    assert listing[0]["approvedBy"] == "user"
    assert listing[0]["modifiedArgs"] == {"path": "reviewed.txt"}
    detail = (await client.get(f"/api/agent-sessions/{approval['session_id']}", headers=USER)).json()
    assert detail["scratchpad"][0]["result"] == "saved"
    assert detail["scratchpad"][0]["decision"]["args"] == {"path": "reviewed.txt"}
    assert (await client.post("/api/agent/approve", headers=USER, json=payload)).status_code == 400
    execute.assert_awaited_once()
    async with sessions() as db:
        assert (await db.get(AgentSession, approval["session_id"])).status == "completed"


@pytest.mark.asyncio
async def test_rejected_tool_is_not_executed_and_same_session_continues(task_api):
    client, _, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    provider.responses.append(answer("已取消保存"))
    stream = events(await client.post("/api/agent/approve", headers=USER, json={
        "session_id": approval["session_id"], "approval_id": approval["approval_id"],
        "action": "reject", "rejection_reason": "不保存",
    }))
    assert stream[-1]["type"] == "agent_done"
    assert stream[-1]["session_id"] == approval["session_id"]
    assert "不保存" in json.dumps(provider.requests[-1]["messages"], default=str, ensure_ascii=False)
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_clarification_resumes_after_reconstructing_runtime(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.append([decision("ask_user", question="保存到哪里？", clarify_context="需要路径")])
    first = await run(client, model="kept-model", max_iterations=4, tools=["read_file"],
                      guard_config={"denied_tools": ["write_file"], "max_tokens": 20000})
    pause = next(event for event in first if event["type"] == "agent_ask_user")
    session_id = pause["session_id"]
    async with sessions() as db:
        session = await db.get(AgentSession, session_id)
        assert session.status == "paused"
        assert session.runtime_state["guard"]["max_tokens"] == 20000
    provider.responses.append(answer("已确认路径"))
    second = events(await client.post("/api/agent/respond", headers=USER, json={
        "session_id": session_id, "response": "result.txt",
    }))
    assert second[0]["session_id"] == session_id
    assert second[0]["model"] == "kept-model"
    assert second[0]["max_iterations"] == 4
    assert second[-1]["total_steps"] == 2
    assert second[0]["tools_enabled"] == ["read_file"]
    assert provider.requests[-1]["messages"][-1].content == "result.txt"
    assert (await client.post("/api/agent/respond", headers=USER, json={
        "session_id": session_id, "response": "again",
    })).status_code == 400
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_expired_approval_returns_410_and_persists_terminal_state(task_api):
    client, sessions, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    async with sessions() as db:
        record = await db.get(AgentApproval, approval["approval_id"])
        record.requested_at = datetime.now(UTC) - timedelta(minutes=6)
        await db.commit()
    response = await client.post("/api/agent/approve", headers=USER, json={
        "session_id": approval["session_id"], "approval_id": approval["approval_id"], "action": "approve",
    })
    assert response.status_code == 410
    async with sessions() as db:
        assert (await db.get(AgentApproval, approval["approval_id"])).status == "timed_out"
        assert (await db.get(AgentSession, approval["session_id"])).status == "failed"
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_pending_approval_cannot_be_bypassed_by_user_response(task_api):
    client, _, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    response = await client.post("/api/agent/respond", headers=USER, json={
        "session_id": approval["session_id"], "response": "just execute it",
    })
    assert response.status_code == 409
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_completed_calls_in_batch_are_not_repeated_on_approval_resume(task_api):
    client, _, provider, execute = task_api
    provider.responses.append([
        tool_call("read_file", call_id="read"), tool_call("write_file", call_id="write"),
    ])
    first = await run(client)
    approval = next(event for event in first if event["type"] == "agent_approval_required")
    assert execute.await_count == 1
    provider.responses.append(answer())
    resumed = events(await client.post("/api/agent/approve", headers=USER, json={
        "session_id": approval["session_id"], "approval_id": approval["approval_id"], "action": "approve",
    }))
    assert resumed[-1]["type"] == "agent_done"
    assert execute.await_count == 2


@pytest.mark.asyncio
async def test_duplicate_approval_requests_execute_tool_once(task_api):
    client, _, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    provider.responses.append(answer())
    payload = {"session_id": approval["session_id"], "approval_id": approval["approval_id"], "action": "approve"}
    results = await asyncio.gather(*[
        client.post("/api/agent/approve", headers=USER, json=payload) for _ in range(2)
    ])
    assert sorted(response.status_code for response in results) in ([200, 400], [200, 409])
    execute.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("guard,tools", [
    ({"denied_tools": ["read_file"]}, None),
    ({"allowed_tools": ["write_file"]}, None),
    ({}, ["write_file"]),
])
async def test_tool_policy_enforced_even_for_unadvertised_native_calls(task_api, guard, tools):
    client, _, provider, execute = task_api
    provider.responses.extend([[tool_call("read_file")], answer("无法调用该工具")])
    stream = await run(client, guard_config=guard, tools=tools)
    assert any(event["type"] == "agent_guard_block" for event in stream)
    assert stream[-1]["type"] == "agent_done"
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_pii_is_sanitized_before_streaming_and_persistence(task_api):
    client, sessions, provider, _ = task_api
    provider.responses.append(answer("手机号 13812345678"))
    stream = await run(client)
    assert "13812345678" not in json.dumps(stream, ensure_ascii=False)
    assert "13***78" in json.dumps(stream, ensure_ascii=False)
    async with sessions() as db:
        saved = await db.scalar(select(Message).where(Message.role == "assistant"))
        assert "13812345678" not in saved.content


@pytest.mark.asyncio
async def test_failure_and_iteration_exhaustion_are_terminal(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.append([tool_call("read_file")])
    stream = await run(client, max_iterations=1)
    assert stream[-1]["type"] == "agent_error"
    execute.assert_not_awaited()
    async with sessions() as db:
        assert (await db.get(AgentSession, stream[0]["session_id"])).status == "failed"
    provider.responses.append([RuntimeError("provider secret must not leak")])
    stream = await run(client)
    assert stream[-1]["type"] == "agent_error"
    assert "provider secret" not in json.dumps(stream)


@pytest.mark.asyncio
async def test_existing_ts_paused_session_can_resume(task_api):
    client, sessions, provider, _ = task_api
    async with sessions() as db:
        db.add(AgentSession(
            id="legacy", conversation_id="conv", task="查询状态", status="paused",
            scratchpad=[{
                "step": 1, "decision": {"action": "ask_user", "question": "哪个请求？", "context": ""},
            }],
        ))
        await db.commit()
    provider.responses.append(answer())
    stream = events(await client.post("/api/agent/respond", headers=USER, json={
        "session_id": "legacy", "response": "trace-1",
    }))
    assert stream[-1]["session_id"] == "legacy"
    assert stream[-1]["total_steps"] == 2


@pytest.mark.asyncio
async def test_task_endpoints_enforce_auth_ownership_and_inputs(task_api):
    client, _, provider, execute = task_api
    assert (await client.post("/api/agent/run", json={"conversation_id": "conv", "task": "x"})).status_code == 401
    assert (await client.post("/api/agent/run", headers=OTHER, json={"conversation_id": "conv", "task": "x"})).status_code == 404
    assert (await client.post("/api/agent/run", headers=USER, json={"conversation_id": "conv", "task": "x", "max_iterations": 21})).status_code == 422
    for path in ("/api/agent-sessions", "/api/agent/approvals"):
        assert (await client.get(path, headers=USER)).status_code == 400
    approval = await pause_for_approval(client, provider)
    sid = approval["session_id"]
    assert (await client.get(f"/api/agent-sessions/{sid}", headers=OTHER)).status_code == 403
    assert (await client.get(f"/api/agent/approvals?session_id={sid}", headers=OTHER)).status_code == 403
    assert (await client.get("/api/agent-sessions?conversation_id=conv", headers=OTHER)).status_code == 404
    assert (await client.post("/api/agent/respond", headers=OTHER, json={"session_id": sid, "response": "x"})).status_code == 404
    assert (await client.post("/api/agent/approve", headers=OTHER, json={
        "session_id": sid, "approval_id": approval["approval_id"], "action": "approve",
    })).status_code == 404
    assert (await client.post("/api/agent/approve", headers=USER, json={
        "session_id": sid, "approval_id": "missing", "action": "approve",
    })).status_code == 404
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_duplicate_user_responses_claim_same_pause_once(task_api):
    client, _, provider, _ = task_api
    provider.responses.append([decision("ask_user", question="哪个请求？")])
    first = await run(client)
    sid = first[0]["session_id"]
    provider.responses.append(answer())
    results = await asyncio.gather(*[
        client.post("/api/agent/respond", headers=USER, json={"session_id": sid, "response": "trace"})
        for _ in range(2)
    ])
    assert sorted(response.status_code for response in results) in ([200, 400], [200, 409])
    assert len(provider.requests) == 2


@pytest.mark.asyncio
async def test_cancel_during_tool_marks_failed_and_keeps_uncertain_outcome(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.append([tool_call("read_file")])
    started = asyncio.Event()

    async def waiting_tool(*_):
        started.set()
        await asyncio.Future()

    execute.side_effect = waiting_tool
    # Exercise the same generator used by StreamingResponse without HTTPX hiding cancellation.
    state_messages = [
        agent_tasks.SystemMessage(content=agent_tasks.TASK_PROMPT),
        agent_tasks.HumanMessage(content="读取文件"),
    ]
    async with sessions() as db:
        session = AgentSession(
            id="cancel-test", conversation_id="conv", task="读取文件", status="running", scratchpad=[],
            runtime_state={"version": 1, "model": "test-model", "max_iterations": 5, "guard": {}},
        )
        db.add(session)
        await db.commit()
        async def collect():
            async for _ in agent_tasks.stream_task(
                db, session, {"messages": state_messages, "iteration_count": 0},
            ):
                pass
        running = asyncio.create_task(collect())
        await asyncio.wait_for(started.wait(), timeout=5)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
    async with sessions() as db:
        saved = await db.get(AgentSession, "cancel-test")
        assert saved.status == "failed"
        assert saved.runtime_state["executing_call_id"] == "call-1"
    assert (await client.post("/api/agent/respond", headers=USER, json={
        "session_id": "cancel-test", "response": "retry",
    })).status_code == 400
    execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_budget_overrun_prevents_external_tool_execution(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.append([tool_call("read_file"), StreamChunk(type="done", usage={
        "prompt_tokens": 50000, "completion_tokens": 100,
    })])
    stream = await run(client)
    assert stream[-1]["type"] == "agent_error"
    assert any(event["type"] == "agent_guard_block" for event in stream)
    execute.assert_not_awaited()
    async with sessions() as db:
        saved = await db.get(AgentSession, stream[0]["session_id"])
        assert saved.runtime_state["tokens_used"] == 50100


@pytest.mark.asyncio
async def test_legacy_ts_tool_approval_resumes_same_task(task_api):
    client, sessions, provider, execute = task_api
    async with sessions() as db:
        db.add(AgentSession(
            id="legacy-tool", conversation_id="conv", task="保存结果", status="paused",
            scratchpad=[{
                "step": 1, "decision": {
                    "action": "tool_call", "tool": "write_file", "args": {"path": "legacy.txt"},
                    "reason": "保存结果",
                },
            }],
        ))
        await db.flush()
        db.add(AgentApproval(
            id="legacy-approval", session_id="legacy-tool", conversation_id="conv",
            step_number=1, tool_name="write_file", tool_args={"path": "legacy.txt"},
            risk_level="mutation", reason="保存结果",
        ))
        await db.commit()
    provider.responses.append(answer())
    stream = events(await client.post("/api/agent/approve", headers=USER, json={
        "session_id": "legacy-tool", "approval_id": "legacy-approval", "action": "approve",
    }))
    assert stream[-1]["session_id"] == "legacy-tool"
    execute.assert_awaited_once_with({"path": "legacy.txt"}, "conv")


@pytest.mark.asyncio
async def test_unrelated_pending_approval_cannot_fail_or_resume_current_pause(task_api):
    client, sessions, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    async with sessions() as db:
        db.add(AgentApproval(
            id="unrelated", session_id=approval["session_id"], conversation_id="conv",
            step_number=1, tool_name="write_file", tool_args={"path": "test.txt"},
            risk_level="mutation", reason="旧请求", requested_at=datetime.now(UTC) - timedelta(minutes=6),
        ))
        await db.commit()
    assert (await client.post("/api/agent/approve", headers=USER, json={
        "session_id": approval["session_id"], "approval_id": "unrelated", "action": "approve",
    })).status_code == 409
    async with sessions() as db:
        assert (await db.get(AgentSession, approval["session_id"])).status == "paused"
    execute.assert_not_awaited()
