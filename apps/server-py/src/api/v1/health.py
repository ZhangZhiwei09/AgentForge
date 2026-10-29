import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_db, require_admin
from src.config import settings
from src.observability.metrics import render_metrics
from src.providers.registry import get_provider, resolve_model

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/api/health")
async def health():
    return {"status": "ok"}


@router.get("/api/ready")
async def readiness(db: Annotated[AsyncSession, Depends(get_db)]):
    checks = {}
    try:
        async with asyncio.timeout(2):
            await db.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception:
        logger.exception("Readiness database check failed")
        checks["db"] = "error"
        await db.rollback()
    try:
        get_provider(resolve_model(None)["provider_name"])
        checks["llm"] = "ok"
    except ValueError:
        checks["llm"] = "degraded"
    redis = Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)
    try:
        async with asyncio.timeout(2):
            await redis.ping()
        checks["redis"] = "ok"
    except Exception:
        logger.exception("Readiness Redis check failed")
        checks["redis"] = "error" if settings.ingestion_async_enabled else "degraded"
    finally:
        await redis.aclose()
    ready = "error" not in checks.values()
    return JSONResponse(
        {"status": "ready" if ready else "not_ready", "checks": checks}, status_code=200 if ready else 503,
    )


@router.get("/api/metrics", dependencies=[Depends(require_admin)])
async def metrics():
    return Response(render_metrics(), headers={"Content-Type": CONTENT_TYPE_LATEST})
