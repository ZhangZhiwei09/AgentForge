"""Provider wire usage, adapter propagation and durable task accounting regressions."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import HumanMessage
from openai.types.chat import ChatCompletionChunk
from sqlalchemy import select

from src.agent.chat_agent import ChatAgent
from src.agent.executor import AgentExecutor
from src.agent.langchain_adapter import ProviderChatModel
from src.agent.react_graph import build_react_graph
from src.agent.tools.registry import ToolRegistry
from src.agent.types import RouteContext, StreamDone
from src.models.agent_session import AgentSession
from src.providers.openai_provider import OpenAIProvider
from src.schemas.chat import ChatMessage, StreamChunk
from src.services import agent_tasks
from src.services.execution_policy import ToolExecutionContext, build_execution_policy
from src.services.usage import normalize_usage, reserve_task_usage, settle_task_usage
from tests.test_agent_tasks_api import (
    USER,
    ScriptedProvider,
    answer,
    decision,
    events,
    run,
    task_api,
    tool_call,
)

__all__ = ["task_api"]


def wire_chunk(*, text=None, usage=None, tools=None, finish=None):
    return ChatCompletionChunk(
        id="synthetic", created=0, model="test-model", object="chat.completion.chunk",
        choices=[{"index": 0, "delta": {"content": text, "tool_calls": tools}, "finish_reason": finish}]
        if text is not None or tools or finish else [], usage=usage,
    )


class FakeStream:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.close = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = next(self.chunks, None)
        if item is None:
            raise StopAsyncIteration
        if isinstance(item, BaseException):
            raise item
        return item


def provider_for(monkeypatch, chunks):
    stream = FakeStream(chunks)
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=stream))))
    monkeypatch.setattr("src.providers.openai_provider.AsyncOpenAI", lambda **kwargs: client)
    return OpenAIProvider("test"), stream


@pytest.mark.parametrize("prompt, completion", [(17, 4), (0, 0)])
async def test_usage_only_frame_survives_empty_choices(monkeypatch, prompt, completion):
    provider, stream = provider_for(monkeypatch, [
        wire_chunk(text="hello"),
        wire_chunk(usage={"prompt_tokens": prompt, "completion_tokens": completion,
                          "total_tokens": prompt + completion}),
    ])
    chunks = [chunk async for chunk in provider.stream_chat([ChatMessage(role="user", content="hi")], "test")]
    assert [chunk.type for chunk in chunks] == ["token", "done"]
    assert chunks[-1].usage == {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
    stream.close.assert_awaited_once()


async def test_missing_usage_is_unknown_not_zero(monkeypatch):
    provider, stream = provider_for(monkeypatch, [wire_chunk(text="hello"), wire_chunk(finish="stop")])
    chunks = [chunk async for chunk in provider.stream_chat([], "test")]
    assert chunks[-1].usage is None
    stream.close.assert_awaited_once()


@pytest.mark.parametrize("intermediate_usage", [
    None, {"prompt_tokens": 17, "completion_tokens": 4, "total_tokens": 21},
])
async def test_eof_without_completion_or_terminal_usage_is_not_success(monkeypatch, intermediate_usage):
    provider, stream = provider_for(monkeypatch, [wire_chunk(text="partial", usage=intermediate_usage)])
    chunks = []
    with pytest.raises(RuntimeError, match="completion marker"):
        async for chunk in provider.stream_chat([], "test"):
            chunks.append(chunk)
    assert [chunk.type for chunk in chunks] == ["token"]
    stream.close.assert_awaited_once()


def test_legacy_usage_remains_unclassified_in_summary():
    from src.services.usage import task_usage_summary

    result = task_usage_summary({"tokens_used": 100})
    assert result["unclassified_tokens"] == 100 and result["source"] == "unavailable"


@pytest.mark.parametrize("failure", [RuntimeError("stream interrupted"), asyncio.CancelledError()])
async def test_stream_failure_closes_upstream_without_success_done(monkeypatch, failure):
    provider, stream = provider_for(monkeypatch, [wire_chunk(text="partial"), failure])
    chunks = []
    with pytest.raises(type(failure)):
        async for chunk in provider.stream_chat([], "test"):
            chunks.append(chunk)
    assert [chunk.type for chunk in chunks] == ["token"]
    stream.close.assert_awaited_once()


async def test_early_consumer_close_does_not_yield_during_generator_exit(monkeypatch):
    provider, stream = provider_for(monkeypatch, [wire_chunk(text="first"), wire_chunk(text="second")])
    output = provider.stream_chat([], "test")
    assert (await anext(output)).content == "first"
    await output.aclose()
    stream.close.assert_awaited_once()


async def test_fragmented_tools_and_terminal_usage_both_survive(monkeypatch):
    provider, stream = provider_for(monkeypatch, [
        wire_chunk(tools=[{"index": 0, "id": "call-1", "function": {"name": "calculator", "arguments": '{"expression":'}}]),
        wire_chunk(tools=[{"index": 0, "function": {"arguments": '"1+1"}'}}]),
        wire_chunk(usage={"prompt_tokens": 17, "completion_tokens": 4, "total_tokens": 21}),
    ])
    result = await ProviderChatModel(provider, "test").ainvoke([HumanMessage(content="calculate")])
    assert result.tool_calls[0]["args"] == {"expression": "1+1"}
    assert result.usage_metadata["total_tokens"] == 21
    assert result.response_metadata["usage_source"] == "reported"
    stream.close.assert_awaited_once()


@pytest.mark.parametrize("usage, source", [
    ({"prompt_tokens": 0, "completion_tokens": 0}, "reported"),
    (None, "estimated"), ({}, "estimated"),
])
async def test_adapter_marks_estimates_and_preserves_reported_zero(usage, source):
    provider = ScriptedProvider()
    provider.responses.append([StreamChunk(type="token", content="answer"), StreamChunk(type="done", usage=usage)])
    model = ProviderChatModel(provider, "test")
    result = await model.ainvoke([HumanMessage(content="hello")])
    assert result.response_metadata["usage_source"] == source
    assert (result.usage_metadata["total_tokens"] == 0) is (source == "reported")


@pytest.mark.parametrize("usage", [
    {}, {"prompt_tokens": -1, "completion_tokens": 4},
    {"prompt_tokens": True, "completion_tokens": 4},
    {"prompt_tokens": "17", "completion_tokens": 4},
    {"prompt_tokens": 17, "completion_tokens": float("inf")},
])
def test_invalid_usage_is_not_billed_as_reported(usage):
    assert normalize_usage(usage) is None


async def test_react_generation_receives_usage_and_provenance(monkeypatch):
    provider = ScriptedProvider()
    provider.responses.append(answer())
    span = MagicMock()
    obs = SimpleNamespace(create_generation=MagicMock(return_value=span))
    monkeypatch.setattr("src.observability.get_observability", lambda: obs)
    graph = build_react_graph(ProviderChatModel(provider, "test"), [], ToolRegistry(), "conv")
    result = await graph.ainvoke({"messages": [HumanMessage(content="hello")], "iteration_count": 0})
    assert result["messages"][-1].response_metadata["usage_source"] == "reported"
    call = next(call for call in span.end.call_args_list if call.kwargs.get("usage"))
    assert call.kwargs["usage"] == {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    assert call.kwargs["metadata"]["usage_source"] == "reported"


async def test_transient_executor_reports_sum_of_model_calls(task_api, monkeypatch):
    _, _, provider, _ = task_api
    monkeypatch.setattr("src.agent.executor.resolve_model", lambda _: {"provider_name": "test", "model_id": "test"})
    monkeypatch.setattr("src.agent.executor.get_provider", lambda _: provider)
    provider.responses.extend([
        [tool_call("read_file"), StreamChunk(type="done", usage={"prompt_tokens": 17, "completion_tokens": 4})],
        answer(),
    ])
    context = RouteContext(
        conversation_id="conv", user_message="read", execution_context=ToolExecutionContext(
            actor_id="user", conversation_id="conv", run_id="test", policy=build_execution_policy(),
        ),
    )
    executor = AgentExecutor(registry=agent_tasks.tool_registry, checkpoint=False)
    emitted = [event async for event in executor.execute(context)]
    assert isinstance(emitted[-1], StreamDone) and emitted[-1].validated
    assert emitted[-1].usage == {"prompt_tokens": 117, "completion_tokens": 24, "total_tokens": 141, "source": "reported"}


async def test_chat_agent_reports_stream_usage(monkeypatch):
    provider = ScriptedProvider()
    provider.responses.append(answer())
    monkeypatch.setattr("src.agent.chat_agent.resolve_model", lambda _: {"provider_name": "test", "model_id": "test"})
    monkeypatch.setattr("src.agent.chat_agent.get_provider", lambda _: provider)
    emitted = [event async for event in ChatAgent().execute(RouteContext(user_message="hello"))]
    assert emitted[-1].usage["total_tokens"] == 120
    assert emitted[-1].usage["source"] == "reported"


def test_settlement_is_idempotent_and_unknown_outcome_keeps_reservation():
    runtime = {"tokens_used": 100, "cost_cents_used": 1}
    reserve_task_usage(runtime, "unknown-model", 200, 50)
    assert settle_task_usage(runtime, None, "reserved", uncertain=True)
    assert not settle_task_usage(runtime, {"prompt_tokens": 1, "completion_tokens": 1}, "reported")
    assert runtime["tokens_used"] == 350
    assert runtime["usage_uncertain"]
    assert runtime["usage_totals"]["reserved"]["total_tokens"] == 250
    assert runtime["model_usage"][0]["status"] == "uncertain"
    assert runtime["model_usage"][0]["cost_source"] == "estimate"
    assert runtime["model_usage"][0]["rate_version"]
    assert runtime["model_usage"][0]["rate_source"] == "fallback_estimate"


@pytest.mark.parametrize("usage, source", [({"prompt_tokens": 0, "completion_tokens": 0}, "reported"), (None, "estimated")])
async def test_task_persists_usage_source_and_does_not_replace_zero(task_api, usage, source):
    client, sessions, provider, _ = task_api
    provider.responses.append([StreamChunk(type="token", content="answer"), StreamChunk(type="done", usage=usage)])
    events = await run(client)
    assert events[-1]["type"] == "agent_done"
    async with sessions() as db:
        runtime = (await db.scalar(select(AgentSession))).runtime_state
        assert runtime["pending_model_usage"] is None
        assert runtime["model_usage"][0]["source"] == source
        assert (runtime["tokens_used"] == 0) is (source == "reported")
        assert runtime["cost_source"] == "estimate"


async def test_invalid_decision_does_not_erase_reported_usage(task_api):
    client, sessions, provider, _ = task_api
    provider.responses.append([
        tool_call("agent_decide", {"action": "unknown"}),
        StreamChunk(type="done", usage={"prompt_tokens": 17, "completion_tokens": 4}),
    ])
    events = await run(client)
    assert events[-1]["type"] == "agent_error"
    async with sessions() as db:
        saved = await db.scalar(select(AgentSession))
        assert saved.status == "failed"
        assert saved.runtime_state["tokens_used"] == 21
        assert saved.runtime_state["usage_totals"]["reported"]["total_tokens"] == 21


async def test_multiple_model_calls_and_resume_accumulate_once(task_api):
    client, sessions, provider, _ = task_api
    provider.responses.extend([
        [tool_call("read_file"), StreamChunk(type="done", usage={"prompt_tokens": 17, "completion_tokens": 4})],
        [decision("ask_user", question="which request?"),
         StreamChunk(type="done", usage={"prompt_tokens": 20, "completion_tokens": 5})],
    ])
    first = await run(client)
    sid = first[0]["session_id"]
    provider.responses.append(answer())
    continued = events(await client.post("/api/agent/respond", headers=USER, json={
        "session_id": sid, "response": "request-one",
    }))
    assert continued[-1]["usage"]["total_tokens"] == 166
    async with sessions() as db:
        runtime = (await db.get(AgentSession, sid)).runtime_state
        assert runtime["tokens_used"] == 166
        assert len(runtime["model_usage"]) == 3
        assert len({record["call_id"] for record in runtime["model_usage"]}) == 3
        assert runtime["pending_model_usage"] is None


async def test_final_answer_cannot_claim_success_after_reported_budget_overrun(task_api):
    client, sessions, provider, _ = task_api
    provider.responses.append([
        StreamChunk(type="token", content="answer"),
        StreamChunk(type="done", usage={"prompt_tokens": 50000, "completion_tokens": 100}),
    ])
    stream = await run(client)
    assert stream[-1]["type"] == "agent_error" and stream[-1]["usage"]["total_tokens"] == 50100
    async with sessions() as db:
        assert (await db.scalar(select(AgentSession))).status == "failed"


async def test_interrupted_model_request_retains_conservative_usage(task_api):
    client, sessions, provider, _ = task_api
    provider.responses.append([StreamChunk(type="token", content="partial"), RuntimeError("interrupted")])
    events = await run(client)
    assert events[-1]["type"] == "agent_error"
    async with sessions() as db:
        runtime = (await db.scalar(select(AgentSession))).runtime_state
        assert runtime["usage_uncertain"]
        assert runtime["tokens_used"] >= provider.requests[0]["max_tokens"]
        assert runtime["model_usage"][0]["status"] == "uncertain"


async def test_cancelled_model_request_retains_reservation(task_api, monkeypatch):
    _, sessions, provider, _ = task_api
    started = asyncio.Event()

    async def waiting(**kwargs):
        started.set()
        await asyncio.Future()
        yield StreamChunk(type="done")

    monkeypatch.setattr(provider, "stream_chat", waiting)
    async with sessions() as db:
        session = AgentSession(
            id="cancel-model", conversation_id="conv", task="test", status="running", scratchpad=[],
            runtime_state={"version": 1, "model": "test-model", "max_iterations": 5, "guard": {}},
        )
        db.add(session)
        await db.commit()

        async def collect():
            async for _ in agent_tasks.stream_task(
                db, session, {"messages": [HumanMessage(content="hello")], "iteration_count": 0},
            ):
                pass

        task = asyncio.create_task(collect())
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with sessions() as db:
        saved = await db.get(AgentSession, "cancel-model")
        assert saved.status == "failed"
        assert saved.runtime_state["usage_uncertain"]
        assert saved.runtime_state["tokens_used"] > 0
        assert saved.runtime_state["pending_model_usage"] is None
