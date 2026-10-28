"""Optional evaluation integrations that never affect the local report."""

from typing import Protocol

from src.evaluation.types import EvalRunReport
from src.observability import get_observability


class EvaluationPublisher(Protocol):
    async def publish(self, report: EvalRunReport, name: str = "agent-evaluation") -> None:
        ...


class LangfuseEvaluationPublisher:
    """Publish one trace per case when the existing Langfuse provider is enabled.

    The durable JSON/database report remains the source of truth. Langfuse is
    an optional observability view and failures are intentionally swallowed by
    the existing observability provider.
    """

    async def publish(self, report: EvalRunReport, name: str = "agent-evaluation") -> None:
        observability = get_observability()
        if not observability.enabled:
            return
        for case in report.cases:
            with observability.create_trace(
                name=name,
                input=case.snapshot.question,
                metadata={
                    "case_id": case.case_id,
                    "passed": case.passed,
                    "score": case.score,
                    "judge_model": report.judge_model or "",
                },
            ) as trace:
                trace.end(
                    output=case.snapshot.answer,
                    metadata={
                        "metrics": [metric.model_dump(mode="json") for metric in case.metrics],
                        "latency_ms": case.snapshot.latency_ms,
                    },
                )
        observability.flush()
