from src.evaluation.evaluators import evaluate_case
from src.evaluation.types import (
    EvalCase,
    ExpectedOutcome,
    RuntimeSnapshot,
    ToolCallSnapshot,
)


def test_deterministic_evaluators_pass_expected_case():
    case = EvalCase(
        id="good",
        question="查询超时",
        expected=ExpectedOutcome(
            route="TASK",
            allowed_tools=["search"],
            required_tools=["search"],
            required_text=["建议"],
            forbidden_text=["无法确认"],
            answer_required=True,
            fallback_used=False,
        ),
    )
    snapshot = RuntimeSnapshot(
        case_id=case.id,
        question=case.question,
        route="TASK",
        answer="建议检查网络连接。",
        tools=[ToolCallSnapshot(name="search", status="success")],
        fallback_used=False,
    )

    report = evaluate_case(case, snapshot)

    assert report.passed is True
    assert report.score == 1.0
    assert all(metric.status in {"pass", "skipped"} for metric in report.metrics)


def test_deterministic_evaluators_distinguish_error_from_quality_failure():
    case = EvalCase(
        id="bad",
        question="查询",
        expected=ExpectedOutcome(route="TASK", required_text=["建议"]),
    )
    snapshot = RuntimeSnapshot(
        case_id=case.id,
        question=case.question,
        route="CHAT",
        answer="没有相关信息。",
        errors=["provider unavailable"],
        status="error",
    )

    report = evaluate_case(case, snapshot)
    statuses = {metric.name: metric.status for metric in report.metrics}

    assert report.passed is False
    assert statuses["execution"] == "error"
    assert statuses["route_match"] == "fail"
    assert statuses["required_text"] == "fail"


def test_reference_retrieval_metrics_cover_hit_precision_and_empty_false_hit():
    case = EvalCase(
        id="retrieval",
        question="差旅",
        expected=ExpectedOutcome(
            relevant_doc_titles=["差旅"],
            expected_top_k=2,
            require_retrieve=True,
        ),
    )
    snapshot = RuntimeSnapshot(
        case_id=case.id,
        question=case.question,
        retrieve_count=1,
        raw_hits=[
            {"document_title": "差旅制度", "score": 0.9},
            {"document_title": "其他制度", "score": 0.8},
        ],
    )

    report = evaluate_case(case, snapshot)
    metrics = {metric.name: metric for metric in report.metrics}

    assert metrics["hit_at_k"].score == 1
    assert metrics["precision_at_k"].score == 0.5
    assert metrics["false_hit"].status == "skipped"
