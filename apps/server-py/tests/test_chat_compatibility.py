"""Public chat parity against disposable SQL storage and deterministic Runtime events."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from anyio import Event, create_task_group, sleep_forever
from sqlalchemy import select

from src.agent.types import (
    DiagnosisCompleted,
    DiagnosisPhase,
    DiagnosisPhaseDone,
    DiagnosisStarted,
    DiagnosisWaitingInput,
    StreamCitations,
    StreamClear,
    StreamDone,
    StreamToken,
    StreamTraceStep,
)
from src.api.deps import ANONYMOUS_USER_ID, get_chat_user, get_current_user
from src.api.v1 import chat
from src.models.chat import Conversation, Message
from src.models.user import User
from src.services.auth import _create_tokens
from tests.test_entry_chat_api import dependencies as dependencies  # noqa: PLC0414 - Re-export the pytest fixture.
from tests.test_entry_chat_api import frames, saved_messages

USER = {"X-Test-Actor": "user"}


@pytest.fixture
async def public_api(entry_api):
    client, sessions = entry_api
    app = client._transport.app
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_chat_user)
    async with sessions() as db:
        tokens = _create_tokens(await db.get(User, "user"))
    return client, sessions, {"Authorization": f"Bearer {tokens['accessToken']}"}


async def test_anonymous_chat_bootstraps_legacy_actor_and_reuses_session(public_api, dependencies):
    client, sessions, _ = public_api
    payload = {"message": "你好", "session_id": "legacy-browser-session"}
    first = frames(await client.post("/api/agent/chat", json=payload))
    second = frames(await client.post("/api/agent/chat", json=payload))
    conv_id = first[0]["conversation_id"]
    assert first[0]["session_id"] == "legacy-browser-session"
    assert second[0]["conversation_id"] == conv_id
    async with sessions() as db:
        actor = await db.get(User, ANONYMOUS_USER_ID)
        assert actor.password_hash is None and actor.role == "user"
        assert (await db.get(Conversation, conv_id)).user_id == actor.id
    history = await client.get("/api/agent/chat/history", params={"session_id": payload["session_id"]})
    assert history.status_code == 200
    assert history.json()["conversation_id"] == conv_id
    assert len(history.json()["messages"]) == 4
    assert (await client.get("/api/agent/chat/conversations")).json() == {"conversations": []}
    listed = await client.get("/api/agent/chat/conversations", params={"session_id": payload["session_id"]})
    assert [row["id"] for row in listed.json()["conversations"]] == [conv_id]
    assert listed.json()["conversations"][0]["session_id"] == payload["session_id"]


async def test_parallel_anonymous_requests_create_one_reserved_actor(public_api, dependencies):
    client, sessions, _ = public_api
    responses = await asyncio.gather(*[
        client.post("/api/agent/chat", json={"message": "你好"})
        for _ in range(3)
    ])
    assert all(response.status_code == 200 for response in responses)
    async with sessions() as db:
        actors = list(await db.scalars(select(User).where(User.id == ANONYMOUS_USER_ID)))
        assert len(actors) == 1 and actors[0].password_hash is None


async def test_existing_anonymous_actor_is_never_overwritten(public_api, dependencies):
    client, sessions, _ = public_api
    async with sessions() as db:
        db.add(User(id=ANONYMOUS_USER_ID, email="legacy@example.test", password_hash="preserve-me", role="user"))
        await db.commit()
    assert (await client.post("/api/agent/chat", json={"message": "你好"})).status_code == 200
    async with sessions() as db:
        actor = await db.get(User, ANONYMOUS_USER_ID)
        assert actor.email == "legacy@example.test" and actor.password_hash == "preserve-me"


async def test_anonymous_identity_email_conflict_is_controlled(public_api, dependencies):
    client, sessions, _ = public_api
    async with sessions() as db:
        db.add(User(id="conflicting", email="customer@agentforge.local", role="user"))
        await db.commit()
    response = await client.post("/api/agent/chat", json={"message": "你好"})
    assert response.status_code == 503
    async with sessions() as db:
        assert await db.get(User, ANONYMOUS_USER_ID) is None
        assert list(await db.scalars(select(Conversation))) == []


@pytest.mark.parametrize("headers,params", [
    ({"Authorization": "Bearer expired"}, {}),
    ({"Authorization": "Basic invalid"}, {}),
    ({"Authorization": ""}, {}),
    ({}, {"api_key": ""}),
    ({}, {"api_key": "invalid"}),
])
async def test_supplied_invalid_credentials_never_become_anonymous(public_api, dependencies, headers, params):
    client, sessions, _ = public_api
    for path in ("/api/agent/chat/history", "/api/agent/chat/conversations"):
        response = await client.get(path, params={"session_id": "legacy", **params}, headers=headers)
        assert response.status_code == 401
    response = await client.post("/api/agent/chat", json={"message": "你好"}, params=params, headers=headers)
    assert response.status_code == 401
    async with sessions() as db:
        assert await db.get(User, ANONYMOUS_USER_ID) is None
        assert list(await db.scalars(select(Conversation))) == []


async def test_authenticated_and_anonymous_conversations_are_scoped(public_api, dependencies):
    client, sessions, headers = public_api
    payload = {"message": "你好", "session_id": "same-legacy-alias"}
    anonymous = frames(await client.post("/api/agent/chat", json=payload))[0]["conversation_id"]
    signed_in = frames(await client.post("/api/agent/chat", json=payload, headers=headers))[0]["conversation_id"]
    assert signed_in != anonymous
    for conv_id, request_headers in ((signed_in, {}), (anonymous, headers)):
        assert (await client.post("/api/agent/chat", json={
            "message": "你好", "conversation_id": conv_id, "session_id": "same-legacy-alias",
        }, headers=request_headers)).status_code == 403
        assert (await client.get("/api/agent/chat/history", params={
            "conversation_id": conv_id, "session_id": "same-legacy-alias",
        }, headers=request_headers)).status_code == 403
    history = await client.get("/api/agent/chat/history", params={"session_id": "same-legacy-alias"}, headers=headers)
    assert history.json()["conversation_id"] == signed_in
    listed = await client.get("/api/agent/chat/conversations", headers=headers)
    assert [row["id"] for row in listed.json()["conversations"]] == [signed_in]
    assert (await client.get("/api/conversations", headers=headers)).json()["conversations"][0]["session_id"] == "same-legacy-alias"
    assert (await client.delete(f"/api/agent/chat/conversations/{anonymous}", headers=headers)).status_code == 403
    assert (await client.delete(f"/api/agent/chat/conversations/{signed_in}", headers=headers)).status_code == 200
    assert await saved_messages(sessions, signed_in) == []


async def test_anonymous_access_does_not_open_protected_apis(public_api, dependencies):
    client, _, _ = public_api
    conv_id = frames(await client.post("/api/agent/chat", json={"message": "你好"}))[0]["conversation_id"]
    assert (await client.post("/api/v1/chat", json={"message": "你好"})).status_code == 401
    assert (await client.delete(f"/api/agent/chat/conversations/{conv_id}")).status_code == 401
    assert (await client.delete(f"/api/conversations/{conv_id}")).status_code == 401
    assert (await client.get("/api/entry-route-flows")).status_code == 401


async def test_chat_rejects_other_conversation_type(entry_api, dependencies):
    client, sessions = entry_api
    async with sessions() as db:
        db.add(Conversation(id="other-type", user_id="user", type="workflow"))
        await db.commit()
    assert (await client.post("/api/agent/chat", json={
        "message": "你好", "conversation_id": "other-type",
    }, headers=USER)).status_code == 400
    assert await saved_messages(sessions, "other-type") == []


async def test_history_preserves_full_legacy_read_and_stable_compound_paging(entry_api):
    client, sessions = entry_api
    async with sessions() as db:
        db.add(Conversation(id="paged", user_id="user", session_id="old-page"))
        await db.flush()
        db.add_all([Message(
            id=f"message-{index:02}", conversation_id="paged", role="user", content=str(index),
            created_at=datetime(2026, 10, 13, tzinfo=UTC),
        ) for index in range(12)])
        await db.commit()
    full = await client.get("/api/agent/chat/history", params={"session_id": "old-page"}, headers=USER)
    assert [row["content"] for row in full.json()["messages"]] == [str(index) for index in range(12)]
    page = (await client.get("/api/agent/chat/history", params={
        "conversation_id": "paged", "limit": 5,
    }, headers=USER)).json()
    assert page["has_more"] and len(page["messages"]) == 5
    seen = [row["id"] for row in page["messages"]]
    while page["has_more"]:
        page = (await client.get("/api/agent/chat/history", params={
            "conversation_id": "paged", "limit": 5, **page["next_cursor"],
        }, headers=USER)).json()
        seen = [row["id"] for row in page["messages"]] + seen
    assert seen == [f"message-{index:02}" for index in range(12)]


@pytest.mark.parametrize("params,status", [
    ({}, 400),
    ({"session_id": "unknown"}, 200),
    ({"session_id": "unknown", "before_time": "bad-date", "before_id": "id"}, 422),
    ({"session_id": "unknown", "before_time": "2026-10-13T00:00:00Z"}, 400),
    ({"session_id": "unknown", "before_id": "id"}, 400),
    ({"session_id": "x" * 65}, 422),
    ({"session_id": "unknown", "limit": 0}, 422),
])
async def test_history_invalid_inputs_are_controlled(entry_api, params, status):
    client, _ = entry_api
    response = await client.get("/api/agent/chat/history", params=params, headers=USER)
    assert response.status_code == status


async def test_conversation_id_wins_over_session_alias(entry_api, dependencies):
    client, _ = entry_api
    first = frames(await client.post("/api/agent/chat", json={
        "message": "你好", "session_id": "first",
    }, headers=USER))[0]["conversation_id"]
    second = frames(await client.post("/api/agent/chat", json={
        "message": "你好", "session_id": "second",
    }, headers=USER))[0]["conversation_id"]
    resumed = frames(await client.post("/api/agent/chat", json={
        "message": "谢谢", "conversation_id": first, "session_id": "second",
    }, headers=USER))
    assert resumed[0]["conversation_id"] == first != second


async def test_parallel_alias_creation_uses_one_conversation(entry_api, dependencies):
    client, sessions = entry_api
    responses = await asyncio.gather(*[
        client.post("/api/agent/chat", json={"message": "你好", "session_id": "parallel"}, headers=USER)
        for _ in range(3)
    ])
    ids = {frames(response)[0]["conversation_id"] for response in responses}
    assert len(ids) == 1
    assert len(await saved_messages(sessions, ids.pop())) == 6
    assert chat._conversation_locks == {}


def runtime_events(monkeypatch, events):
    async def execute(context):
        for event in events:
            if hasattr(event, "message_id"):
                event.message_id = context.assistant_msg_id
            yield event
    monkeypatch.setattr(chat, "_get_executor", lambda: SimpleNamespace(execute=execute))


async def test_citations_trace_updates_and_clear_stream_survive_history(entry_api, dependencies, monkeypatch):
    client, sessions = entry_api
    citations = [{"index": 1, "docId": "real-document", "docTitle": "资料", "excerpt": "证据", "score": 0.9}]
    runtime_events(monkeypatch, [
        StreamTraceStep(step={"seq": 2, "kind": "tool", "label": "检查", "status": "running"}),
        StreamTraceStep(step={"seq": 1, "kind": "retrieval", "label": "检索知识库", "status": "done"}),
        StreamCitations(items=[]), StreamCitations(items=citations),
        StreamToken(content="废弃草稿"), StreamClear(), StreamToken(content="最终回答 [1]"),
        StreamTraceStep(step={"seq": 2, "kind": "tool", "label": "检查", "status": "done"}),
        StreamDone(suggestions=["继续"]),
    ])
    events = frames(await client.post("/api/agent/chat", json={"message": "错误码说明"}, headers=USER))
    assert next(event for event in events if event["type"] == "clear_stream")["message_id"] == events[0]["message_id"]
    assert [event["items"] for event in events if event["type"] == "citations"] == [[], citations]
    rows = await saved_messages(sessions, events[0]["conversation_id"])
    assistant = next(row for row in rows if row.role == "assistant")
    assert assistant.content == "最终回答 [1]"
    assert assistant.msg_metadata["citations"] == citations
    assert [step["seq"] for step in assistant.msg_metadata["traces"]] == [1, 2]
    assert assistant.msg_metadata["traces"][1]["status"] == "done"
    history = await client.get("/api/agent/chat/history", params={
        "conversation_id": events[0]["conversation_id"],
    }, headers=USER)
    assert next(row for row in history.json()["messages"] if row["role"] == "assistant")["metadata"] == assistant.msg_metadata


async def test_disconnect_after_trace_keeps_metadata_without_invented_text(entry_api, dependencies, monkeypatch):
    _, sessions = entry_api
    runtime_events(monkeypatch, [
        StreamTraceStep(step={"seq": 1, "kind": "tool", "label": "检查", "status": "running"}),
        StreamToken(content="尚未发送"),
    ])
    async with sessions() as db:
        response = await chat._handle_chat("错误码说明", None, db, await db.get(User, "user"))
        stream = response.body_iterator
        meta = (await anext(stream))
        assert '"type": "meta"' in meta
        assert '"type": "trace_step"' in (await anext(stream))
        await stream.aclose()
    async with sessions() as db:
        rows = list(await db.scalars(select(Message).where(Message.role == "assistant")))
        assert len(rows) == 1 and rows[0].content == ""
        assert rows[0].msg_metadata["traces"][0]["status"] == "running"


async def test_disconnect_cancellation_finishes_sql_write_and_releases_lock(entry_api, dependencies, monkeypatch):
    _, sessions = entry_api
    emitted = Event()

    async def execute(context):
        yield StreamToken(content="已发送")
        emitted.set()
        await sleep_forever()

    monkeypatch.setattr(chat, "_get_executor", lambda: SimpleNamespace(execute=execute))

    async def consume():
        async with sessions() as db:
            response = await chat._handle_chat("错误码说明", None, db, await db.get(User, "user"))
            async for _ in response.body_iterator:
                pass

    async with create_task_group() as group:
        group.start_soon(consume)
        await emitted.wait()
        group.cancel_scope.cancel()
    assert chat._conversation_locks == {}
    async with sessions() as db:
        rows = list(await db.scalars(select(Message).where(Message.role == "assistant")))
        assert len(rows) == 1 and rows[0].content == "已发送"


async def test_public_sse_terminal_marker_is_emitted_once(entry_api, dependencies):
    client, _ = entry_api
    response = await client.post("/api/agent/chat", json={"message": "你好"}, headers=USER)
    assert response.text.endswith("data: [DONE]\n\n")
    assert response.text.count("data: [DONE]") == 1


async def test_diagnosis_progress_and_waiting_dto_survive_history(entry_api, dependencies, monkeypatch):
    client, sessions = entry_api
    dependencies.classify.return_value = {"status": "valid", "result": {
        "intent": "diagnosis", "resolvedQuery": "排查错误", "reasoning": "排查",
    }}

    async def diagnosis(*args, **kwargs):
        yield DiagnosisStarted(agents=[
            {"name": "frontend", "role": "前端排查", "phase": 1},
            {"name": "backend", "role": "后端排查", "phase": 2},
        ])
        yield DiagnosisPhase(phase=1)
        yield DiagnosisPhaseDone(phase=1, summary="前端已核查")
        yield DiagnosisWaitingInput(message="请补充时间", missing_fields=["时间"])
        yield StreamToken(content="请补充时间")
        yield StreamDone()

    monkeypatch.setattr(chat, "_stream_diagnosis", diagnosis)
    events = frames(await client.post("/api/agent/chat", json={"message": "排查错误"}, headers=USER))
    assistant = next(row for row in await saved_messages(sessions, events[0]["conversation_id"]) if row.role == "assistant")
    assert assistant.type == "diagnosis"
    assert assistant.msg_metadata["waitingInput"] == {"message": "请补充时间", "missingFields": ["时间"]}
    assert assistant.msg_metadata["diagnosis"]["status"] == "waiting_input"
    assert [phase["status"] for phase in assistant.msg_metadata["diagnosis"]["phases"]] == ["done", "pending"]
    metadata = {}
    chat._collect_diagnosis(metadata, DiagnosisStarted(agents=[
        {"name": "frontend", "role": "前端排查"}, {"name": "backend", "role": "后端排查"},
    ]))
    chat._collect_diagnosis(metadata, DiagnosisPhaseDone(phase=1, summary="已检查"))
    chat._collect_diagnosis(metadata, DiagnosisCompleted(output={"resolution": "frontend_only", "conclusion": "已定位"}))
    assert metadata["diagnosis"]["status"] == "done"
    assert [phase["status"] for phase in metadata["diagnosis"]["phases"]] == ["done", "skipped"]


async def test_classification_includes_persisted_diagnosis_answer(entry_api, dependencies):
    client, sessions = entry_api
    async with sessions() as db:
        db.add(Conversation(id="diagnosis-history", user_id="user"))
        await db.flush()
        db.add(Message(
            id="diagnosis-answer", conversation_id="diagnosis-history", role="assistant",
            type="diagnosis", content="前一轮的排查结论",
        ))
        await db.commit()
    frames(await client.post("/api/agent/chat", json={
        "message": "查下相关文档", "conversation_id": "diagnosis-history",
    }, headers=USER))
    history = dependencies.classify.call_args.args[1]
    assert [(message.role, message.content) for message in history] == [("assistant", "前一轮的排查结论")]
