import json
from pathlib import Path
from uuid import uuid4

from src.evaluation.cases import dump_cases, load_cases, parse_cases
from src.evaluation.types import EvalCase, ExpectedOutcome


def test_parse_cases_accepts_wrapped_document():
    cases = parse_cases(
        {
            "schema_version": "1",
            "cases": [
                {
                    "id": "route-task",
                    "question": "查询订单",
                    "expected": {"route": "TASK", "required_tools": ["search"]},
                }
            ],
        }
    )

    assert cases[0].expected.route == "TASK"
    assert cases[0].expected.required_tools == ["search"]


def test_parse_cases_accepts_reference_golden_shape():
    cases = parse_cases(
        [
            {
                "input": {"question": "查制度"},
                "expectedOutput": {"intent": "kb", "requireRetrieve": True},
                "metadata": {"id": "kb-1", "suite": "kb-hit"},
            }
        ]
    )

    assert cases[0].id == "kb-1"
    assert cases[0].suite == "kb-hit"
    assert cases[0].expected.require_retrieve is True


def test_dump_and_load_cases_round_trip():
    path = Path.cwd() / f".evaluation-cases-{uuid4().hex}.json"
    original = [
        EvalCase(
            id="one",
            question="hello",
            expected=ExpectedOutcome(required_text=["world"]),
        )
    ]

    try:
        dump_cases(original, path)
        loaded = load_cases(path)

        assert loaded == original
        assert json.loads(path.read_text(encoding="utf-8"))["cases"][0]["id"] == "one"
    finally:
        path.unlink(missing_ok=True)
