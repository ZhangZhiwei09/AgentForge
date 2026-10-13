"""Disposable SQL database shared by entry API and signed-in chat tests."""

import httpx
import pytest_asyncio
from fastapi import HTTPException, Request
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.deps import get_chat_user, get_current_user, get_db
from src.main import create_app
from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.base import Base
from src.models.chat import Conversation, ConversationMemory, Message
from src.models.entry_flow import EntryRouteFlow, EntryRouteFlowRun
from src.models.user import User


@pytest_asyncio.fixture
async def entry_api(tmp_path):
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
