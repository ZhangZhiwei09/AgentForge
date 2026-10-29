import pytest
import pytest_asyncio
from sqlalchemy import select

from src.models.agent_evaluation import (
    AgentEvaluationCase,
    AgentEvaluationItem,
    AgentEvaluationRun,
    AgentEvaluationSuite,
)
from src.models.base import Base

ADMIN = {"X-Test-Actor": "admin"}
TABLES = [
    AgentEvaluationSuite.__table__,
    AgentEvaluationCase.__table__,
    AgentEvaluationRun.__table__,
    AgentEvaluationItem.__table__,
]


@pytest_asyncio.fixture
async def evaluation_api(entry_api):
    client, sessions = entry_api
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=TABLES))
    return client, sessions


@pytest.mark.asyncio
async def test_evaluation_suite_case_crud_is_authenticated(evaluation_api):
    client, sessions = evaluation_api

    assert (await client.get("/api/evaluations/suites")).status_code == 401
    created = await client.post(
        "/api/evaluations/suites",
        headers=ADMIN,
        json={"name": "Agent smoke", "version": "2"},
    )
    assert created.status_code == 201, created.text
    suite = created.json()
    assert suite["version"] == "2"

    case_response = await client.post(
        f"/api/evaluations/suites/{suite['id']}/cases",
        headers=ADMIN,
        json={
            "caseId": "hello",
            "question": "你好",
            "expected": {"route": "CHAT", "requiredText": ["你好"]},
        },
    )
    assert case_response.status_code == 201, case_response.text
    case = case_response.json()
    assert case["expected"]["route"] == "CHAT"
    assert (await client.post(
        f"/api/evaluations/suites/{suite['id']}/cases",
        headers=ADMIN,
        json={"caseId": "hello", "question": "重复"},
    )).status_code == 409

    listed = await client.get(
        f"/api/evaluations/suites/{suite['id']}/cases",
        headers=ADMIN,
    )
    assert [item["caseId"] for item in listed.json()] == ["hello"]
    assert (await client.delete(
        f"/api/evaluations/cases/{case['id']}",
        headers=ADMIN,
    )).status_code == 200
    async with sessions() as db:
        assert await db.scalar(select(AgentEvaluationCase)) is None
