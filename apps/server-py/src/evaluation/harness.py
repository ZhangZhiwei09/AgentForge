"""Execution harness that captures Agent stream facts without persistence."""

import inspect
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar
from typing import Any

from src.agent.types import (
    RouteContext,
    RouteStreamEvent,
    StreamCitations,
    StreamClear,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
    StreamTraceStep,
)
from src.evaluation.types import (
    EvalCase,
    RetrievalHitSnapshot,
    RuntimeSnapshot,
    ToolCallSnapshot,
)

RouteExecutor = Callable[[RouteContext], AsyncIterator[RouteStreamEvent]]
ToolObserver = Callable[[ToolCallSnapshot], None]


class EvaluationHarness:
    """Run an injected Agent stream with an isolated conversation id.

    The executor injection keeps unit tests offline while allowing a caller to
    pass the real router/Agent execution chain in production experiments.
    """

    def __init__(
        self,
        executor: RouteExecutor,
        *,
        tool_observer: ToolObserver | None = None,
        conversation_prefix: str = "eval",
    ) -> None:
        self._executor = executor
        self._tool_observer = tool_observer
        self._conversation_prefix = conversation_prefix
        self._active_snapshot: ContextVar[RuntimeSnapshot | None] = ContextVar(
            "evaluation_snapshot",
            default=None,
        )

    async def run(self, case: EvalCase) -> RuntimeSnapshot:
        conversation_id = f"{self._conversation_prefix}-{case.id}-{uuid.uuid4().hex[:12]}"
        context = RouteContext(
            conversation_id=conversation_id,
            user_message=case.question,
            resolved_model=case.model or "",
            assistant_msg_id=str(uuid.uuid4()),
            intent=case.intent,
        )

        snapshot = RuntimeSnapshot(
            case_id=case.id,
            question=case.question,
            intent=case.intent,
            metadata={"conversation_id": conversation_id, **case.metadata},
        )
        token = self._active_snapshot.set(snapshot)
        started = time.perf_counter()
        try:
            events = self._executor(context)
            if inspect.isawaitable(events):
                events = await events
            async for event in events:
                self._capture_event(snapshot, event)
        except Exception as exc:  # noqa: BLE001 - report execution failure as data
            snapshot.errors.append(f"{type(exc).__name__}: {exc}")
            snapshot.status = "error"
        finally:
            snapshot.latency_ms = round((time.perf_counter() - started) * 1000, 2)
            self._active_snapshot.reset(token)

        if snapshot.errors:
            snapshot.status = "error"
        return snapshot

    def _capture_event(self, snapshot: RuntimeSnapshot, event: RouteStreamEvent) -> None:
        if isinstance(event, StreamMeta):
            snapshot.route = event.route or snapshot.route
            snapshot.intent = event.intent or snapshot.intent
        elif isinstance(event, StreamToken):
            snapshot.answer += event.content
        elif isinstance(event, StreamClear):
            snapshot.answer = ""
        elif isinstance(event, StreamDone):
            snapshot.route = event.route or snapshot.route
            snapshot.fallback_used = event.fallback_used
        elif isinstance(event, StreamError):
            snapshot.errors.append(event.content or "Agent stream error")
        elif isinstance(event, StreamCitations):
            snapshot.citations.extend(event.items)
        elif isinstance(event, StreamTraceStep):
            snapshot.trace_steps.append(event.step)
            _capture_trace_metadata(snapshot, event.step)
            for tool in _tools_from_trace(event.step):
                self._record(snapshot, tool)

    def _record(self, snapshot: RuntimeSnapshot, tool: ToolCallSnapshot) -> None:
        snapshot.tools.append(tool)
        _capture_tool_result(snapshot, tool)
        if self._tool_observer is not None:
            self._tool_observer(tool.model_copy(deep=True))

    def record_tool_call(self, tool: ToolCallSnapshot) -> None:
        """Record a tool from an executor-side observer callback."""
        snapshot = self._active_snapshot.get()
        if snapshot is not None:
            self._record(snapshot, tool.model_copy(deep=True))


def _tools_from_trace(step: dict[str, Any]) -> list[ToolCallSnapshot]:
    """Extract explicit tool-shaped trace payloads without guessing from text."""
    candidates: list[dict[str, Any]] = []
    nested = step.get("tool_call") or step.get("toolCall") or step.get("tool")
    if isinstance(nested, dict):
        candidates.append(nested)
    listed = step.get("tool_calls") or step.get("toolCalls")
    if isinstance(listed, list):
        candidates.extend(item for item in listed if isinstance(item, dict))

    kind = str(step.get("kind", "")).lower()
    if not candidates and kind in {"tool", "tool_call"}:
        candidates.append(step)

    tools: list[ToolCallSnapshot] = []
    for item in candidates:
        name = item.get("name") or item.get("tool_name") or item.get("toolName") or item.get("label")
        if not name:
            continue
        arguments = item.get("arguments", item.get("args", item.get("input", {})))
        if not isinstance(arguments, dict):
            arguments = {}
        tools.append(
            ToolCallSnapshot(
                name=str(name),
                arguments=arguments,
                result=item.get("result", item.get("output")),
                status=item.get("status"),
                duration_ms=item.get("duration_ms", item.get("durationMs")),
            )
        )
    return tools


def _capture_trace_metadata(snapshot: RuntimeSnapshot, step: dict[str, Any]) -> None:
    kind = str(step.get("kind", "")).lower()
    label = str(step.get("label", ""))
    if kind == "retrieval":
        if step.get("status") == "done":
            snapshot.retrieve_count += 1
        snapshot.retrieve_query = step.get("query") or snapshot.retrieve_query
    if kind in {"graph", "graph_query"}:
        snapshot.graph_used = True
        query = step.get("query") or step.get("label")
        if query:
            snapshot.graph_queries.append(str(query))
    if kind in {"web", "web_search"} or "web" in label.lower():
        snapshot.web_used = True
    if step.get("rewritten") is True or kind in {"rewrite", "retry_query"}:
        snapshot.rewritten = True
        snapshot.retry_query = step.get("retry_query") or step.get("query") or snapshot.retry_query


def _capture_tool_result(snapshot: RuntimeSnapshot, tool: ToolCallSnapshot) -> None:
    name = tool.name.lower()
    if name == "search_knowledge_base":
        snapshot.retrieve_count += 1
        query = tool.arguments.get("query")
        if isinstance(query, str):
            if snapshot.retrieve_query is None:
                snapshot.retrieve_query = query
            elif query != snapshot.retrieve_query:
                snapshot.rewritten = True
                snapshot.retry_query = query
        payload = tool.result
        if isinstance(payload, dict) and "output" in payload:
            payload = payload["output"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = None
        if not isinstance(payload, dict):
            return
        results = payload.get("results")
        if not isinstance(results, list):
            return
        hits = [_hit_from_result(item) for item in results if isinstance(item, dict)]
        snapshot.raw_hits.extend(hits)
        snapshot.graded_hits.extend(hits)
    elif name in {"web_search", "web_fetch"}:
        snapshot.web_used = True
        result = tool.result
        if isinstance(result, dict):
            result = result.get("output", result)
        snapshot.web_snippet = str(result or "")[:12000]
    elif "graph" in name:
        snapshot.graph_used = True


def _hit_from_result(result: dict[str, Any]) -> RetrievalHitSnapshot:
    return RetrievalHitSnapshot(
        document_id=str(result.get("docId", result.get("document_id", ""))),
        document_title=str(result.get("docTitle", result.get("document_title", ""))),
        heading=result.get("heading"),
        score=float(result.get("score", 0) or 0),
        excerpt=str(result.get("content", result.get("excerpt", "")) or "")[:2000],
    )
