from fastapi import FastAPI

from src.api.v1.auth import router as auth_router
from src.api.v1.chat import agent_router, router as chat_router
from src.api.v1.dev import router as dev_router
from src.api.v1.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="AgentForge", version="0.0.1")
    app.include_router(health_router)
    app.include_router(chat_router)
    app.include_router(agent_router)
    app.include_router(auth_router)
    app.include_router(dev_router)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=True)
