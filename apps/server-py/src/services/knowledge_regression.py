"""Persistent knowledge retrieval regression sets, cases, runs and metrics."""

import asyncio
import time
import uuid
from datetime import UTC, datetime

import anyio
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.knowledge import KnowledgeBase
from src.models.knowledge_regression import (
    KnowledgeRegressionCase as Case,
)
from src.models.knowledge_regression import (
    KnowledgeRegressionRun as Run,
)
from src.models.knowledge_regression import (
    KnowledgeRegressionRunItem as Item,
)
from src.models.knowledge_regression import (
    KnowledgeRegressionTestSet as TestSet,
)
from src.schemas.knowledge_retrieval import RegressionCaseInput
from src.services import knowledge_eval_metrics as evaluation
from src.services.knowledge_retrieval import result_dto, retrieval_service

CASE_FIELDS = {
    "test_set_id": "testSetId", "kb_id": "kbId", "expected_top_k": "expectedTopK", "min_score": "minScore",
    "expected_doc_titles": "expectedDocTitles", "expected_doc_ids": "expectedDocIds",
    "required_text": "requiredText", "forbidden_text": "forbiddenText",
    "prompt_required_context_text": "promptRequiredContextText", "created_at": "createdAt", "updated_at": "updatedAt",
}
RUN_FIELDS = {
    "test_set_id": "testSetId", "kb_id": "kbId", "total_cases": "totalCases", "passed_cases": "passedCases",
    "failed_cases": "failedCases", "hit_rate": "hitRate", "average_rank": "averageRank",
    "average_elapsed_ms": "averageElapsedMs", "created_at": "createdAt", "completed_at": "completedAt",
}
ITEM_FIELDS = {
    "run_id": "runId", "case_id": "caseId", "matched_doc_id": "matchedDocId", "failure_reason": "failureReason",
    "results_snapshot": "resultsSnapshot", "prompt_snapshot": "promptSnapshot",
    "elapsed_ms": "elapsedMs", "created_at": "createdAt",
}
CONFIG_FIELDS = {
    "search_method": "searchMethod", "top_k": "topK", "reranking_enable": "rerankingEnable",
    "score_threshold": "scoreThreshold",
}


def map_fields(row, fields: dict, plain: tuple) -> dict:
    return {
        **{key: getattr(row, key) for key in plain},
        **{target: getattr(row, source) for source, target in fields.items()},
    }


def case_dto(case: Case) -> dict:
    dto = map_fields(case, CASE_FIELDS, ("id", "name", "query"))
    for key in (
        "expectedDocTitles", "expectedDocIds", "requiredText", "forbiddenText", "promptRequiredContextText",
    ):
        dto[key] = evaluation.string_array(dto[key])
    dto["retrievalConfig"] = map_fields(case, CONFIG_FIELDS, ())
    return dto


class KnowledgeRegressionService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def lock_base(self, base_id: str):
        await self.db.scalar(select(KnowledgeBase.id).where(KnowledgeBase.id == base_id).with_for_update())

    async def get_set(self, base_id: str, set_id: str | None) -> TestSet:
        if set_id:
            test_set = await self.db.scalar(select(TestSet).where(TestSet.id == set_id, TestSet.kb_id == base_id))
            if test_set is None:
                raise HTTPException(404, "回归测试集不存在")
            return test_set
        # Serialize default-set creation on PostgreSQL without changing existing schema.
        await self.lock_base(base_id)
        test_set = await self.db.scalar(select(TestSet).where(TestSet.kb_id == base_id).order_by(
            TestSet.created_at, TestSet.id,
        ).limit(1))
        if test_set is None:
            test_set = TestSet(
                id=str(uuid.uuid4()), kb_id=base_id, name="Default regression set",
                description="Knowledge retrieval and prompt regression cases",
            )
            self.db.add(test_set)
            await self.db.flush()
        return test_set

    async def create_set(self, base_id: str, name: str, description: str | None) -> dict:
        test_set = TestSet(id=str(uuid.uuid4()), kb_id=base_id, name=name, description=description)
        self.db.add(test_set)
        await self.db.commit()
        return self.set_dto(test_set, [])

    @staticmethod
    def set_dto(test_set: TestSet, cases: list[dict]) -> dict:
        return {
            "id": test_set.id, "kbId": test_set.kb_id, "name": test_set.name, "description": test_set.description,
            "createdAt": test_set.created_at, "updatedAt": test_set.updated_at, "cases": cases,
        }

    async def list_cases(self, base_id: str, set_id: str | None = None) -> list[dict]:
        statement = select(Case).where(Case.kb_id == base_id).order_by(Case.created_at, Case.id)
        if set_id:
            statement = statement.where(Case.test_set_id == set_id)
        return [case_dto(case) for case in await self.db.scalars(statement)]

    async def list_sets(self, base_id: str) -> list[dict]:
        sets = list(await self.db.scalars(select(TestSet).where(TestSet.kb_id == base_id).order_by(
            TestSet.created_at, TestSet.id,
        )))
        if not sets:
            sets = [await self.get_set(base_id, None)]
            await self.db.commit()
        cases = await self.list_cases(base_id)
        return [self.set_dto(test_set, [case for case in cases if case["testSetId"] == test_set.id])
                for test_set in sets]

    @staticmethod
    def apply_case(case: Case, body: RegressionCaseInput):
        values = body.model_dump()
        for source, target in CASE_FIELDS.items():
            if target in values and source not in ("test_set_id", "kb_id"):
                setattr(case, source, values[target])
        case.name, case.query = body.name, body.query
        for source, target in CONFIG_FIELDS.items():
            setattr(case, source, values["retrievalConfig"][target])

    async def create_case(self, base_id: str, body: RegressionCaseInput) -> dict:
        test_set = await self.get_set(base_id, body.testSetId)
        case = Case(id=str(uuid.uuid4()), kb_id=base_id, test_set_id=test_set.id)
        self.apply_case(case, body)
        self.db.add(case)
        await self.db.commit()
        return case_dto(case)

    async def update_case(self, case_id: str, body: RegressionCaseInput) -> dict:
        case = await self.db.get(Case, case_id)
        if case is None:
            raise HTTPException(404, "回归用例不存在")
        self.apply_case(case, body)
        await self.db.commit()
        await self.db.refresh(case)
        return case_dto(case)

    async def delete_case(self, case_id: str) -> None:
        result = await self.db.execute(delete(Case).where(Case.id == case_id))
        if result.rowcount != 1:
            raise HTTPException(404, "回归用例不存在")
        await self.db.commit()

    async def run(self, base_id: str, set_id: str | None) -> dict:
        test_set = await self.get_set(base_id, set_id)
        cases = await self.list_cases(base_id, test_set.id)
        run = Run(id=str(uuid.uuid4()), kb_id=base_id, test_set_id=test_set.id, total_cases=len(cases))
        self.db.add(run)
        await self.db.commit()
        run_id = run.id
        try:
            service = retrieval_service(self.db)
            for case in cases:
                config = case["retrievalConfig"]
                started = time.perf_counter()
                results = await service.retrieve(
                    case["query"], [base_id], config["topK"], config["searchMethod"],
                    config["rerankingEnable"], config["scoreThreshold"],
                )
                elapsed = round((time.perf_counter() - started) * 1000)
                snapshot = [{"rank": index + 1, **result_dto(item)} for index, item in enumerate(results)]
                prompt = evaluation.prompt_snapshot(case["query"], snapshot)
                evaluated = evaluation.evaluate_case(case, snapshot, prompt)
                self.db.add(Item(
                    id=str(uuid.uuid4()), run_id=run_id, case_id=case["id"],
                    passed=evaluated["passed"], rank=evaluated["rank"], score=evaluated["score"],
                    matched_doc_id=evaluated["matchedDocId"], failure_reason=(evaluated["failureReason"] or "")[:2000] or None,
                    results_snapshot=snapshot, prompt_snapshot=prompt, elapsed_ms=elapsed,
                ))
                await self.db.commit()
            items = await self.run_items([run_id])
            run.passed_cases = sum(item["passed"] for item in items)
            run.failed_cases = len(cases) - run.passed_cases
            run.hit_rate = run.passed_cases / len(cases) if cases else 0
            run.average_rank = evaluation.average([item["rank"] for item in items if item["rank"] is not None])
            run.average_elapsed_ms = evaluation.average([item["elapsedMs"] for item in items])
            run.status, run.completed_at = "completed", datetime.now(UTC)
            await self.db.commit()
            return {**map_fields(run, RUN_FIELDS, ("id", "status")), "items": items}
        except (asyncio.CancelledError, Exception):
            with anyio.CancelScope(shield=True):
                await self.db.rollback()
                await self.db.execute(update(Run).where(Run.id == run_id).values(
                    status="failed", completed_at=datetime.now(UTC),
                ))
                await self.db.commit()
            raise

    async def run_items(self, run_ids: list[str]) -> list[dict]:
        if not run_ids:
            return []
        rows = (await self.db.execute(select(Item, Case.name, Case.query).join(
            Case, Case.id == Item.case_id,
        ).where(Item.run_id.in_(run_ids)).order_by(Item.created_at, Item.id))).all()
        return [
            {**map_fields(item, ITEM_FIELDS, ("id", "passed", "rank", "score")), "caseName": name, "query": query}
            for item, name, query in rows
        ]

    async def list_runs(self, base_id: str, set_id: str | None, limit: int = 20) -> list[dict]:
        statement = select(Run).where(Run.kb_id == base_id).order_by(Run.created_at.desc(), Run.id.desc()).limit(limit)
        if set_id:
            statement = statement.where(Run.test_set_id == set_id)
        runs = list(await self.db.scalars(statement))
        items = await self.run_items([run.id for run in runs])
        return [
            {**map_fields(run, RUN_FIELDS, ("id", "status")), "items": [item for item in items if item["runId"] == run.id]}
            for run in runs
        ]

    async def metrics(self, base_id: str, set_id: str | None, limit: int) -> dict:
        runs = list(reversed(await self.list_runs(base_id, set_id, limit)))
        cases = {case["id"]: case for case in await self.list_cases(base_id, set_id)}
        trend = [evaluation.run_metrics(run, cases) for run in runs]
        queries = [evaluation.query_metric(item, cases.get(item["caseId"])) for item in runs[-1]["items"]] if runs else []
        return {
            "kbId": base_id, "testSetId": set_id, "summary": evaluation.metrics_summary(trend),
            "trend": trend, "queries": queries,
        }
