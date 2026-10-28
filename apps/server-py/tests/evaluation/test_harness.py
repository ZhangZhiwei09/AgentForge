from src.agent.types import (
    RouteContext,
    StreamCitations,
    StreamDone,
    StreamMeta,
    StreamToken,
    StreamTraceStep,
)
from src.evaluation.harness import EvaluationHarness
from src.evaluation.types import EvalCase, ToolCallSnapshot


async def _fake_executor(context: RouteContext):
    assert context.conversation_id.startswith("test-")
    yield StreamMeta(route="TASK", intent="task")
    yield StreamTraceStep(
        step={
            "kind": "tool",
            "tool_call": {
                "name": "search_knowledge_base",
                "arguments": {"query": "timeout"},
                "result": {"status": "success"},
                "status": "success",
            },
        }
    )
    yield StreamToken(content="第一段")
    yield StreamToken(content="第二段")
    yield StreamCitations(items=[{"id": "doc-1"}])
    yield StreamDone(route="TASK", fallback_used=False)


async def test_harness_captures_stream_and_observed_tools():
    observed: list[ToolCallSnapshot] = []
    harness = EvaluationHarness(
        _fake_executor,
        tool_observer=observed.append,
        conversation_prefix="test",
    )

    snapshot = await harness.run(EvalCase(id="case-1", question="查询"))

    assert snapshot.route == "TASK"
    assert snapshot.answer == "第一段第二段"
    assert snapshot.citations == [{"id": "doc-1"}]
    assert snapshot.tools[0].name == "search_knowledge_base"
    assert observed[0].arguments == {"query": "timeout"}
    assert snapshot.status == "completed"
    assert snapshot.latency_ms >= 0


async def test_harness_records_executor_side_tool_observer():
    holder: dict[str, EvaluationHarness] = {}

    async def executor(_context: RouteContext):
        holder["harness"].record_tool_call(
            ToolCallSnapshot(name="lookup", arguments={"id": "1"}, source="observer")
        )
        yield StreamToken(content="ok")

    harness = EvaluationHarness(executor)
    holder["harness"] = harness
    snapshot = await harness.run(EvalCase(id="case-2", question="查询"))

    assert [tool.name for tool in snapshot.tools] == ["lookup"]


async def test_harness_turns_executor_exception_into_error_snapshot():
    async def executor(_context: RouteContext):
        raise RuntimeError("boom")
        yield  # pragma: no cover

    snapshot = await EvaluationHarness(executor).run(
        EvalCase(id="case-3", question="失败")
    )

    assert snapshot.status == "error"
    assert "RuntimeError: boom" in snapshot.errors[0]


async def test_harness_normalizes_knowledge_tool_results_into_ir_hits():
    async def executor(_context: RouteContext):
        holder["harness"].record_tool_call(
            ToolCallSnapshot(
                name="search_knowledge_base",
                arguments={"query": "差旅"},
                result={
                    "status": "success",
                    "output": '{"results":[{"docId":"doc-1","docTitle":"差旅制度","score":0.91,"content":"加签规则"}]}',
                },
            )
        )
        yield StreamDone(route="TASK")

    holder: dict[str, EvaluationHarness] = {}
    harness = EvaluationHarness(executor)
    holder["harness"] = harness

    snapshot = await harness.run(EvalCase(id="ir", question="差旅"))

    assert snapshot.retrieve_count == 1
    assert snapshot.retrieve_query == "差旅"
    assert snapshot.raw_hits[0].document_title == "差旅制度"
    assert snapshot.raw_hits[0].score == 0.91
