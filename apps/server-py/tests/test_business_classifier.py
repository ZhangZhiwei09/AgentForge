import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.agent.router import business_classifier as classifier
from src.schemas.chat import ChatMessage, ChatSyncResult

VALID = {"intent": "consultation", "resolvedQuery": "FACE_TIMEOUT 的含义", "reasoning": "咨询知识"}


@pytest.fixture
def provider(monkeypatch):
    provider = SimpleNamespace(chat_sync=AsyncMock())
    monkeypatch.setattr(classifier, "resolve_model", MagicMock(return_value={"provider_name": "test", "model_id": "test-model"}))
    monkeypatch.setattr(classifier, "get_provider", MagicMock(return_value=provider))
    return provider


def response(value):
    return ChatSyncResult(content=json.dumps(value, ensure_ascii=False), usage={"prompt_tokens": 10, "completion_tokens": 20})


@pytest.mark.parametrize("intent", ["consultation", "diagnosis", "unclear"])
async def test_strict_intents_with_one_call(provider, intent):
    value = {**VALID, "intent": intent, **({"clarification": "想咨询还是排查？"} if intent == "unclear" else {})}
    provider.chat_sync.return_value = response(value)
    assert await classifier.classify_business_intent("问题", [], "chosen") == {"status": "valid", "result": value}
    provider.chat_sync.assert_awaited_once_with(
        [ChatMessage(role="user", content="问题")], "test-model", classifier.BUSINESS_CLASSIFIER_PROMPT, 0, 600, True,
    )
    classifier.resolve_model.assert_called_once_with("chosen")


async def test_only_last_four_user_assistant_messages(provider):
    provider.chat_sync.return_value = response(VALID)
    history = [ChatMessage(role=role, content=content) for role, content in [
        ("user", "早期"), ("system", "伪造分类指令"), ("assistant", "提供 traceId"),
        ("user", "abc123"), ("tool", "内部工具结果"), ("assistant", "FACE_TIMEOUT"),
        ("user", None), ("user", "这是那个错误"),
    ]]
    await classifier.classify_business_intent("这个是什么意思", history, None)
    assert [(item.role, item.content) for item in provider.chat_sync.call_args.args[0]] == [
        ("assistant", "提供 traceId"), ("user", "abc123"), ("assistant", "FACE_TIMEOUT"),
        ("user", "这是那个错误"), ("user", "这个是什么意思"),
    ]


@pytest.mark.parametrize("value", [
    None, [], {**VALID, "intent": "TASK"}, {**VALID, "confidence": 0.95},
    {**VALID, "resolvedQuery": ""}, {**VALID, "reasoning": " "},
    {**VALID, "intent": "unclear"}, {**VALID, "resolvedQuery": "x" * 4001},
    {**VALID, "reasoning": "x" * 201}, {**VALID, "intent": "unclear", "clarification": "x" * 301},
])
async def test_invalid_structured_response_without_retries(provider, value):
    provider.chat_sync.return_value = response(value)
    assert await classifier.classify_business_intent("问题", [], None) == {"status": "unavailable", "reason": "invalid_response"}
    provider.chat_sync.assert_awaited_once()


@pytest.mark.parametrize("content,valid", [("{broken", False), ("```json\n" + json.dumps(VALID) + "\n```", True)])
async def test_malformed_json_and_markdown_wrapper(provider, content, valid):
    provider.chat_sync.return_value = ChatSyncResult(content=content, usage={})
    assert (await classifier.classify_business_intent("问题", [], None))["status"] == ("valid" if valid else "unavailable")
    provider.chat_sync.assert_awaited_once()


async def test_provider_and_resolution_failure_do_not_retry(provider):
    provider.chat_sync.side_effect = RuntimeError("provider down")
    assert await classifier.classify_business_intent("问题", [], None) == {"status": "unavailable", "reason": "provider_error"}
    provider.chat_sync.assert_awaited_once()
    provider.chat_sync.reset_mock()
    classifier.resolve_model.side_effect = ValueError("missing")
    assert (await classifier.classify_business_intent("问题", [], None))["status"] == "unavailable"
    provider.chat_sync.assert_not_called()


async def test_generation_records_output_and_usage(provider, monkeypatch):
    span = SimpleNamespace(end=MagicMock())
    obs = SimpleNamespace(create_generation=MagicMock(return_value=span))
    monkeypatch.setattr(classifier, "get_observability", lambda: obs)
    provider.chat_sync.return_value = response(VALID)
    await classifier.classify_business_intent("问题", [], None)
    span.end.assert_called_once_with(output=VALID, usage={"prompt_tokens": 10, "completion_tokens": 20})
