"""Best-effort synchronization of the existing Elasticsearch chunk index."""

import json
import logging
from urllib.parse import quote

import httpx

from src.config import settings

logger = logging.getLogger(__name__)
INDEX = "knowledge_chunks"


async def request_index(
    method: str, path: str, body: dict | None = None, *, content: str | None = None,
) -> dict | None:
    if not settings.elasticsearch_url:
        return None
    try:
        async with httpx.AsyncClient(
            base_url=settings.elasticsearch_url.rstrip("/") + "/", timeout=10, trust_env=False,
        ) as client:
            response = await client.request(
                method, path, json=body, content=content,
                headers={"Content-Type": "application/x-ndjson"} if content is not None else None,
            )
            if response.status_code == 404:
                return None
            if method == "HEAD":
                response.raise_for_status()
                return {}
            payload = response.json()
            if not isinstance(payload, dict):
                raise TypeError("Invalid Elasticsearch response")
            if method == "PUT" and path == INDEX and response.status_code == 400:
                error = payload.get("error", {})
                if isinstance(error, dict) and error.get("type") == "resource_already_exists_exception":
                    return {}
            response.raise_for_status()
            return payload
    except (httpx.HTTPError, ValueError, TypeError):
        logger.warning("Elasticsearch synchronization unavailable method=%s path=%s", method, path)
        return None


async def remove_documents(document_ids: list[str]) -> None:
    if document_ids:
        await request_index("POST", f"{INDEX}/_delete_by_query?refresh=true", {
            "query": {"terms": {"docId": document_ids}},
        })


async def ensure_index() -> bool:
    if not settings.elasticsearch_url:
        return False
    existing = await request_index("HEAD", INDEX)
    if existing is None:
        created = await request_index("PUT", INDEX, {
            "mappings": {"properties": {
                **{field: {"type": "keyword"} for field in (
                    "chunkId", "kbId", "docId", "sourceType", "qualityLabel",
                )},
                "title": {"type": "text", "analyzer": "standard"},
                "content": {"type": "text", "analyzer": "standard"},
                "metadata": {"type": "object", "enabled": False},
                "createdAt": {"type": "date"},
            }},
            "settings": {"number_of_shards": 1, "number_of_replicas": 0},
        })
        if created is None:
            return False
    return True


async def update_chunk(payload: dict) -> None:
    if not await ensure_index():
        return
    await request_index("PUT", f"{INDEX}/_doc/{quote(payload['chunkId'], safe='')}?refresh=wait_for", payload)


async def bulk_index_chunks(chunks: list[dict]) -> None:
    if not chunks or not await ensure_index():
        return
    for start in range(0, len(chunks), 100):
        lines = []
        for chunk in chunks[start:start + 100]:
            lines.extend([
                json.dumps({"index": {"_index": INDEX, "_id": chunk["chunkId"]}}),
                json.dumps(chunk, ensure_ascii=False),
            ])
        result = await request_index("POST", "_bulk?refresh=true", content="\n".join(lines) + "\n")
        if result and result.get("errors"):
            logger.warning("Elasticsearch bulk index contains failed items")


async def index_stats() -> tuple[bool, int]:
    result = await request_index("GET", f"{INDEX}/_count")
    count = result.get("count") if result else None
    if type(count) is not int or count < 0:
        return False, 0
    return True, count
