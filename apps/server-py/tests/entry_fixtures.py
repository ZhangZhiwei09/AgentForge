"""Disposable SQL database shared by entry API and signed-in chat tests."""

import os
import uuid

import httpx
import pytest_asyncio
from fastapi import HTTPException, Request
from sqlalchemy import event, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.deps import get_chat_user, get_current_user, get_db
from src.main import create_app
from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.agent_session import AgentApproval, AgentSession
from src.models.base import Base
from src.models.chat import Conversation, ConversationMemory, Message
from src.models.entry_flow import EntryRouteFlow, EntryRouteFlowRun
from src.models.retained import RouteClassificationLog
from src.models.user import User


@pytest_asyncio.fixture
async def entry_api(tmp_path):
    postgres_url = os.environ.get("AGENTFORGE_TEST_POSTGRES_URL")
    schema = None
    if postgres_url:
        database = make_url(postgres_url).database or ""
        if database != "agentforge_python_migration" and not database.startswith("agentforge_test_"):
            raise ValueError("PostgreSQL tests require an explicitly named disposable test database")
        schema = f"migration_test_{uuid.uuid4().hex}"
        engine = create_async_engine(postgres_url, connect_args={
            "server_settings": {"search_path": f"{schema},public"},
        })
        async with engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    else:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'entry.db').as_posix()}")

        @event.listens_for(engine.sync_engine, "connect")
        def enable_foreign_keys(connection, _):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            User.__table__, Conversation.__table__, Message.__table__, ConversationMemory.__table__,
            AgentFlow.__table__, AgentFlowRun.__table__, EntryRouteFlow.__table__, EntryRouteFlowRun.__table__,
            AgentSession.__table__, AgentApproval.__table__,
            RouteClassificationLog.__table__,
        ]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    actors = {
        "admin": User(id="admin", email="admin@example.test", role="admin"),
        "user": User(id="user", email="user@example.test", role="user"),
        "other": User(id="other", email="other@example.test", role="user"),
    }
    async with sessions() as db:
        db.add_all(list(actors.values()))
        await db.commit()
    app = create_app()

    async def isolated_db():
        async with sessions() as db:
            yield db

    async def actor(request: Request):
        user = actors.get(request.headers.get("X-Test-Actor", ""))
        if user is None:
            raise HTTPException(401, "请先登录")
        return user

    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_user] = actor
    app.dependency_overrides[get_chat_user] = actor
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client, sessions
    finally:
        if schema:
            async with engine.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await engine.dispose()


@pytest_asyncio.fixture
async def empty_postgres():
    """Fresh isolated schema for database bootstrap and read-only SQL tools."""
    url = os.environ.get("AGENTFORGE_TEST_POSTGRES_URL")
    if not url:
        import pytest
        pytest.skip("Set AGENTFORGE_TEST_POSTGRES_URL for disposable database bootstrap tests")
    database = make_url(url).database or ""
    if database != "agentforge_python_migration" and not database.startswith("agentforge_test_"):
        raise ValueError("Bootstrap tests require a disposable test database")
    schema = f"bootstrap_test_{uuid.uuid4().hex}"
    engine = create_async_engine(url, connect_args={"server_settings": {"search_path": f"{schema},public"}})
    async with engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        yield engine, schema
    finally:
        async with engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await engine.dispose()


async def create_flow(client, *, template="default"):
    response = await client.post("/api/entry-route-flows", json={"name": "入口", "template": template},
                                 headers={"X-Test-Actor": "admin"})
    assert response.status_code == 201, response.text
    return response.json()


async def enable_flow(client, *, template="default"):
    flow = await create_flow(client, template=template)
    base = f"/api/entry-route-flows/{flow['id']}"
    assert (await client.post(f"{base}/publish", json={"revision": 1}, headers={"X-Test-Actor": "admin"})).status_code == 200
    assert (await client.put(f"{base}/activation", json={"enabled": True}, headers={"X-Test-Actor": "admin"})).status_code == 200
    return flow
