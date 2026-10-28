"""Loading and writing versioned evaluation cases."""

import json
from pathlib import Path
from typing import Any

from src.evaluation.types import EvalCase


def parse_cases(payload: Any) -> list[EvalCase]:
    """Parse either a case list or ``{"cases": [...]}`` document."""
    raw_cases = payload.get("cases", []) if isinstance(payload, dict) else payload
    if not isinstance(raw_cases, list):
        raise TypeError("Evaluation case document must contain a list of cases")
    return [EvalCase.model_validate(_normalize_case(item)) for item in raw_cases]


def _normalize_case(item: Any) -> dict:
    if not isinstance(item, dict):
        return item
    if "input" not in item and "expectedOutput" not in item:
        return item
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    expected = item.get("expectedOutput") if isinstance(item.get("expectedOutput"), dict) else {}
    input_data = item.get("input") if isinstance(item.get("input"), dict) else {}
    return {
        "id": item.get("id") or metadata.get("id"),
        "suite": item.get("suite") or metadata.get("suite") or "default",
        "question": input_data.get("question", ""),
        "model": item.get("model"),
        "intent": expected.get("intent", ""),
        "expected": expected,
        "metadata": metadata,
    }


def load_cases(path: str | Path) -> list[EvalCase]:
    source = Path(path)
    return parse_cases(json.loads(source.read_text(encoding="utf-8")))


def dump_cases(cases: list[EvalCase], path: str | Path) -> None:
    target = Path(path)
    target.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "cases": [case.model_dump(mode="json", by_alias=True) for case in cases],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
