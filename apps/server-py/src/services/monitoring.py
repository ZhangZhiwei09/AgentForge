"""Explicit monitoring capability and evidence provenance."""

from src.config import settings
from src.mcp.monitoring.repository import lookup_trace


def lookup_monitoring_trace(trace_id: str) -> dict:
    if settings.monitoring_mode != "mock" or settings.app_env == "production":
        return {"source": "none", "status": "unavailable", "trace": None}
    trace = lookup_trace(trace_id.strip())
    if trace is None:
        return {"source": "mock", "status": "not_found", "trace": None}
    return {
        "source": "mock", "status": "found",
        "trace": trace.model_copy(update={"traceId": trace_id.strip()}).model_dump(),
    }


def diagnosis_evidence_error(query: str) -> str | None:
    from src.agent.diagnosis.nodes import extract_entities_from_query

    if settings.monitoring_mode != "mock" or settings.app_env == "production":
        return "真实监控数据源尚未接入，无法验证故障根因。请提供授权日志或联系人工支持。"
    trace_id = extract_entities_from_query(query).get("traceId")
    if trace_id and lookup_monitoring_trace(trace_id)["status"] != "found":
        return "未找到此 traceId 的监控证据，无法验证故障根因。请核对链路编号或提供日志。"
    return None
