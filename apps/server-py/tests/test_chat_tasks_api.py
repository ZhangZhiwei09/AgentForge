"""Chat uses the actual persisted task graph, citations, pauses and approvals."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from sqlalchemy import select

from src.agent.router import entry_decision
from src.agent.tools.base import RegisteredTool
from src.agent.tools.builtins.search_knowledge import search_knowledge_tool
from src.api.v1 import chat
from src.models.agent_session import AgentApproval, AgentSession
from src.models.chat import Message
from src.rag.types import KnowledgeSearchResult
from src.services import agent_tasks, chat_tasks, citations
from tests import test_agent_tasks_api as task_tests
from tests.test_agent_tasks_api import answer, decision, events, tool_call

task_api = task_tests.task_api

USER = {"X-Test-Actor": "user"}
SOURCE = KnowledgeSearchResult(
    chunk_id="real-chunk", doc_id="real-doc", doc_title="网络排查",
    content="需要检查网络连接，确认权限配置。", score=0.0164, score_type="rrf", fusion_score=0.0164,
)


@pytest_asyncio.fixture
async def chat_task_api(task_api, monkeypatch):
    client, sessions, provider, execute = task_api
    monkeypatch.setattr(chat, "mirror_message", AsyncMock())
    monkeypatch.setattr(chat, "_spawn_compression", MagicMock())
    monkeypatch.setattr("src.agent.context_builder.get_memory_store", lambda: None)
    monkeypatch.setattr(chat, "resolve_model", lambda model: {"provider_name": "test", "model_id": model or "test-model"})
    classifier = AsyncMock(return_value={"status": "valid", "result": {
        "intent": "consultation", "resolvedQuery": "网络排查", "reasoning": "咨询",
    }})
    monkeypatch.setattr(entry_decision, "classify_business_intent", classifier)
    retrieval = AsyncMock(return_value=[SOURCE])
    monkeypatch.setattr(chat_tasks, "retrieval_service", lambda db: SimpleNamespace(retrieve=retrieval))
    monkeypatch.setattr(citations, "get_embedding_provider", lambda: None)
    return client, sessions, provider, execute, classifier, retrieval


async def send(client, message="网络错误如何排查"):
    return events(await client.post("/api/agent/chat", headers=USER, json={
        "message": message, "conversation_id": "conv",
    }))


@pytest.mark.asyncio
async def test_chat_consultation_uses_graph_and_saves_one_guarded_answer(chat_task_api):
    client, sessions, provider, execute, _, retrieval = chat_task_api
    provider.responses.append(answer("需要检查网络连接，确认权限配置。[1]"))
    stream = await send(client)
    assert stream[0]["route"] == "TASK"
    cards = [event["items"] for event in stream if event["type"] == "citations"]
    assert cards[-1][0]["docId"] == "real-doc" and cards[-1][0]["scoreType"] == "rrf"
    assert stream[-1]["agent_session_id"]
    assert stream[-1]["task_status"] == "completed"
    assert stream[-1]["citation"]["coverageRate"] == 1
    assert [event["step"]["status"] for event in stream if event["type"] == "trace_step"] == ["running", "done"]
    async with sessions() as db:
        rows = list(await db.scalars(select(Message).where(Message.conversation_id == "conv")))
        assert len(rows) == 2
        saved = next(row for row in rows if row.role == "assistant")
        assert saved.id == stream[0]["message_id"]
        assert saved.msg_metadata["citations"] == cards[-1]
        session = await db.get(AgentSession, stream[-1]["agent_session_id"])
        assert session.status == "completed"
        assert session.runtime_state["tokens_used"] > 0
    request = provider.requests[0]
    assert any("[1] 网络排查" in str(message) for message in request["messages"])
    retrieval.assert_awaited_once()
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_chat_ask_user_resumes_same_task_without_duplicate_messages(chat_task_api):
    client, sessions, provider, _, classifier, _ = chat_task_api
    provider.responses.append([decision("ask_user", question="请提供 SDK 版本", clarify_context="版本")])
    paused = await send(client)
    assert paused[-1]["task_status"] == "paused"
    assert "".join(event["content"] for event in paused if event["type"] == "token") == "请提供 SDK 版本"
    provider.responses.append(answer("版本已经确认"))
    resumed = await send(client, "SDK 版本是 3.0")
    assert resumed[-1]["agent_session_id"] == paused[-1]["agent_session_id"]
    assert resumed[0]["source"] == "session_state"
    classifier.assert_awaited_once()
    async with sessions() as db:
        rows = list(await db.scalars(select(Message).where(Message.conversation_id == "conv")))
        assert len(rows) == 4
        assert len(list(await db.scalars(select(AgentSession)))) == 1


@pytest.mark.asyncio
async def test_chat_mutation_requires_approval_and_can_resume_via_task_api(chat_task_api):
    client, sessions, provider, execute, _, _ = chat_task_api
    provider.responses.append([tool_call()])
    paused = await send(client)
    assert paused[-1]["task_status"] == "paused"
    execute.assert_not_awaited()
    async with sessions() as db:
        approval = await db.scalar(select(AgentApproval))
        approval_id = approval.id
    waiting = await send(client, "继续")
    assert waiting[-1]["agent_session_id"] == paused[-1]["agent_session_id"]
    assert "等待工具审批" in "".join(event["content"] for event in waiting if event["type"] == "token")
    provider.responses.append(answer("保存完成"))
    response = events(await client.post("/api/agent/approve", headers=USER, json={
        "session_id": paused[-1]["agent_session_id"], "approval_id": approval_id,
        "action": "approve", "modified_args": {"path": "reviewed.txt"},
    }))
    assert response[-1]["type"] == "agent_done"
    execute.assert_awaited_once_with({"path": "reviewed.txt"}, "conv")
    async with sessions() as db:
        assert (await db.get(AgentSession, paused[-1]["agent_session_id"])).status == "completed"


@pytest.mark.asyncio
async def test_chat_cancel_revokes_pending_approval(chat_task_api):
    client, sessions, provider, execute, _, _ = chat_task_api
    provider.responses.append([tool_call()])
    paused = await send(client)
    cancelled = await send(client, "取消排查")
    assert "已取消" in "".join(event["content"] for event in cancelled if event["type"] == "token")
    async with sessions() as db:
        session = await db.get(AgentSession, paused[-1]["agent_session_id"])
        assert session.status == "failed"
        assert (await db.scalar(select(AgentApproval))).status == "rejected"
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_citation_is_removed_before_any_token_is_sent(chat_task_api):
    client, sessions, provider, _, _, _ = chat_task_api
    provider.responses.append(answer("需要检查网络连接 [99]。"))
    stream = await send(client)
    content = "".join(event["content"] for event in stream if event["type"] == "token")
    assert "[99]" not in content
    assert "核实后参考" in content
    assert stream[-1]["citation"]["invalidIndexes"] == [99]
    async with sessions() as db:
        assistant = await db.scalar(select(Message).where(Message.role == "assistant"))
        assert assistant.content == content


@pytest.mark.asyncio
async def test_internal_decision_json_is_never_sent_as_chat_text(chat_task_api):
    client, _, provider, _, _, _ = chat_task_api
    provider.responses.append(answer(json.dumps({
        "observation": "内部观察", "analysis": "内部推理", "plan": "内部计划",
        "action": "tool_call", "tool": "write_file",
    })))
    stream = await send(client)
    content = "".join(event["content"] for event in stream if event["type"] == "token")
    assert "内部" not in content and "write_file" not in content and "暂时无法处理" in content


@pytest.mark.asyncio
async def test_tool_retrieval_replaces_citation_set_and_numbers_model_context(chat_task_api):
    client, sessions, provider, _, _, _ = chat_task_api
    source = {
        "docId": "tool-doc", "chunkId": "tool-chunk", "chunkIndex": 3, "docTitle": "工具检索资料",
        "content": "需要检查权限配置。", "score": 0.02, "scoreType": "rrf",
    }
    execute = AsyncMock(return_value={"status": "success", "output": json.dumps({
        "found": True, "query": "权限", "results": [{"index": 1, **source}],
    })})
    agent_tasks.tool_registry.register(RegisteredTool(
        definition=search_knowledge_tool.definition, execute=execute,
    ))
    provider.responses.extend([
        [tool_call("search_knowledge_base", {"query": "权限"})],
        answer("需要检查权限配置。[1]"),
    ])
    stream = await send(client)
    cards = [event["items"] for event in stream if event["type"] == "citations"]
    assert cards[0][0]["docId"] == "real-doc"
    assert cards[-1][0]["docId"] == "tool-doc"
    assert any("[1] 工具检索资料" in str(message) for message in provider.requests[1]["messages"])
    execute.assert_awaited_once_with({"query": "权限"}, "conv")
    async with sessions() as db:
        task = await db.get(AgentSession, stream[-1]["agent_session_id"])
        assert task.runtime_state["knowledge_results"] == [source]
        assistant = await db.scalar(select(Message).where(Message.role == "assistant"))
        assert assistant.msg_metadata["citations"] == cards[-1]


@pytest.mark.asyncio
async def test_chat_disconnect_during_model_marks_task_failed(chat_task_api, monkeypatch):
    client, sessions, provider, _, _, _ = chat_task_api
    reached = asyncio.Event()

    async def waiting_provider(**kwargs):
        reached.set()
        await asyncio.Future()
        yield

    monkeypatch.setattr(provider, "stream_chat", waiting_provider)
    running = asyncio.create_task(send(client))
    await asyncio.wait_for(reached.wait(), 5)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    async with sessions() as db:
        task = await db.scalar(select(AgentSession))
        assert task.status == "failed"
        assert chat._conversation_locks == {}


@pytest.mark.asyncio
async def test_citation_verifier_embedding_and_keyword_fallback(monkeypatch):
    sources = [{"docId": "d", "docTitle": "资料", "content": "需要检查权限配置", "score": 0.02, "scoreType": "rrf"}]
    embed = AsyncMock(return_value=[[1.0] + [0.0] * 1023] * 2)
    monkeypatch.setattr(citations, "get_embedding_provider", lambda: SimpleNamespace(embed=embed))
    _, report = await citations.verify_answer("需要检查权限配置。", sources)
    assert report["level"] == "embedding" and report["coverageRate"] == 1
    embed.side_effect = RuntimeError("offline")
    _, report = await citations.verify_answer("需要检查权限配置。", sources)
    assert report["level"] == "keyword_fallback" and report["coverageRate"] == 1
    _, report = await citations.verify_answer("必须等待 999 天后审批。", sources)
    assert report["uncitedCount"] == 1


def test_citation_sources_preserve_real_ids_and_ignore_missing_ids():
    output = json.dumps({"found": True, "results": [
        {"docId": "real", "chunkId": "chunk", "content": "证据", "score": 0.02, "scoreType": "rrf"},
        {"content": "无真实来源", "score": 0.9},
    ]})
    sources = citations.parse_sources(output)
    assert len(sources) == 1
    assert citations.citation_cards(sources)[0]["docId"] == "real"
