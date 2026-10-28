from src.evaluation.judge import LLMJudge
from src.evaluation.types import EvalCase, ExpectedOutcome, RuntimeSnapshot
from src.schemas.chat import ChatSyncResult


class FakeProvider:
    def __init__(self, content: str):
        self.content = content

    async def chat_sync(self, *args, **kwargs):
        return ChatSyncResult(content=self.content, usage={})


async def test_judge_returns_structured_dimension_metrics():
    judge = LLMJudge(
        FakeProvider(
            '{"dimensions":{"completeness":{"score":0.9,"rationale":"covers the steps"}}}'
        ),
        model="judge-model",
    )
    case = EvalCase(
        id="judge",
        question="如何排查",
        expected=ExpectedOutcome(
            judge_dimensions=["completeness"],
            judge_min_score=0.8,
        ),
    )

    metrics = await judge.evaluate(
        case,
        RuntimeSnapshot(case_id="judge", question=case.question, answer="步骤如下"),
    )

    assert metrics[0].status == "pass"
    assert metrics[0].score == 0.9
    assert metrics[0].details["model"] == "judge-model"


async def test_judge_parse_failure_is_error_not_zero():
    judge = LLMJudge(FakeProvider("not-json"), model="judge-model")
    case = EvalCase(
        id="judge-error",
        question="问题",
        expected=ExpectedOutcome(judge_dimensions=["groundedness"]),
    )

    metrics = await judge.evaluate(
        case,
        RuntimeSnapshot(case_id=case.id, question=case.question, answer="回答"),
    )

    assert metrics[0].status == "error"
    assert metrics[0].score is None
