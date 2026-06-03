from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.database.session import get_db
from app.schemas.memory import MemoryOut, MemorySearchResult
from app.services.memory_engine import MemoryEngine

router = APIRouter(prefix="/api/memories", tags=["memories"])

DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"


@router.get("", response_model=list[MemoryOut])
async def list_memories(
    type: str | None = Query(None, description="Filter by memory type"),
    db: AsyncSession = Depends(get_db),
):
    engine = MemoryEngine(db)
    return await engine.list(user_id=DEFAULT_USER_ID, type=type)


@router.get("/search", response_model=list[MemorySearchResult])
async def search_memories(
    q: str = Query(..., description="Search query"),
    top_k: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
):
    engine = MemoryEngine(db)
    return await engine.search(query=q, user_id=DEFAULT_USER_ID, top_k=top_k)


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, db: AsyncSession = Depends(get_db)):
    engine = MemoryEngine(db)
    deleted = await engine.delete(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"status": "deleted"}
