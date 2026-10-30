"""CLI and orchestration for Agent evaluations."""

import argparse
import asyncio
import importlib
import inspect
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src.agent.chat_agent import ChatAgent
from src.agent.executor import AgentExecutor
from src.agent.router.l2_semantic import SemanticClassifier
from src.agent.router.pipeline import QueryRouter
from src.agent.tools.registry import tool_registry
from src.agent.types import (
    RouteContext,
    RouteName,
    StreamDone,
    StreamError,
    StreamToken,
)
from src.config import settings
from src.evaluation.cases import load_cases
from src.evaluation.evaluators import evaluate_case
from src.evaluation.harness import EvaluationHarness, RouteExecutor
from src.evaluation.integrations import LangfuseEvaluationPublisher
from src.evaluation.judge import LLMJudge
from src.evaluation.observer import ObservedToolRegistry
from src.evaluation.types import EvalCase, EvalCaseReport, EvalRunReport
from src.providers.registry import get_provider, resolve_model
from src.services.execution_policy import ToolExecutionContext, build_execution_policy


async def run_cases(
    cases: list[EvalCase],
    harness: EvaluationHarness,
    *,
    judge: LLMJudge | None = None,
    max_concurrency: int = 1,
    metadata: dict[str, Any] | None = None,
) -> EvalRunReport:
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be at least 1")
    semaphore = asyncio.Semaphore(max_concurrency)

    async def evaluate_one(case: EvalCase) -> EvalCaseReport:
        async with semaphore:
            snapshot = await harness.run(case)
            judge_metrics = await judge.evaluate(case, snapshot) if judge else []
            return evaluate_case(case, snapshot, extra_metrics=judge_metrics)

    reports = await asyncio.gather(*(evaluate_one(case) for case in cases))
    return EvalRunReport.from_cases(
        list(reports),
        judge_model=judge.model if judge else None,
        metadata={"max_concurrency": max_concurrency, **(metadata or {})},
    )


def filter_cases(cases: list[EvalCase], selector: str | None) -> list[EvalCase]:
    if not selector:
        return cases
    return [
        case
        for case in cases
        if case.id == selector or case.suite == selector
    ]


def load_callable(spec: str) -> Callable[..., Any]:
    module_name, separator, attribute = spec.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError("Callable must use module:function syntax")
    value = getattr(importlib.import_module(module_name), attribute)
    if not callable(value):
        raise TypeError(f"{spec} is not callable")
    return value


def build_default_executor(
    *,
    tool_observer: Callable | None = None,
) -> RouteExecutor:
    """Build a live, non-persistent executor for the standard Agent routes."""

    class ReadOnlySemanticClassifier(SemanticClassifier):
        async def _record_usage(self, sample_ids: list[str]) -> None:
            return

    async def execute(context: RouteContext):
        model_id = context.resolved_model or settings.default_model
        decision = await QueryRouter(
            model_id=model_id,
            semantic_classifier=ReadOnlySemanticClassifier(),
        ).classify(context.user_message)
        context.intent = context.intent or decision.route.value
        context.resolved_model = model_id
        resolved = resolve_model(model_id)
        context.provider_name = resolved["provider_name"]

        if decision.route == RouteName.CHAT:
            async for event in ChatAgent().execute(context):
                yield event
            return
        if decision.route == RouteName.TASK:
            context.execution_context = ToolExecutionContext(
                actor_id="evaluation-runner", conversation_id=context.conversation_id,
                run_id=context.assistant_msg_id, policy=build_execution_policy(),
            )
            registry = (
                ObservedToolRegistry(tool_registry, tool_observer)
                if tool_observer is not None
                else tool_registry
            )
            async for event in AgentExecutor(
                registry=registry,
                checkpoint=False,
            ).execute(context):
                yield event
            return
        if decision.route == RouteName.SAFETY:
            yield StreamToken(
                content="抱歉，您的消息包含不安全内容，无法处理。",
                message_id=context.assistant_msg_id,
            )
            yield StreamDone(route=RouteName.SAFETY.value, fallback_used=True)
            return
        if decision.route == RouteName.HUMAN:
            yield StreamToken(
                content="正在为您转接人工客服，请稍候...",
                message_id=context.assistant_msg_id,
            )
            yield StreamDone(route=RouteName.HUMAN.value)
            return
        yield StreamError(
            content=(
                f"Live evaluation does not support route {decision.route.value} "
                "without a database context"
            )
        )

    return execute


def build_live_harness() -> EvaluationHarness:
    """Create a live harness whose tool observer is bound to each active case."""
    holder: dict[str, Any] = {}

    async def execute(context: RouteContext):
        if "executor" not in holder:
            holder["executor"] = build_default_executor(
                tool_observer=holder["harness"].record_tool_call,
            )
        async for event in holder["executor"](context):
            yield event

    harness = EvaluationHarness(execute)
    holder["harness"] = harness
    return harness


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run AgentForge Agent evaluations")
    parser.add_argument("cases", type=Path, help="JSON file containing evaluation cases")
    parser.add_argument("--output", type=Path, help="Write JSON report to this path")
    parser.add_argument(
        "--executor",
        help="Executor factory in module:function form. Defaults to the live non-persistent executor.",
    )
    parser.add_argument("--judge-model", help="Enable the LLM Judge with this model")
    parser.add_argument("--filter", help="Run one case id or suite name")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--publish-langfuse", action="store_true")
    return parser


async def _async_main(args: argparse.Namespace) -> int:
    cases = filter_cases(load_cases(args.cases), args.filter)
    executor_value = load_callable(args.executor) if args.executor else None
    holder: dict[str, Any] = {}
    if executor_value:
        executor = executor_value()
        if inspect.isawaitable(executor):
            executor = await executor
    else:
        async def executor(context: RouteContext):
            if "live" not in holder:
                holder["live"] = build_default_executor(
                    tool_observer=holder["harness"].record_tool_call,
                )
            async for event in holder["live"](context):
                yield event

    harness = EvaluationHarness(executor)
    holder["harness"] = harness

    judge = None
    if args.judge_model:
        resolved = resolve_model(args.judge_model)
        judge = LLMJudge(get_provider(resolved["provider_name"]), model=resolved["model_id"])

    report = await run_cases(
        cases,
        harness,
        judge=judge,
        max_concurrency=args.concurrency,
        metadata={"filter": args.filter or ""},
    )
    if args.publish_langfuse:
        await LangfuseEvaluationPublisher().publish(report)
    payload = json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    return 0 if report.failed_cases == 0 and report.error_cases == 0 else 1


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(_async_main(_build_parser().parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
