from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.agent.checkpoint import close_checkpointer, get_checkpointer
from src.api.v1.auth import router as auth_router
from src.api.v1.chat import agent_router, conversations_router, router as chat_router
from src.api.v1.dev import router as dev_router
from src.api.v1.health import router as health_router
from src.api.v1.knowledge import router as knowledge_router
from src.observability import init_observability, shutdown_observability


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化可观测性和 checkpointer，关闭时清理。"""
    init_observability()
    await get_checkpointer()  # 预热 checkpointer（非阻塞，config 关闭时立即返回 None）
    yield
    await close_checkpointer()
    await shutdown_observability()


def create_app() -> FastAPI:
    app = FastAPI(title="AgentForge", version="0.0.1", lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(chat_router)
    app.include_router(agent_router)
    app.include_router(conversations_router)
    app.include_router(knowledge_router)
    app.include_router(auth_router)
    app.include_router(dev_router)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=True)
