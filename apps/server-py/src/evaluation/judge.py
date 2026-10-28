"""Optional structured LLM Judge for semantic answer checks."""

import json
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from src.evaluation.types import EvalCase, MetricResult, RuntimeSnapshot
from src.providers.base import LLMProvider
from src.schemas.chat import ChatMessage


class JudgeDimension(BaseModel):
    score: float | None = Field(default=None, ge=0, le=1)
    rationale: str = ""
    refused: bool | None = None
    fabricated: bool | None = None
    covered: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    forbidden_hit: list[str] = Field(default_factory=list, alias="forbiddenHit")
    verdict: Literal["supported", "mixed", "fabricated"] | None = None

    model_config = {"populate_by_name": True}

    @field_validator("score", mode="before")
    @classmethod
    def normalize_score(cls, value):
        if value is None:
            return None
        return float(value)


class JudgePayload(BaseModel):
    dimensions: dict[str, JudgeDimension]


class LLMJudge:
    def __init__(
        self,
        provider: LLMProvider,
        *,
        model: str,
        system_prompt: str = "",
    ) -> None:
        self._provider = provider
        self.model = model
        self._system_prompt = system_prompt or (
            "You are an impartial evaluator. Return JSON only with this shape: "
            '{"dimensions":{"dimension_name":{"score":0.0,"rationale":"..."}}}. '
            "Score each requested dimension from 0 to 1."
        )

    async def evaluate(self, case: EvalCase, snapshot: RuntimeSnapshot) -> list[MetricResult]:
        dimensions = _judge_dimensions(case)
        if not dimensions:
            return []
        prompt = json.dumps(
            {
                "question": case.question,
                "answer": snapshot.answer,
                "citations": snapshot.citations,
                "retrieval_hits": [hit.model_dump(mode="json") for hit in snapshot.graded_hits],
                "web_snippet": snapshot.web_snippet,
                "errors": snapshot.errors,
                "requested_dimensions": dimensions,
                "key_points": case.expected.key_points,
                "must_not_contain": case.expected.must_not_contain,
            },
            ensure_ascii=False,
        )
        try:
            response = await self._provider.chat_sync(
                [ChatMessage(role="user", content=prompt)],
                model=self.model,
                system_prompt=self._system_prompt,
                temperature=0,
                max_tokens=1200,
                json_mode=True,
            )
            payload = JudgePayload.model_validate_json(response.content)
        except (ValidationError, ValueError, TypeError, json.JSONDecodeError) as exc:
            return [_judge_error(f"Judge response invalid: {exc}")]
        except Exception as exc:  # noqa: BLE001 - provider errors are report data
            return [_judge_error(f"Judge invocation failed: {type(exc).__name__}: {exc}")]

        metrics: list[MetricResult] = []
        for dimension in dimensions:
            result = payload.dimensions.get(dimension)
            if result is None:
                metrics.append(_judge_error(f"Judge omitted dimension: {dimension}", dimension))
                continue
            score = _dimension_score(dimension, result, case)
            if score is None:
                metrics.append(_judge_error(f"Judge omitted score for dimension: {dimension}", dimension))
                continue
            passed = score >= case.expected.judge_min_score
            metrics.append(
                MetricResult(
                    name=f"judge_{dimension}",
                    status="pass" if passed else "fail",
                    score=score,
                    message=result.rationale,
                    details={
                        "model": self.model,
                        "threshold": case.expected.judge_min_score,
                        "covered": result.covered,
                        "missing": result.missing,
                        "forbidden_hit": result.forbidden_hit,
                        "verdict": result.verdict,
                    },
                )
            )
        return metrics


def _judge_error(message: str, dimension: str = "judge") -> MetricResult:
    return MetricResult(
        name=f"judge_{dimension}",
        status="error",
        score=None,
        message=message,
    )


def _judge_dimensions(case: EvalCase) -> list[str]:
    dimensions = list(case.expected.judge_dimensions)
    if case.expected.expect_refusal is True and "refusal" not in dimensions:
        dimensions.append("refusal")
    if (
        (case.expected.key_points or case.expected.must_not_contain)
        and "completeness" not in dimensions
    ):
        dimensions.append("completeness")
    if case.expected.judge_groundedness is not False and "groundedness" not in dimensions:
        dimensions.append("groundedness")
    return dimensions


def _dimension_score(
    dimension: str,
    result: JudgeDimension,
    case: EvalCase,
) -> float | None:
    if dimension == "refusal":
        if result.refused is None or result.fabricated is None:
            return result.score
        return 1.0 if result.refused and not result.fabricated else 0.0
    if dimension == "completeness":
        if result.forbidden_hit:
            return 0.0
        points = case.expected.key_points
        if not points:
            return result.score if result.score is not None else 1.0
        covered = sum(point in result.covered for point in points)
        return covered / len(points)
    if dimension == "groundedness" and result.verdict is not None:
        return {"supported": 1.0, "mixed": 0.5, "fabricated": 0.0}[result.verdict]
    return result.score
