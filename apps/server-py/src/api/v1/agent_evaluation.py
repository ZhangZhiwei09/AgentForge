"""Authenticated API for durable Agent evaluation suites and runs."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_db, require_admin
from src.schemas.agent_evaluation import (
    EvaluationCaseCreate,
    EvaluationRunCreate,
    EvaluationSuiteCreate,
)
from src.services.agent_evaluation import AgentEvaluationService

router = APIRouter(
    prefix="/api/evaluations",
    tags=["agent-evaluation"],
    dependencies=[Depends(require_admin)],
)
Db = Annotated[AsyncSession, Depends(get_db)]


@router.get("/suites")
async def list_suites(db: Db):
    return await AgentEvaluationService(db).list_suites()


@router.post("/suites", status_code=201)
async def create_suite(body: EvaluationSuiteCreate, db: Db):
    return await AgentEvaluationService(db).create_suite(body)


@router.get("/suites/{suite_id}/cases")
async def list_cases(suite_id: str, db: Db):
    return await AgentEvaluationService(db).list_cases(suite_id)


@router.post("/suites/{suite_id}/cases", status_code=201)
async def create_case(suite_id: str, body: EvaluationCaseCreate, db: Db):
    return await AgentEvaluationService(db).create_case(suite_id, body)


@router.delete("/cases/{case_id}")
async def delete_case(case_id: str, db: Db):
    await AgentEvaluationService(db).delete_case(case_id)
    return {"status": "deleted"}


@router.put("/cases/{case_id}")
async def update_case(case_id: str, body: EvaluationCaseCreate, db: Db):
    return await AgentEvaluationService(db).update_case(case_id, body)


@router.post("/suites/{suite_id}/runs", status_code=201)
async def run_suite(suite_id: str, body: EvaluationRunCreate, db: Db):
    return await AgentEvaluationService(db).run(suite_id, body)


@router.get("/suites/{suite_id}/runs")
async def list_runs(
    suite_id: str,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    return await AgentEvaluationService(db).list_runs(suite_id, limit)


@router.get("/suites/{suite_id}/metrics")
async def metrics(
    suite_id: str,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    return await AgentEvaluationService(db).metrics(suite_id, limit)
