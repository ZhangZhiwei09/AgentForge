"""ARQ ingestion dispatch; SQL remains the authoritative processing state."""

import asyncio
import logging
from typing import ClassVar

from arq import Retry, create_pool
from arq.connections import RedisSettings
from fastapi import HTTPException
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.db import async_session
from src.services.knowledge_ingestion import IngestionService, ingestion_lease_seconds

logger = logging.getLogger(__name__)
QUEUE = "agentforge:python:knowledge-ingestion"


async def dispatch_ingestion(db: AsyncSession, document_id: str, base_id: str) -> dict:
    if not settings.ingestion_async_enabled:
        async with asyncio.timeout(settings.ingestion_job_timeout_seconds):
            return await IngestionService(db).process(document_id, base_id)
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    redis_settings.conn_retries = 0
    redis_settings.conn_timeout = 2
    try:
        pool = await create_pool(redis_settings, default_queue_name=QUEUE)
        try:
            await pool.enqueue_job("ingest_document_job", document_id, base_id, _job_id=f"ingest-{document_id}")
        finally:
            await pool.aclose(close_connection_pool=True)
    except (RedisError, OSError, TimeoutError) as exc:
        logger.exception("Ingestion enqueue failed document=%s", document_id)
        raise HTTPException(503, "摄入队列不可用，文档已保留，可稍后重新处理") from exc
    return {"doc_id": document_id, "status": "pending"}


async def ingest_document_job(context: dict, document_id: str, base_id: str) -> dict:
    session_factory = context.get("session_factory", async_session)
    attempt = context.get("job_try", 1)
    try:
        async with session_factory() as db:
            async with asyncio.timeout(max(1, settings.ingestion_job_timeout_seconds - 5)):
                result = await IngestionService(db).process(document_id, base_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            return {"doc_id": document_id, "status": "deleted"}
        raise
    except TimeoutError:
        if attempt < 3:
            raise Retry(defer=2 ** attempt) from None
        raise
    if result["status"] == "busy" and attempt < 3:
        raise Retry(defer=ingestion_lease_seconds() + 1)
    if result.get("retryable") and attempt < 3:
        raise Retry(defer=2 ** attempt)
    return result


class WorkerSettings:
    functions: ClassVar[list] = [ingest_document_job]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    queue_name = QUEUE
    max_jobs = 4
    max_tries = 3
    job_timeout = settings.ingestion_job_timeout_seconds
    keep_result = 0
    health_check_interval = 30
