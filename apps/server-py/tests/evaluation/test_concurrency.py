import asyncio

from src.agent.types import RouteContext, StreamDone, StreamToken
from src.evaluation.harness import EvaluationHarness
from src.evaluation.run import run_cases
from src.evaluation.types import EvalCase, ExpectedOutcome, ToolCallSnapshot


async def test_concurrent_cases_keep_tool_observations_in_their_own_snapshot():
    async def executor(context: RouteContext):
        await asyncio.sleep(0.001 if context.user_message == "slow" else 0)
        harness.record_tool_call(
            ToolCallSnapshot(name=context.user_message, source="observer")
        )
        yield StreamToken(content=context.user_message)
        yield StreamDone(route="CHAT")

    harness = EvaluationHarness(executor)
    cases = [
        EvalCase(
            id="slow",
            question="slow",
            expected=ExpectedOutcome(route="CHAT", required_text=["slow"]),
        ),
        EvalCase(
            id="fast",
            question="fast",
            expected=ExpectedOutcome(route="CHAT", required_text=["fast"]),
        ),
    ]

    report = await run_cases(cases, harness, max_concurrency=2)

    assert report.passed_cases == 2
    assert [case.snapshot.tools[0].name for case in report.cases] == ["slow", "fast"]
