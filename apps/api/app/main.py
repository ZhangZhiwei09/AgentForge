from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy import text
from app.database.base import Base
from app.database.session import engine
from app.middleware.cors import setup_cors
from app.routers import conversations_router, chat_router, providers_router, memories_router, customer_chat_router, knowledge_router


DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"
CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002"


async def seed_default_user():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # 默认用户
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

        # 客服匿名用户
        result = await conn.execute(
            text("SELECT 1 FROM users WHERE id = :id"), {"id": CUSTOMER_USER_ID}
        )
        if result.fetchone() is None:
            await conn.execute(
                text(
                    "INSERT INTO users (id, email) VALUES (:id, :email) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": CUSTOMER_USER_ID, "email": "customer@agentforge.local"},
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed_default_user()
    await _seed_knowledge()
    yield
    await engine.dispose()


async def _seed_knowledge():
    """创建默认知识库种子数据。"""
    from app.database.session import async_session_factory
    from app.services.seed_data.knowledge_seed import seed_knowledge_base

    async with async_session_factory() as db:
        await seed_knowledge_base(db)


app = FastAPI(
    title="AgentForge API",
    version="0.0.1",
    lifespan=lifespan,
)

setup_cors(app)

app.include_router(conversations_router)
app.include_router(chat_router)
app.include_router(providers_router)
app.include_router(memories_router)
app.include_router(customer_chat_router)
app.include_router(knowledge_router)



@app.get("/api/health")
async def health():
    return {"status": "ok"}
