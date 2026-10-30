"""Usage normalization and conservative task settlement, independent of providers."""

import copy
import json

from src.rag.splitter import estimate_tokens

RATE_TABLE_VERSION = "legacy-estimate-v1"


def normalize_usage(value: dict | None, *, langchain: bool = False) -> dict[str, int] | None:
    """Missing/invalid usage is unknown, while explicit zero is valid reported usage."""
    if not isinstance(value, dict):
        return None
    prompt = value.get("input_tokens" if langchain else "prompt_tokens")
    completion = value.get("output_tokens" if langchain else "completion_tokens")
    if any(type(count) is not int or count < 0 for count in (prompt, completion)):
        return None
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def estimate_usage(messages: list[dict], tools: list[dict] | None, output: str, calls: list[dict]) -> dict[str, int]:
    prompt = max(1, estimate_tokens(json.dumps({"messages": messages, "tools": tools or []}, ensure_ascii=False)))
    completion = max(1, estimate_tokens(output + json.dumps(calls, ensure_ascii=False))) if output or calls else 0
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def add_usage(total: dict, usage: dict | None, source: str = "reported") -> dict:
    result = dict(total)
    normalized = normalize_usage(usage)
    if normalized is None:
        return result
    for key, count in normalized.items():
        result[key] = result.get(key, 0) + count
    old_source = result.get("source")
    result["source"] = source if old_source is None or old_source == source else "mixed"
    return result


def task_usage_summary(runtime: dict) -> dict:
    total = {}
    for source, usage in runtime.get("usage_totals", {}).items():
        total = add_usage(total, usage, source)
    unclassified = max(0, runtime.get("tokens_used", 0) - total.get("total_tokens", 0))
    if unclassified:
        total["source"] = "mixed" if total else "unavailable"
    return {
        **total, "total_tokens": runtime.get("tokens_used", 0),
        "unclassified_tokens": unclassified,
        "estimated_cost_cents": runtime.get("cost_cents_used", 0), "cost_source": "estimate",
        "uncertain": runtime.get("usage_uncertain", False), "scope": "task",
    }


def settle_task_usage(runtime: dict, usage: dict | None, source: str, *, uncertain: bool = False) -> bool:
    """Consume a persisted reservation once; interruption keeps its conservative estimate."""
    pending = runtime.get("pending_model_usage")
    if not pending:
        return False
    normalized = normalize_usage(usage)
    if normalized is None or uncertain:
        normalized = normalize_usage(pending)
        source = "reserved"
        uncertain = True
    record = {
        **pending, **normalized, "source": source,
        "status": "uncertain" if uncertain else "completed",
    }
    prompt_rate, completion_rate = record["rates"]
    cost = (record["prompt_tokens"] * prompt_rate + record["completion_tokens"] * completion_rate) / 1000
    record["estimated_cost_cents"] = cost
    runtime["tokens_used"] = runtime.get("tokens_used", 0) + record["total_tokens"]
    runtime["cost_cents_used"] = runtime.get("cost_cents_used", 0) + cost
    buckets = copy.deepcopy(runtime.get("usage_totals", {}))
    buckets[source] = add_usage(buckets.get(source, {}), normalized, source)
    runtime["usage_totals"] = buckets
    runtime["model_usage"] = [*runtime.get("model_usage", []), record]
    runtime["usage_uncertain"] = runtime.get("usage_uncertain", False) or uncertain
    runtime["cost_source"] = "estimate"
    runtime["pending_model_usage"] = None
    return True


def reserve_task_usage(runtime: dict, model: str, prompt_tokens: int, completion_tokens: int) -> None:
    from src.agent.task_guard import model_rate_source, model_rates

    if runtime.get("pending_model_usage"):
        raise RuntimeError("Previous model call has an unsettled usage reservation")
    runtime["pending_model_usage"] = {
        "call_id": f"{runtime.get('iteration_count', 0) + 1}-{len(runtime.get('model_usage', [])) + 1}",
        "model": model, "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens, "rates": list(model_rates(model)),
        "rate_version": RATE_TABLE_VERSION, "cost_source": "estimate",
        "rate_source": model_rate_source(model),
    }
