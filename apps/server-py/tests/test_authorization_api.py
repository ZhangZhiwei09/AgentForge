"""Management boundaries exercised through real JWT/API-key authentication."""

import re

import pytest
import pytest_asyncio
from sqlalchemy import select, update

from src.api.deps import ANONYMOUS_USER_ID, get_chat_user, get_current_user
from src.config import settings
from src.models.agent_evaluation import (
    AgentEvaluationCase,
    AgentEvaluationItem,
    AgentEvaluationRun,
    AgentEvaluationSuite,
)
from src.models.auth import ApiKey, RefreshToken
from src.models.base import Base
from src.models.chat import Conversation, Message, SatisfactionRating
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.models.knowledge_regression import (
    KnowledgeQueryLog,
    KnowledgeRegressionCase,
    KnowledgeRegressionRun,
    KnowledgeRegressionRunItem,
    KnowledgeRegressionTestSet,
)
from src.models.user import User
from src.services.auth import _create_tokens


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def authorized_api(entry_api, monkeypatch):
    client, sessions = entry_api
    app = client._transport.app
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_chat_user)
    for name in ("auth_signup_enabled", "anonymous_chat_enabled", "public_faq_enabled", "rate_limit_enabled",
                 "pgvector_enabled"):
        monkeypatch.setattr(settings, name, False)
    monkeypatch.setattr(settings, "elasticsearch_url", "")
    monkeypatch.setattr(settings, "reranker_base_url", "")
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            ApiKey.__table__, RefreshToken.__table__, SatisfactionRating.__table__,
            KnowledgeBase.__table__, KnowledgeDocument.__table__, KnowledgeChunk.__table__,
            KnowledgeQueryLog.__table__, KnowledgeRegressionTestSet.__table__, KnowledgeRegressionCase.__table__,
            KnowledgeRegressionRun.__table__, KnowledgeRegressionRunItem.__table__,
            AgentEvaluationSuite.__table__, AgentEvaluationCase.__table__, AgentEvaluationRun.__table__,
            AgentEvaluationItem.__table__,
        ]))
    async with sessions() as db:
        tokens = {role: _create_tokens(await db.get(User, role)) for role in ("admin", "user")}
        db.add_all([
            KnowledgeBase(id="kb", name="Internal"),
            Conversation(id="ours", user_id="user", session_id="ours"),
            Conversation(id="foreign", user_id="other", session_id="foreign"),
        ])
        await db.flush()
        db.add_all([
            KnowledgeDocument(
                id="doc", knowledge_base_id="kb", title="Internal FAQ", content="Internal evidence",
                status="completed", chunk_count=1,
            ),
            Message(id="answer", conversation_id="ours", role="assistant", content="Our answer"),
        ])
        await db.flush()
        db.add(KnowledgeChunk(
            id="chunk", knowledge_base_id="kb", document_id="doc", chunk_index=0,
            content="Internal evidence", token_count=2,
        ))
        await db.commit()
    keys = {}
    for role, token in tokens.items():
        response = await client.post(
            "/api/auth/api-keys", headers=bearer(token["accessToken"]), json={"name": "Authorization check"},
        )
        assert response.status_code == 201, response.text
        keys[role] = response.json()["key"]
    return client, sessions, tokens, keys


async def test_every_registered_management_action_requires_admin(authorized_api):
    client, _, tokens, keys = authorized_api
    checked = set()
    for registered_path, operations in client._transport.app.openapi()["paths"].items():
        management = (
            (registered_path.startswith("/api/knowledge/") and registered_path != "/api/knowledge/search")
            or registered_path.startswith(("/api/evaluations/", "/api/entry-route-flows"))
            or (registered_path.startswith("/api/agent-flows") and registered_path != "/api/agent-flows/runtime/diagnose")
            or registered_path in {"/api/agent/chat/feedback", "/api/agent/chat/analytics", "/api/metrics"}
        )
        if not management:
            continue
        path = re.sub(r"\{[^}]+\}", "placeholder", registered_path)
        for method in {operation.upper() for operation in operations} & {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            for headers, expected in (
                ({}, 401), (bearer(tokens["user"]["accessToken"]), 403), (bearer(keys["user"]), 403),
            ):
                response = await client.request(method, path, headers=headers, json={})
                assert response.status_code == expected, (method, registered_path, response.status_code, response.text)
            checked.add((method, registered_path))
    assert ("POST", "/api/knowledge/ingest") in checked
    assert ("POST", "/api/knowledge/bases/{base_id}/documents/upload") in checked
    assert ("POST", "/api/knowledge/bases/{base_id}/hit-testing") in checked
    assert ("POST", "/api/evaluations/suites/{suite_id}/runs") in checked
    assert ("GET", "/api/metrics") in checked


@pytest.mark.parametrize("credential", ["jwt", "api_key"])
async def test_admin_reads_and_writes_work_and_role_revocation_is_immediate(authorized_api, credential):
    client, sessions, tokens, keys = authorized_api
    headers = bearer(keys["admin"] if credential == "api_key" else tokens["admin"]["accessToken"])
    for path in (
        "/api/knowledge/bases", "/api/knowledge/documents/doc", "/api/knowledge/documents/doc/chunks",
        "/api/knowledge/bases/kb/regression/test-sets", "/api/evaluations/suites",
        "/api/agent/chat/feedback", "/api/agent/chat/analytics", "/api/metrics",
        "/api/agent-flows", "/api/entry-route-flows",
    ):
        response = await client.get(path, headers=headers)
        assert response.status_code == 200, (path, response.text)
    response = await client.post("/api/knowledge/bases", headers=headers, json={"name": "Admin write"})
    assert response.status_code == 201
    response = await client.post("/api/evaluations/suites", headers=headers, json={"name": "Admin suite"})
    assert response.status_code == 201
    async with sessions() as db:
        await db.execute(update(User).where(User.id == "admin").values(role="user"))
        await db.commit()
    # The JWT still claims admin and the API key is still valid; both must use the database role.
    for token in (tokens["admin"]["accessToken"], keys["admin"]):
        assert (await client.get("/api/auth/me", headers=bearer(token))).json()["role"] == "user"
        for path in ("/api/knowledge/bases", "/api/evaluations/suites", "/api/agent-flows",
                     "/api/entry-route-flows", "/api/metrics"):
            assert (await client.get(path, headers=bearer(token))).status_code == 403


async def test_closed_public_entries_and_regular_user_capabilities(authorized_api):
    client, sessions, tokens, _ = authorized_api
    headers = bearer(tokens["user"]["accessToken"])
    denied = await client.post("/api/auth/signup", json={"email": "outsider@example.com", "password": "password-123"})
    assert denied.status_code == 403
    for path in ("/api/agent/chat/faq", "/api/agent/chat/faq/categories", "/api/agent/chat/faq/doc",
                 "/api/agent/chat/history", "/api/agent/chat/conversations"):
        assert (await client.get(path)).status_code == 401
    for path, body in (
        ("/api/agent/chat", {"message": "Hello"}),
        ("/api/diagnosis/query", {"query": "刷脸失败"}),
        ("/api/agent/chat/rate", {"session_id": "ours", "rating": "positive"}),
    ):
        assert (await client.post(path, json=body)).status_code == 401
    for path in ("/api/agent/chat/faq", "/api/agent/chat/faq/categories", "/api/agent/chat/faq/doc",
                 "/api/agent/chat/history?session_id=ours", "/api/agent/chat/conversations",
                 "/api/agent-sessions?conversation_id=ours"):
        response = await client.get(path, headers=headers)
        assert response.status_code == 200, (path, response.text)
    search = await client.post(
        "/api/knowledge/search", headers=headers, json={"query": "Internal", "kb_ids": ["kb"]},
    )
    assert search.status_code == 200, search.text
    assert search.json()["results"][0]["chunkId"] == "chunk"
    own = await client.post("/api/agent/chat/rate", headers=headers, json={
        "session_id": "ours", "message_id": "answer", "rating": "positive",
    })
    assert own.status_code == 200, own.text
    assert (await client.post("/api/agent/chat/rate", headers=headers, json={
        "session_id": "foreign", "rating": "positive",
    })).status_code == 403
    async with sessions() as db:
        assert await db.scalar(select(User).where(User.email == "outsider@example.com")) is None
        assert await db.get(User, ANONYMOUS_USER_ID) is None
        assert len(list(await db.scalars(select(SatisfactionRating)))) == 1


async def test_public_faq_compatibility_never_ignores_supplied_bad_credentials(authorized_api, monkeypatch):
    client, _, _, _ = authorized_api
    monkeypatch.setattr(settings, "public_faq_enabled", True)
    assert (await client.get("/api/agent/chat/faq")).status_code == 200
    for headers in (bearer("invalid"), {"Authorization": "Basic invalid"}):
        assert (await client.get("/api/agent/chat/faq", headers=headers)).status_code == 401
