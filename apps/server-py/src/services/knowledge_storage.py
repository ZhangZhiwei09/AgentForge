"""Local and MinIO storage with compatibility for existing stored paths."""

import asyncio
import io
import uuid
from pathlib import Path, PurePosixPath

from minio import Minio

from src.config import settings

APP_ROOT = Path(__file__).resolve().parents[2]


def storage_root() -> Path:
    configured = Path(settings.knowledge_storage_root)
    return (configured if configured.is_absolute() else APP_ROOT / configured).resolve()


def local_path(key: str) -> Path:
    root = storage_root()
    candidate = Path(key)
    resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError("Invalid storage path")
    return resolved


def object_key(key: str) -> str:
    normalized = key.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts or not path.parts or ":" in normalized:
        raise ValueError("Invalid object storage key")
    return str(path)


def minio_client() -> Minio:
    return Minio(
        f"{settings.minio_endpoint}:{settings.minio_port}",
        access_key=settings.minio_access_key, secret_key=settings.minio_secret_key,
        secure=settings.minio_use_ssl,
    )


async def save_file(key: str, content: bytes) -> str:
    if settings.minio_endpoint and settings.minio_access_key:
        key = object_key(key)

        def upload():
            client = minio_client()
            if not client.bucket_exists(settings.minio_bucket):
                client.make_bucket(settings.minio_bucket)
            client.put_object(settings.minio_bucket, key, io.BytesIO(content), len(content))

        await asyncio.to_thread(upload)
        return key
    target = local_path(key)

    def write():
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{uuid.uuid4().hex}.upload")
        try:
            temporary.write_bytes(content)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    await asyncio.to_thread(write)
    return str(target)


async def read_file(key: str) -> bytes:
    # Legacy local storage persisted absolute paths even when MinIO was later enabled.
    if Path(key).is_absolute() or not (settings.minio_endpoint and settings.minio_access_key):
        return await asyncio.to_thread(local_path(key).read_bytes)
    key = object_key(key)

    def download():
        response = minio_client().get_object(settings.minio_bucket, key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    return await asyncio.to_thread(download)


async def delete_file(key: str) -> None:
    if Path(key).is_absolute() or not (settings.minio_endpoint and settings.minio_access_key):
        await asyncio.to_thread(local_path(key).unlink, missing_ok=True)
    else:
        await asyncio.to_thread(minio_client().remove_object, settings.minio_bucket, object_key(key))
