"""Configuration-only output mode does not concatenate ReAct intermediate text."""

import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from src.agent import executor as module
from src.agent.executor import AgentExecutor
from src.agent.tools.registry import tool_registry
from src.agent.types import RouteContext, StreamError, StreamToken


async def execute_events(monkeypatch, events, *, structured=True):
    class Graph:
        async def astream_events(self, *args, **kwargs):
            for event in events:
                yield event

    monkeypatch.setattr(module, "resolve_model", lambda _: {"provider_name": "fake", "model_id": "fake"})
    monkeypatch.setattr(module, "get_provider", lambda _: object())
    monkeypatch.setattr(module, "ProviderChatModel", lambda **kwargs: object())
    monkeypatch.setattr(module, "build_react_graph", lambda **kwargs: Graph())
    executor = AgentExecutor(
        registry=tool_registry.filter([]), checkpoint=False, structured_output=structured,
    )
    return [event async for event in executor.execute(RouteContext(user_message="test"))]


def token(text):
    return {"event": "on_chat_model_stream", "data": {"chunk": SimpleNamespace(content=text)}}


def answer(text, *, tools=False):
    output = AIMessage(content=text, tool_calls=[
        {"name": "monitor", "args": {}, "id": "call-1", "type": "tool_call"},
    ] if tools else [])
    return {"event": "on_chat_model_end", "data": {"output": output}}


@pytest.mark.asyncio
async def test_structured_mode_only_returns_final_round(monkeypatch):
    events = await execute_events(monkeypatch, [
        token("I will inspect the logs."), answer("I will inspect the logs.", tools=True),
        token('{"conclusion":"verified"}'), answer('{"conclusion":"verified"}'),
    ])
    assert [event.content for event in events if isinstance(event, StreamToken)] == ['{"conclusion":"verified"}']


@pytest.mark.asyncio
async def test_legacy_streaming_is_unchanged(monkeypatch):
    events = await execute_events(monkeypatch, [
        token("first"), answer("first", tools=True), token("final"), answer("final"),
    ], structured=False)
    assert [event.content for event in events if isinstance(event, StreamToken)] == ["first", "final"]


@pytest.mark.asyncio
async def test_unfinished_tool_call_is_budget_failure(monkeypatch):
    events = await execute_events(monkeypatch, [answer("intermediate", tools=True)])
    assert any(isinstance(event, StreamError) and "预算" in event.content for event in events)
    assert not any(isinstance(event, StreamToken) for event in events)


@pytest.mark.asyncio
async def test_tool_failure_is_explicit(monkeypatch):
    events = await execute_events(monkeypatch, [{
        "event": "on_chain_end", "name": "tools",
        "data": {"output": {"messages": [
            ToolMessage(
                content=json.dumps({"status": "failed", "error": "monitor-unavailable"}),
                tool_call_id="call-1", name="monitor",
            ),
        ]}},
    }])
    assert any(isinstance(event, StreamError) and "monitor-unavailable" in event.content for event in events)
