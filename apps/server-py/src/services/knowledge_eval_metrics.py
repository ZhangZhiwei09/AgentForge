"""Regression assertions and IR metrics, preserving existing public semantics."""

import math
from statistics import mean


def string_array(value) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def lower(value: str) -> str:
    return value.strip().lower()


def relevant(result: dict, expectation: dict | None) -> bool:
    if expectation is None:
        return False
    return (
        lower(result.get("docId", "")) in {lower(item) for item in expectation["expectedDocIds"]}
        or lower(result.get("docTitle", "")) in {lower(item) for item in expectation["expectedDocTitles"]}
    )


def prompt_snapshot(query: str, results: list[dict]) -> str:
    context = "\n\n".join(
        f"[{item['rank']}] {item['docTitle']} #{item['chunkIndex']} score={item['score']:.4f}\n{item['content']}"
        for item in results
    )
    return f"请根据检索到的知识上下文回答用户问题。\n\n问题：{query}\n\n检索上下文：\n{context or '（无上下文）'}"


def evaluate_case(case: dict, results: list[dict], prompt: str) -> dict:
    top = results[:case["expectedTopK"]]
    reasons = []
    expected = bool(case["expectedDocIds"] or case["expectedDocTitles"])
    matched = next((item for item in top if relevant(item, case)), None) if expected else (top[0] if top else None)
    if expected and matched is None:
        reasons.append(f"Expected document was not retrieved in top {case['expectedTopK']}")
    combined = "\n".join(item["content"] for item in top).lower()
    for text in case["requiredText"]:
        if lower(text) not in combined:
            reasons.append(f"Required text missing: {text}")
    for text in case["forbiddenText"]:
        if lower(text) in combined:
            reasons.append(f"Forbidden text appeared: {text}")
    for text in case["promptRequiredContextText"]:
        if lower(text) not in prompt.lower():
            reasons.append(f"Prompt context missing: {text}")
    if case["minScore"] is not None:
        scored = matched or (top[0] if top else None)
        if scored is None or scored["score"] < case["minScore"]:
            reasons.append(f"Score below threshold: expected >= {case['minScore']}")
    return {
        "passed": not reasons, "rank": matched["rank"] if matched else None,
        "score": matched["score"] if matched else None, "matchedDocId": matched["docId"] if matched else None,
        "failureReason": "; ".join(reasons) if reasons else None,
    }


def reciprocal_rank(rank: int | None) -> float:
    return 1 / rank if rank is not None and rank > 0 else 0


def ndcg_at_k(flags: list[bool]) -> float:
    dcg = sum(1 / math.log2(index + 2) for index, flag in enumerate(flags) if flag)
    ideal = sum(1 / math.log2(index + 2) for index in range(sum(flags)))
    return dcg / ideal if ideal else 0


def query_metric(item: dict, expectation: dict | None) -> dict:
    top_k = expectation["expectedTopK"] if expectation else 5
    snapshot = item["resultsSnapshot"]
    flags = [relevant(result, expectation) for result in snapshot[:top_k]]
    return {
        **{key: item[key] for key in (
            "caseId", "caseName", "query", "passed", "rank", "matchedDocId", "failureReason", "elapsedMs",
            "resultsSnapshot",
        )},
        "reciprocalRank": reciprocal_rank(item["rank"]), "relevant": any(flags),
        "precisionAtK": sum(flags) / top_k if top_k else 0, "ndcgAtK": ndcg_at_k(flags),
        "relevantRanks": [index + 1 for index, result in enumerate(snapshot) if relevant(result, expectation)],
    }


def average(values: list):
    return mean(values) if values else None


def run_metrics(run: dict, cases: dict) -> dict:
    items = run["items"]
    metrics = [query_metric(item, cases.get(item["caseId"])) for item in items]
    return {
        "runId": run["id"], "testSetId": run["testSetId"], "createdAt": run["createdAt"],
        "totalCases": run["totalCases"], "hitRate": sum(item["passed"] for item in items) / len(items) if items else 0,
        "mrr": average([item["reciprocalRank"] for item in metrics]) or 0,
        "recallAtK": average([int(item["relevant"]) for item in metrics]) or 0,
        "precisionAtK": average([item["precisionAtK"] for item in metrics]) or 0,
        "ndcgAtK": average([item["ndcgAtK"] for item in metrics]) or 0,
        "averageRank": average([item["rank"] for item in items if item["rank"] is not None]),
        "averageElapsedMs": average([item["elapsedMs"] for item in items]),
    }


def metrics_summary(trend: list[dict]) -> dict:
    if not trend:
        return {"runCount": 0, "totalCases": 0, "latest": None, "average": None}
    averaged = {}
    for key in ("hitRate", "mrr", "recallAtK", "precisionAtK", "ndcgAtK", "averageRank", "averageElapsedMs"):
        averaged[key] = average([run[key] for run in trend if run[key] is not None])
    return {
        "runCount": len(trend), "totalCases": sum(run["totalCases"] for run in trend),
        "latest": trend[-1], "average": averaged,
    }
