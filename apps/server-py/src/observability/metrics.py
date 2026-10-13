"""Prometheus registry for the Python HTTP and shared agent runtime."""

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Histogram,
    ProcessCollector,
    generate_latest,
)

registry = CollectorRegistry()
ProcessCollector(namespace="agentforge", registry=registry)
http_requests = Counter(
    "http_requests_total", "HTTP requests", ["app", "method", "path", "status"], registry=registry,
)
http_duration = Histogram(
    "http_request_duration_ms", "HTTP request latency in milliseconds", ["app", "method", "path"],
    buckets=(5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000), registry=registry,
)
tool_calls = Counter("tool_calls_total", "Tool executions", ["app", "tool_name", "status"], registry=registry)
tool_duration = Histogram(
    "tool_execution_duration_ms", "Tool duration in milliseconds", ["app", "tool_name"],
    buckets=(10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000), registry=registry,
)
entry_decisions = Counter(
    "agent_entry_decisions_total", "Enterprise entry decisions", ["app", "action", "source"], registry=registry,
)
route_classification = Counter(
    "agent_route_classification_total", "Runtime routes", ["app", "route", "source"], registry=registry,
)
citation_coverage = Histogram(
    "agent_citation_coverage", "Citation coverage", ["app", "level"],
    buckets=(0, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1), registry=registry,
)


def record_http(method: str, path: str, status: int, elapsed_ms: float):
    http_requests.labels("agentforge", method, path, str(status)).inc()
    http_duration.labels("agentforge", method, path).observe(elapsed_ms)


def render_metrics() -> bytes:
    return generate_latest(registry)
