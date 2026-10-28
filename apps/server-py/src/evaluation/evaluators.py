"""Deterministic evaluation functions."""

import math
from collections.abc import Iterable

from src.evaluation.types import (
    EvalCase,
    EvalCaseReport,
    MetricResult,
    RuntimeSnapshot,
)


def evaluate_case(
    case: EvalCase,
    snapshot: RuntimeSnapshot,
    *,
    extra_metrics: Iterable[MetricResult] = (),
) -> EvalCaseReport:
    metrics = [
        _execution_metric(snapshot),
        _route_metric(case, snapshot),
        _intent_metric(case, snapshot),
        _tool_metric(case, snapshot),
        _rewrite_metric(case, snapshot),
        _required_text_metric(case, snapshot),
        _forbidden_text_metric(case, snapshot),
        _answer_metric(case, snapshot),
        _fallback_metric(case, snapshot),
        _hit_at_k_metric(case, snapshot),
        _precision_at_k_metric(case, snapshot),
        _mrr_at_k_metric(case, snapshot),
        _recall_at_k_metric(case, snapshot),
        _ndcg_at_k_metric(case, snapshot),
        _false_hit_metric(case, snapshot),
        _min_score_metric(case, snapshot),
        *extra_metrics,
    ]
    applicable = [metric for metric in metrics if metric.status != "skipped"]
    passed = bool(applicable) and all(metric.status == "pass" for metric in applicable)
    scored = [metric.score for metric in applicable if metric.score is not None]
    score = round(sum(scored) / len(scored), 4) if scored else None
    return EvalCaseReport(
        case_id=case.id,
        snapshot=snapshot,
        metrics=metrics,
        passed=passed,
        score=score,
    )


def _execution_metric(snapshot: RuntimeSnapshot) -> MetricResult:
    if not snapshot.errors:
        return MetricResult(
            name="execution",
            status="pass",
            score=1.0,
            message="Execution completed without errors",
        )
    return MetricResult(
        name="execution",
        status="error",
        score=None,
        message="; ".join(snapshot.errors),
        details={"errors": snapshot.errors},
    )


def _route_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected.route
    if expected is None:
        return _skip("route_match", "No expected route")
    actual = snapshot.route
    passed = actual == str(expected)
    return _check(
        "route_match",
        passed,
        f"expected={expected!s}, actual={actual!s}",
        {"expected": str(expected), "actual": actual},
    )


def _intent_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected.intent
    if expected is None:
        return _skip("intent_match", "No expected intent")
    return _check(
        "intent_match",
        snapshot.intent == expected,
        f"expected={expected}, actual={snapshot.intent}",
        {"expected": expected, "actual": snapshot.intent},
    )


def _tool_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected
    if (
        expected.allowed_tools is None
        and not expected.required_tools
        and not expected.forbidden_tools
        and expected.require_retrieve is None
        and expected.require_web is None
        and expected.forbid_retrieve is None
        and expected.forbid_graph is None
        and expected.forbid_web is None
    ):
        return _skip("tool_policy", "No tool policy")

    actual = [tool.name for tool in snapshot.tools]
    violations: list[str] = []
    if expected.allowed_tools is not None:
        violations.extend(
            f"unexpected tool: {name}"
            for name in actual
            if name not in expected.allowed_tools
        )
    violations.extend(
        f"missing required tool: {name}"
        for name in expected.required_tools
        if name not in actual
    )
    violations.extend(
        f"forbidden tool used: {name}"
        for name in expected.forbidden_tools
        if name in actual
    )
    if expected.require_retrieve is True and snapshot.retrieve_count < 1:
        violations.append("retrieval was required but not used")
    if expected.require_web is True and not snapshot.web_used:
        violations.append("web was required but not used")
    if expected.forbid_retrieve is True and snapshot.retrieve_count > 0:
        violations.append(f"retrieval was forbidden but count={snapshot.retrieve_count}")
    if expected.forbid_graph is True and snapshot.graph_used:
        violations.append("graph was forbidden but used")
    if expected.forbid_web is True and snapshot.web_used:
        violations.append("web was forbidden but used")
    return _check(
        "tool_policy",
        not violations,
        "; ".join(violations) or "Tool policy satisfied",
        {"expected": expected.model_dump(), "actual": actual},
    )


def _required_text_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    required = case.expected.required_text
    if not required:
        return _skip("required_text", "No required text")
    answer = snapshot.answer.casefold()
    missing = [text for text in required if text.casefold() not in answer]
    return _check(
        "required_text",
        not missing,
        "All required text found" if not missing else f"Missing: {missing}",
        {"required": required, "missing": missing},
    )


def _forbidden_text_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    forbidden = case.expected.forbidden_text
    if not forbidden:
        return _skip("forbidden_text", "No forbidden text")
    answer = snapshot.answer.casefold()
    found = [text for text in forbidden if text.casefold() in answer]
    return _check(
        "forbidden_text",
        not found,
        "No forbidden text found" if not found else f"Found: {found}",
        {"forbidden": forbidden, "found": found},
    )


def _rewrite_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected.expect_rewrite
    if expected is None:
        return _skip("rewrite_loop", "No rewrite expectation")
    valid = snapshot.rewritten and bool(snapshot.retry_query)
    if valid and snapshot.retrieve_query:
        valid = snapshot.retry_query != snapshot.retrieve_query
    return _check(
        "rewrite_loop",
        valid == expected,
        f"expected={expected}, actual={valid}",
        {
            "expected": expected,
            "rewritten": snapshot.rewritten,
            "retrieve_query": snapshot.retrieve_query,
            "retry_query": snapshot.retry_query,
        },
    )


def _answer_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected.answer_required
    if expected is None:
        return _skip("answer_exists", "Answer existence is not applicable")
    actual = bool(snapshot.answer.strip())
    return _check(
        "answer_exists",
        actual == expected,
        f"expected={expected}, actual={actual}",
        {"expected": expected, "actual": actual},
    )


def _fallback_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    expected = case.expected.fallback_used
    if expected is None:
        return _skip("fallback_policy", "No fallback expectation")
    actual = snapshot.fallback_used
    return _check(
        "fallback_policy",
        actual == expected,
        f"expected={expected}, actual={actual}",
        {"expected": expected, "actual": actual},
    )


def _hit_at_k_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    gold = case.expected.relevant_doc_titles or case.expected.relevant_doc_ids
    if not gold:
        return _skip("hit_at_k", "No relevant document gold")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    matched = any(_hit_matches_gold(hit, gold) for hit in top)
    return _check(
        "hit_at_k",
        matched,
        f"top={case.expected.expected_top_k}, matched={matched}",
        {"titles": [hit.document_title for hit in top], "gold": gold},
    )


def _precision_at_k_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    gold = case.expected.relevant_doc_titles or case.expected.relevant_doc_ids
    if not gold:
        return _skip("precision_at_k", "No relevant document gold")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    if not top:
        return MetricResult(
            name="precision_at_k",
            status="fail",
            score=0,
            message="No retrieved hits",
        )
    relevant = sum(_hit_matches_gold(hit, gold) for hit in top)
    score = relevant / len(top)
    return MetricResult(
        name="precision_at_k",
        status="pass" if score == 1 else "fail",
        score=score,
        message=f"relevant={relevant}/{len(top)}",
        details={"k": case.expected.expected_top_k, "gold": gold},
    )


def _mrr_at_k_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    gold = case.expected.relevant_doc_titles or case.expected.relevant_doc_ids
    if not gold:
        return _skip("mrr_at_k", "No relevant document gold")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    rank = next(
        (index + 1 for index, hit in enumerate(top) if _hit_matches_gold(hit, gold)),
        None,
    )
    score = 1 / rank if rank else 0
    return MetricResult(
        name="mrr_at_k",
        status="pass" if rank else "fail",
        score=score,
        message=f"rank={rank}",
        details={"k": case.expected.expected_top_k},
    )


def _recall_at_k_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    gold = case.expected.relevant_doc_titles or case.expected.relevant_doc_ids
    if not gold:
        return _skip("recall_at_k", "No relevant document gold")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    score = float(any(_hit_matches_gold(hit, gold) for hit in top))
    return MetricResult(
        name="recall_at_k",
        status="pass" if score == 1 else "fail",
        score=score,
        message=f"hit={bool(score)}",
        details={"k": case.expected.expected_top_k},
    )


def _ndcg_at_k_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    gold = case.expected.relevant_doc_titles or case.expected.relevant_doc_ids
    if not gold:
        return _skip("ndcg_at_k", "No relevant document gold")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    flags = [_hit_matches_gold(hit, gold) for hit in top]
    dcg = sum(
        1 / math.log2(index + 2)
        for index, relevant in enumerate(flags)
        if relevant
    )
    ideal_count = min(len(gold), len(top))
    ideal = sum(1 / math.log2(index + 2) for index in range(ideal_count))
    score = dcg / ideal if ideal else 0
    return MetricResult(
        name="ndcg_at_k",
        status="pass" if score == 1 else "fail",
        score=score,
        message=f"score={score:.4f}",
        details={"k": case.expected.expected_top_k},
    )


def _false_hit_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    if case.expected.relevant_doc_titles or case.expected.relevant_doc_ids:
        return _skip("false_hit", "Non-empty retrieval gold")
    if case.expected.require_retrieve is not True:
        return _skip("false_hit", "No empty retrieval case")
    leaked = bool(snapshot.graded_hits)
    return _check(
        "false_hit",
        not leaked,
        "No graded hits for empty gold" if not leaked else "Graded hits leaked into answer context",
        {"graded_hit_count": len(snapshot.graded_hits)},
    )


def _min_score_metric(case: EvalCase, snapshot: RuntimeSnapshot) -> MetricResult:
    threshold = case.expected.min_score
    if threshold is None:
        return _skip("retrieval_min_score", "No minimum score")
    top = snapshot.raw_hits[:case.expected.expected_top_k]
    actual = top[0].score if top else None
    return _check(
        "retrieval_min_score",
        actual is not None and actual >= threshold,
        f"expected>={threshold}, actual={actual}",
        {"threshold": threshold, "actual": actual},
    )


def _hit_matches_gold(hit, gold: list[str]) -> bool:
    values = [hit.document_id, hit.document_title]
    return any(
        value and (value.casefold() in expected.casefold() or expected.casefold() in value.casefold())
        for value in values
        for expected in gold
    )


def _check(name: str, passed: bool, message: str, details: dict) -> MetricResult:
    return MetricResult(name=name, status="pass" if passed else "fail", score=float(passed), message=message, details=details)


def _skip(name: str, message: str) -> MetricResult:
    return MetricResult(name=name, status="skipped", score=None, message=message)
