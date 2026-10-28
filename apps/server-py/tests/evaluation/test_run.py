import json

from src.agent.types import RouteContext, StreamDone, StreamToken
from src.evaluation.harness import EvaluationHarness
from src.evaluation.run import load_callable, run_cases
from src.evaluation.types import EvalCase, ExpectedOutcome


async def _executor(context: RouteContext):
    yield StreamToken(content="ok")
    yield StreamDone(route="CHAT", fallback_used=False)


async def test_run_cases_builds_json_serializable_report():
    cases = [
        EvalCase(
            id="run",
            question="hello",
            expected=ExpectedOutcome(route="CHAT", required_text=["ok"]),
        )
    ]

    report = await run_cases(cases, EvaluationHarness(_executor))
    encoded = json.dumps(report.model_dump(mode="json"))

    assert report.passed_cases == 1
    assert report.error_cases == 0
    assert json.loads(encoded)["cases"][0]["passed"] is True


def test_load_callable_uses_module_attribute():
    value = load_callable("src.evaluation.run:build_default_executor")
    assert callable(value)
