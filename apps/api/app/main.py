from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy import text
from app.database.base import Base
from app.database.session import engine
from app.middleware.cors import setup_cors
from app.routers import conversations_router, chat_router, providers_router


DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"


async def seed_default_user():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        result = await conn.execute(
            text("SELECT 1 FROM users WHERE id = :id"), {"id": DEFAULT_USER_ID}
        )
        if result.fetchone() is None:
            await conn.execute(
                text(
                    "INSERT INTO users (id, email) VALUES (:id, :email) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": DEFAULT_USER_ID, "email": "default@agentforge.local"},
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed_default_user()
    yield
    await engine.dispose()


app = FastAPI(
    title="AgentForge API",
    version="0.0.1",
    lifespan=lifespan,
)

setup_cors(app)

app.include_router(conversations_router)
app.include_router(chat_router)
app.include_router(providers_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
