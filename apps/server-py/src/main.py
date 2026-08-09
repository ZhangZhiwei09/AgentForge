import asyncio
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.agent.checkpoint import close_checkpointer, get_checkpointer
from src.api.v1.auth import router as auth_router
from src.api.v1.chat import agent_router, router as chat_router
from src.api.v1.conversations import agent_chat_router, conversations_router
from src.api.v1.dev import router as dev_router
from src.api.v1.health import router as health_router
from src.api.v1.knowledge import router as knowledge_router
from src.observability import init_observability, shutdown_observability

# Windows 下 psycopg（AsyncConnectionPool，AsyncPostgresSaver 后端）不能运行在
# 默认的 ProactorEventLoop 上。这里显式切换到 SelectorEventLoop：
#   - 团队级诊断 checkpoint（Phase 2）可正常连接 Postgres
#   - 避免 checkpointer 连接失败重试 30s 后降级，挤占诊断 180s 超时预算
# 仅影响 Windows 开发环境；Linux 默认就是 SelectorEventLoop，无需此设置。
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


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
    app.include_router(agent_chat_router)
    app.include_router(conversations_router)
    app.include_router(knowledge_router)
    app.include_router(auth_router)
    app.include_router(dev_router)
    return app


app = create_app()

if __name__ == "__main__":
    # Windows：uvicorn 0.36+ 的 asyncio_loop_factory 在 win32 上硬编码
    # ProactorEventLoop（无视事件循环 policy），而 psycopg（AsyncPostgresSaver
    # 后端）只能在 SelectorEventLoop 上运行。故：
    #   1) 显式切换到 WindowsSelectorEventLoopPolicy
    #   2) uvicorn 用 loop="none"（loop_factory=None → asyncio.run 走 policy，
    #      即上面的 SelectorEventLoop）
    # 推荐 `python -m src.main` 启动；`python -m uvicorn src.main:app` 会先建
    # loop 再导入本模块，policy 来不及生效。
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    import uvicorn

    from src.config import settings

    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=True,
        loop="none",
    )
