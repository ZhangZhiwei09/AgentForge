"""JSON-lines SQLAlchemy fixture bridge. Never enabled by the production API."""

import asyncio
import json
import os
import re
import sys

from sqlalchemy import delete, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.models.agent_flow import AgentFlow, AgentFlowRun
from src.models.chat import Conversation, Message
from src.models.entry_flow import EntryRouteFlow, EntryRouteFlowRun
from src.models.retained import RouteClassificationLog
from src.models.user import User

MODELS = {
    "user": User, "conversation": Conversation, "message": Message,
    "agentFlow": AgentFlow, "agentFlowRun": AgentFlowRun,
    "entryRouteFlow": EntryRouteFlow, "entryRouteFlowRun": EntryRouteFlowRun,
    "routeClassificationLog": RouteClassificationLog,
}


def require_test_url(value):
    try:
        url = make_url(value)
    except ArgumentError as exc:
        raise ValueError("Browser fixtures require an explicit test database URL") from exc
    if url.get_backend_name() != "postgresql" or not (url.database or "").startswith("agentforge_test_"):
        raise ValueError("Browser fixtures require an explicit agentforge_test_* PostgreSQL database")
    return url.set(drivername="postgresql+asyncpg")


def attribute(model, name):
    key = "msg_metadata" if model is Message and name == "metadata" else re.sub(
        r"[A-Z]", lambda match: "_" + match[0].lower(), name,
    )
    if key not in inspect(model).column_attrs:
        raise ValueError("Unknown fixture column")
    return key


def filters(model, where):
    conditions = []
    for key, value in where.items():
        column = getattr(model, attribute(model, key))
        if isinstance(value, dict):
            if set(value) != {"in"} or not isinstance(value["in"], list):
                raise ValueError("Unsupported fixture predicate")
            conditions.append(column.in_(value["in"]))
        else:
            conditions.append(column == value)
    return conditions


def serialize(row, projection):
    fields = projection or {
        ("metadata" if item.key == "msg_metadata" else re.sub(
            r"_([a-z])", lambda match: match[1].upper(), item.key,
        )): True for item in inspect(type(row)).column_attrs
    }
    return {key: getattr(row, attribute(type(row), key)) for key, enabled in fields.items() if enabled}


async def cleanup_flow(db, flow_id):
    threads = list(await db.scalars(select(AgentFlowRun.id).where(AgentFlowRun.flow_id == flow_id)))
    tables = await db.connection()
    present = await tables.run_sync(lambda sync: set(inspect(sync).get_table_names()))
    for name in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
        if name in present:
            for thread in threads:
                await db.execute(text(f"DELETE FROM {name} WHERE thread_id = :thread"), {"thread": thread})
    await db.execute(delete(AgentFlowRun).where(AgentFlowRun.flow_id == flow_id))
    await db.execute(delete(AgentFlow).where(AgentFlow.id == flow_id))
    await db.commit()


async def operation(db, request):
    action = request["action"]
    if action == "cleanupFlow":
        await cleanup_flow(db, request["flowId"])
        return None
    model = MODELS[request["model"]]
    args = request.get("args", {})
    where = filters(model, args.get("where", {}))
    if action == "create":
        if model not in (User, Conversation):
            raise ValueError("Fixture creation only supports users and conversations")
        row = model(**{attribute(model, key): value for key, value in args["data"].items()})
        db.add(row)
        await db.commit()
        return serialize(row, args.get("select"))
    if action == "deleteMany":
        if not where:
            raise ValueError("Unscoped fixture deletion refused")
        result = await db.execute(delete(model).where(*where))
        await db.commit()
        return result.rowcount
    if action == "count":
        return await db.scalar(select(func.count()).select_from(model).where(*where))
    if action not in ("findMany", "findUnique", "findFirst"):
        raise ValueError("Unsupported fixture action")
    query = select(model).where(*where)
    if action != "findMany":
        row = await db.scalar(query.limit(1))
        return serialize(row, args.get("select")) if row else None
    return [serialize(row, args.get("select")) for row in await db.scalars(query)]


async def main():
    engine = create_async_engine(require_test_url(os.environ.get("AGENTFORGE_E2E_DATABASE_URL", "")))
    try:
        # The parent sends requests serially; each gets its own transaction.
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            try:
                async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                    result = await operation(db, request)
                response = {"id": request["id"], "result": result}
            except Exception as exc:  # noqa: BLE001 - return fixture failures to the waiting test
                response = {"id": request["id"], "error": f"{type(exc).__name__}: {exc}"}
            print(json.dumps(response, default=str, ensure_ascii=True), flush=True)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
