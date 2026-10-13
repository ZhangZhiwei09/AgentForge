"""Knowledge retrieval evaluation endpoints used by the existing editor."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.schemas.knowledge_retrieval import (
    RegressionCaseInput,
    RegressionRunInput,
    TestSetCreate,
)
from src.services.knowledge_management import get_base
from src.services.knowledge_regression import KnowledgeRegressionService

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(get_current_user)])
Db = Annotated[AsyncSession, Depends(get_db)]


@router.get("/bases/{base_id}/regression/test-sets")
async def list_sets(base_id: str, db: Db):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).list_sets(base_id)


@router.post("/bases/{base_id}/regression/test-sets", status_code=201)
async def create_set(base_id: str, body: TestSetCreate, db: Db):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).create_set(base_id, body.name, body.description)


@router.post("/bases/{base_id}/regression/cases", status_code=201)
async def create_case(base_id: str, body: RegressionCaseInput, db: Db):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).create_case(base_id, body)


@router.put("/regression/cases/{case_id}")
async def update_case(case_id: str, body: RegressionCaseInput, db: Db):
    return await KnowledgeRegressionService(db).update_case(case_id, body)


@router.delete("/regression/cases/{case_id}")
async def delete_case(case_id: str, db: Db):
    await KnowledgeRegressionService(db).delete_case(case_id)
    return {"status": "deleted"}


@router.post("/bases/{base_id}/regression/runs", status_code=201)
async def run_set(base_id: str, body: RegressionRunInput, db: Db):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).run(base_id, body.testSetId)


@router.get("/bases/{base_id}/regression/runs")
async def list_runs(base_id: str, db: Db, testSetId: str | None = None):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).list_runs(base_id, testSetId)


@router.get("/bases/{base_id}/regression/metrics")
async def metrics(base_id: str, db: Db, testSetId: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 30):
    await get_base(db, base_id)
    return await KnowledgeRegressionService(db).metrics(base_id, testSetId, limit)
