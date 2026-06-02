from fastapi import APIRouter
from app.providers.registry import list_providers as get_providers

router = APIRouter(prefix="/api", tags=["providers"])


@router.get("/providers")
async def list_providers():
    return get_providers()
