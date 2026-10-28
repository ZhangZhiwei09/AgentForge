"""Persistence and execution service for complete Agent evaluations."""

import uuid
from datetime import UTC, datetime
from statistics import mean

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.evaluation.judge import LLMJudge
from src.evaluation.run import build_live_harness, run_cases
from src.evaluation.types import EvalCase, ExpectedOutcome
from src.models.agent_evaluation import (
    AgentEvaluationCase as Case,
)
from src.models.agent_evaluation import (
    AgentEvaluationItem as Item,
)
from src.models.agent_evaluation import (
    AgentEvaluationRun as Run,
)
from src.models.agent_evaluation import (
    AgentEvaluationSuite as Suite,
)
from src.providers.registry import get_provider, resolve_model
from src.schemas.agent_evaluation import (
    EvaluationCaseCreate,
    EvaluationRunCreate,
    EvaluationSuiteCreate,
)


class AgentEvaluationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    @staticmethod
    def suite_dto(suite: Suite) -> dict:
        return {
            "id": suite.id,
            "name": suite.name,
            "description": suite.description,
            "version": suite.version,
            "metadata": suite.metadata_json,
            "createdAt": suite.created_at,
            "updatedAt": suite.updated_at,
        }

    @staticmethod
    def case_dto(case: Case) -> dict:
        return {
            "id": case.id,
            "suiteId": case.suite_id,
            "caseId": case.case_key,
            "question": case.question,
            "model": case.model,
            "intent": case.intent,
            "expected": case.expected,
            "metadata": case.metadata_json,
            "createdAt": case.created_at,
            "updatedAt": case.updated_at,
        }

    @staticmethod
    def run_dto(run: Run, items: list[dict] | None = None) -> dict:
        return {
            "id": run.id,
            "suiteId": run.suite_id,
            "status": run.status,
            "model": run.model,
            "judgeModel": run.judge_model,
            "totalCases": run.total_cases,
            "passedCases": run.passed_cases,
            "failedCases": run.failed_cases,
            "errorCases": run.error_cases,
            "averageScore": run.average_score,
            "maxConcurrency": run.max_concurrency,
            "selector": run.selector,
            "metadata": run.metadata_json,
            "createdAt": run.created_at,
            "startedAt": run.started_at,
            "completedAt": run.completed_at,
            "items": items or [],
        }

    async def list_suites(self) -> list[dict]:
        rows = await self.db.scalars(select(Suite).order_by(Suite.created_at, Suite.id))
        return [self.suite_dto(row) for row in rows]

    async def create_suite(self, body: EvaluationSuiteCreate) -> dict:
        suite = Suite(
            id=str(uuid.uuid4()),
            name=body.name,
            description=body.description,
            version=body.version,
            metadata_json=body.metadata,
        )
        self.db.add(suite)
        await self.db.commit()
        await self.db.refresh(suite)
        return self.suite_dto(suite)

    async def get_suite(self, suite_id: str) -> Suite:
        suite = await self.db.get(Suite, suite_id)
        if suite is None:
            raise HTTPException(404, "评测套件不存在")
        return suite

    async def list_cases(self, suite_id: str) -> list[dict]:
        await self.get_suite(suite_id)
        rows = await self.db.scalars(
            select(Case).where(Case.suite_id == suite_id).order_by(Case.created_at, Case.id)
        )
        return [self.case_dto(row) for row in rows]

    async def create_case(self, suite_id: str, body: EvaluationCaseCreate) -> dict:
        await self.get_suite(suite_id)
        exists = await self.db.scalar(
            select(Case).where(Case.suite_id == suite_id, Case.case_key == body.caseId)
        )
        if exists is not None:
            raise HTTPException(409, "评测用例 ID 已存在")
        case = Case(
            id=str(uuid.uuid4()),
            suite_id=suite_id,
            case_key=body.caseId,
            question=body.question,
            model=body.model,
            intent=body.intent,
            expected=ExpectedOutcome.model_validate(body.expected).model_dump(mode="json"),
            metadata_json=body.metadata,
        )
        self.db.add(case)
        await self.db.commit()
        await self.db.refresh(case)
        return self.case_dto(case)

    async def delete_case(self, case_id: str) -> None:
        result = await self.db.execute(delete(Case).where(Case.id == case_id))
        if result.rowcount != 1:
            raise HTTPException(404, "评测用例不存在")
        await self.db.commit()

    async def update_case(self, case_id: str, body: EvaluationCaseCreate) -> dict:
        case = await self.db.get(Case, case_id)
        if case is None:
            raise HTTPException(404, "评测用例不存在")
        duplicate = await self.db.scalar(
            select(Case).where(
                Case.suite_id == case.suite_id,
                Case.case_key == body.caseId,
                Case.id != case_id,
            )
        )
        if duplicate is not None:
            raise HTTPException(409, "评测用例 ID 已存在")
        case.case_key = body.caseId
        case.question = body.question
        case.model = body.model
        case.intent = body.intent
        case.expected = ExpectedOutcome.model_validate(body.expected).model_dump(mode="json")
        case.metadata_json = body.metadata
        await self.db.commit()
        await self.db.refresh(case)
        return self.case_dto(case)

    async def list_runs(self, suite_id: str, limit: int = 20) -> list[dict]:
        await self.get_suite(suite_id)
        rows = await self.db.scalars(
            select(Run)
            .where(Run.suite_id == suite_id)
            .order_by(Run.created_at.desc(), Run.id.desc())
            .limit(limit)
        )
        result = []
        for row in rows:
            result.append(self.run_dto(row, await self._items(row.id)))
        return result

    async def metrics(self, suite_id: str, limit: int = 20) -> dict:
        runs = await self.list_runs(suite_id, limit)
        trend = [
            {
                "runId": run["id"],
                "createdAt": run["createdAt"],
                "status": run["status"],
                "totalCases": run["totalCases"],
                "passedCases": run["passedCases"],
                "failedCases": run["failedCases"],
                "errorCases": run["errorCases"],
                "passRate": (
                    run["passedCases"] / run["totalCases"]
                    if run["totalCases"]
                    else 0
                ),
                "averageScore": run["averageScore"],
                "averageLatencyMs": (
                    mean(item["latencyMs"] for item in run["items"])
                    if run["items"]
                    else None
                ),
            }
            for run in reversed(runs)
        ]
        return {
            "suiteId": suite_id,
            "summary": {
                "runCount": len(trend),
                "latest": trend[-1] if trend else None,
                "averagePassRate": (
                    mean(item["passRate"] for item in trend) if trend else None
                ),
                "averageScore": (
                    mean(
                        item["averageScore"]
                        for item in trend
                        if item["averageScore"] is not None
                    )
                    if any(item["averageScore"] is not None for item in trend)
                    else None
                ),
            },
            "trend": trend,
        }

    async def _items(self, run_id: str) -> list[dict]:
        rows = await self.db.scalars(
            select(Item).where(Item.run_id == run_id).order_by(Item.created_at, Item.id)
        )
        return [
            {
                "id": row.id,
                "caseId": row.case_id,
                "passed": row.passed,
                "score": row.score,
                "snapshot": row.snapshot,
                "metrics": row.metrics,
                "error": row.error,
                "latencyMs": row.latency_ms,
                "createdAt": row.created_at,
            }
            for row in rows
        ]

    async def run(self, suite_id: str, body: EvaluationRunCreate) -> dict:
        await self.get_suite(suite_id)
        statement = select(Case).where(Case.suite_id == suite_id)
        if body.caseIds:
            statement = statement.where(Case.case_key.in_(body.caseIds))
        rows = list(await self.db.scalars(statement.order_by(Case.created_at, Case.id)))
        cases = [
            EvalCase(
                id=row.case_key,
                suite=str(row.metadata_json.get("suite", "persisted")),
                question=row.question,
                model=row.model or body.model,
                intent=row.intent,
                expected=ExpectedOutcome.model_validate(row.expected),
                metadata=row.metadata_json,
            )
            for row in rows
            if (
                not body.selector
                or row.case_key == body.selector
                or row.metadata_json.get("suite") == body.selector
            )
        ]
        row_by_key = {row.case_key: row for row in rows}
        run = Run(
            id=str(uuid.uuid4()),
            suite_id=suite_id,
            status="running",
            model=body.model,
            judge_model=body.judgeModel,
            total_cases=len(cases),
            max_concurrency=body.maxConcurrency,
            selector=body.selector,
        )
        self.db.add(run)
        await self.db.commit()
        try:
            judge = None
            if body.judgeModel:
                resolved = resolve_model(body.judgeModel)
                judge = LLMJudge(
                    get_provider(resolved["provider_name"]),
                    model=resolved["model_id"],
                )
            report = await run_cases(
                cases,
                build_live_harness(),
                judge=judge,
                max_concurrency=body.maxConcurrency,
                metadata={"suite_id": suite_id},
            )
            for report_case in report.cases:
                source = row_by_key[report_case.case_id]
                self.db.add(
                    Item(
                        id=str(uuid.uuid4()),
                        run_id=run.id,
                        case_id=source.id,
                        passed=report_case.passed,
                        score=report_case.score,
                        snapshot=report_case.snapshot.model_dump(mode="json"),
                        metrics=[metric.model_dump(mode="json") for metric in report_case.metrics],
                        error="; ".join(report_case.snapshot.errors) or None,
                        latency_ms=report_case.snapshot.latency_ms,
                    )
                )
            scores = [item.score for item in report.cases if item.score is not None]
            run.status = "completed"
            run.passed_cases = report.passed_cases
            run.failed_cases = report.failed_cases
            run.error_cases = report.error_cases
            run.average_score = mean(scores) if scores else None
            run.completed_at = datetime.now(UTC)
            await self.db.commit()
            await self.db.refresh(run)
            return self.run_dto(run, await self._items(run.id))
        except Exception:
            await self.db.rollback()
            run = await self.db.get(Run, run.id)
            if run is not None:
                run.status = "failed"
                run.completed_at = datetime.now(UTC)
                await self.db.commit()
            raise
