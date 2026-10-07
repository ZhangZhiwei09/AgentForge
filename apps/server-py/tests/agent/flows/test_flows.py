"""Deterministic configuration flow tests; no model, tools or database required."""

import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from langgraph.checkpoint.memory import InMemorySaver

from src.agent.flows.runtime import agent_order, parse_output, run_flow
from src.agent.flows.schema import FlowEdge, FlowNode, ValueRef, validate_definition
from src.agent.flows.service import redact
from src.agent.flows.templates import diagnosis_template
from src.agent.executor import AgentExecutor
from src.agent.tools.registry import ToolRegistry, tool_registry
from src.agent.types import RouteContext, StreamError, StreamToken
from src.api.v1.agent_flows import admin, check_revision


@pytest.fixture
def definition():
    return diagnosis_template()


def errors(definition):
    return validate_definition(definition, set(tool_registry.list_names()))


def outputs(escalate=True, missing=None):
    return {
        "frontend": {
            "conclusion": "前端观察", "evidence": [{"detail": "摄像头权限已授权"}],
            "need_escalation": escalate, "context_for_backend": {"traceId": "trace-1"},
            "escalation_reason": "unknown" if escalate else None,
        },
        "backend": {"conclusion": "后端超时", "evidence": [{"detail": "日志显示算法超时"}]},
        "leader": {
            "frontend_score": 4, "backend_score": 8, "frontend_breakdown": {},
            "backend_breakdown": {}, "reasoning": "后端证据充分", "synthesis": "后端超时",
            "missing_fields": missing or [], "message": "请补充具体时间",
        },
    }


async def collect(definition, data=None, task="摄像头问题", **kwargs):
    calls = []
    data = data or outputs()

    async def runner(node, inputs):
        calls.append((node.id, inputs))
        return json.dumps(data[node.id], ensure_ascii=False)

    events = [event async for event in run_flow(
        definition, RouteContext(user_message=task, conversation_id="test-conversation"),
        ToolRegistry(), "test-run", asyncio.Event(), runner=runner, **kwargs,
    )]
    return events, calls


def test_template_is_valid(definition):
    assert errors(definition) == []
    assert [node.id for node in agent_order(definition)] == ["frontend", "backend", "leader"]


def test_missing_node_and_duplicate_edges_rejected(definition):
    definition.edges.append(FlowEdge(id="start_frontend", source="missing", target="frontend"))
    assert len(errors(definition)) >= 2


def test_cycle_rejected(definition):
    next(edge for edge in definition.edges if edge.source == "leader").target = "backend"
    assert any("循环" in error["message"] for error in errors(definition))


def test_cannot_bypass_backend(definition):
    next(edge for edge in definition.edges if edge.source == "escalate" and edge.branch == "true").target = "leader"
    assert errors(definition)


def test_backend_cannot_read_frontend_judgement(definition):
    backend = next(node for node in definition.nodes if node.id == "backend")
    backend.inputs["facts"].path = []
    assert any("事实" in error["message"] for error in errors(definition))


def test_future_reference_rejected(definition):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    frontend.inputs["future"] = ValueRef(source="node", node_id="leader", path=["synthesis"])
    assert errors(definition)


def test_unknown_tool_rejected(definition):
    definition.nodes[1].execution.tools = ["shell_arbitrary"]
    assert errors(definition)


def test_execution_budgets_rejected(definition):
    definition.limits.max_total_iterations = 4
    assert any("预算" in error["message"] for error in errors(definition))
    definition.limits.timeout_ms = 1000
    assert any("超时" in error["message"] for error in errors(definition))


def test_missing_contract_rejected(definition):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    frontend.outputs = [field for field in frontend.outputs if field.name != "need_escalation"]
    assert errors(definition)


def test_control_field_must_be_boolean(definition):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    output = outputs()["frontend"]
    output["need_escalation"] = "false"
    with pytest.raises(ValueError, match="输出类型"):
        parse_output(frontend, json.dumps(output))


@pytest.mark.parametrize("number", ["NaN", "Infinity", "1e999"])
def test_nonfinite_json_output_rejected(definition, number):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    text = (
        '{"conclusion":"test","evidence":[],"need_escalation":false,'
        '"context_for_backend":{"number":' + number + "}}"
    )
    with pytest.raises(ValueError):
        parse_output(frontend, text)


def test_condition_comparison_is_typed(definition):
    gate = next(node for node in definition.nodes if node.id == "escalate")
    gate.condition.value = "true"
    assert errors(definition)


def test_optional_output_reference_rejected(definition):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    backend = next(node for node in definition.nodes if node.id == "backend")
    backend.inputs["optional"] = ValueRef(source="node", node_id=frontend.id, path=["escalation_reason"])
    assert any("可选" in error["message"] for error in errors(definition))


def test_task_condition_comparison_is_typed(definition):
    condition = FlowNode.model_validate({
        "id": "extra_condition", "type": "condition", "name": "问题条件",
        "condition": {"reference": {"source": "task"}, "value": True},
    })
    definition.nodes.append(condition)
    next(edge for edge in definition.edges if edge.source == "backend").target = condition.id
    definition.edges.extend([
        FlowEdge(id="extra_true", source=condition.id, target="leader", branch="true"),
        FlowEdge(id="extra_false", source=condition.id, target="leader", branch="false"),
    ])
    assert any("字符串" in error["message"] for error in errors(definition))
    condition.condition.value = "特定问题"
    assert not errors(definition)


@pytest.mark.asyncio
async def test_fast_path_skips_backend_and_leader(definition):
    events, calls = await collect(definition, outputs(escalate=False))
    assert [call[0] for call in calls] == ["frontend"]
    assert events[-1]["type"] == "flow_completed"
    assert events[-1]["output"]["resolution"] == "frontend_only"
    assert {"backend", "leader"}.issubset(events[-1]["skippedNodes"])
    assert any(event["type"] == "node_completed" for event in events)


@pytest.mark.asyncio
async def test_escalated_path_isolated_inputs(definition):
    events, calls = await collect(definition)
    assert [call[0] for call in calls] == ["frontend", "backend", "leader"]
    assert calls[1][1] == {"question": "摄像头问题", "facts": {"traceId": "trace-1"}}
    assert events[-1]["output"]["resolution"] == "adopt_backend"


@pytest.mark.asyncio
async def test_rule_override_forces_backend(definition):
    events, calls = await collect(definition, outputs(escalate=False), task="ACE_TIMEOUT")
    assert [call[0] for call in calls] == ["frontend", "backend", "leader"]
    assert events[-1]["output"]["escalated"] is True


@pytest.mark.asyncio
async def test_new_expert_runs_without_new_code(definition):
    expert = FlowNode.model_validate({
        "id": "database_expert", "type": "agent", "name": "数据库专家",
        "role": {"name": "数据库专家", "systemPrompt": "你是数据库专家"},
        "task": "验证数据库日志", "inputs": {"facts": {"source": "node", "nodeId": "frontend", "path": ["context_for_backend"]}},
        "outputs": [{"name": "conclusion", "type": "string"}],
    })
    definition.nodes.append(expert)
    next(edge for edge in definition.edges if edge.source == "backend").target = expert.id
    definition.edges.append(FlowEdge(id="expert_leader", source=expert.id, target="leader"))
    leader = next(node for node in definition.nodes if node.id == "leader")
    leader.inputs["database"] = ValueRef(source="node", node_id=expert.id)
    assert not errors(definition)
    data = outputs()
    data[expert.id] = {"conclusion": "数据库正常"}
    events, calls = await collect(definition, data)
    assert [call[0] for call in calls] == ["frontend", "backend", "database_expert", "leader"]
    assert calls[-1][1]["database"] == data[expert.id]
    assert events[-1]["type"] == "flow_completed"


@pytest.mark.asyncio
async def test_bad_json_stops_no_fallback(definition):
    async def runner(node, inputs):
        return "not-json"
    events = [event async for event in run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "bad-json", asyncio.Event(), runner=runner,
    )]
    assert [event["nodeId"] for event in events if event["type"] == "node_started"] == ["start", "frontend"]
    assert events[-1]["type"] == "flow_failed"


@pytest.mark.asyncio
async def test_configured_executor_receives_limits_and_no_tools(definition, monkeypatch):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    frontend.execution.tools = []
    frontend.execution.max_iterations = 2
    seen = []

    async def execute(self, context, system_prompt=None):
        seen.append((self._max_iterations, self._registry.list_names(), context.user_message))
        assert "对象列表" in system_prompt
        yield StreamToken(content=json.dumps(outputs(escalate=False)["frontend"]))

    monkeypatch.setattr(AgentExecutor, "execute", execute)
    events = [event async for event in run_flow(
        definition, RouteContext(user_message="摄像头问题"), ToolRegistry(),
        "executor-config", asyncio.Event(),
    )]
    assert seen == [(2, [], '{"question": "摄像头问题"}')]
    assert events[-1]["type"] == "flow_completed"


@pytest.mark.asyncio
async def test_executor_error_is_not_success(definition, monkeypatch):
    async def execute(self, context, system_prompt=None):
        yield StreamError(content="model-unavailable")

    monkeypatch.setattr(AgentExecutor, "execute", execute)
    events = [event async for event in run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "executor-error", asyncio.Event(),
    )]
    assert events[-1]["type"] == "flow_failed"
    assert events[-1]["error"] == "model-unavailable"
    assert not any(event["type"] == "node_started" and event["nodeId"] == "backend" for event in events)


@pytest.mark.asyncio
async def test_node_timeout_stops_following_agents(definition):
    frontend = next(node for node in definition.nodes if node.id == "frontend")
    frontend.execution.timeout_ms = 1000

    async def runner(node, inputs):
        await asyncio.sleep(60)

    events = [event async for event in run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "node-timeout", asyncio.Event(), runner=runner,
    )]
    assert any(event["type"] == "node_failed" and event["nodeId"] == "frontend" for event in events)
    assert events[-1]["type"] == "flow_failed"


@pytest.mark.asyncio
async def test_cancellation_interrupts_inflight_node(definition):
    cancel = asyncio.Event()
    stopped = asyncio.Event()

    async def runner(node, inputs):
        cancel.set()
        try:
            await asyncio.sleep(60)
        finally:
            stopped.set()
    events = [event async for event in run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "cancel", cancel, runner=runner,
    )]
    assert events[-1]["type"] == "flow_cancelled"
    assert stopped.is_set()


@pytest.mark.asyncio
async def test_closing_stream_stops_inflight_node(definition):
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def runner(node, inputs):
        started.set()
        try:
            await asyncio.sleep(60)
        finally:
            stopped.set()

    stream = run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "closed-stream", asyncio.Event(), runner=runner,
    )
    async for event in stream:
        if event["type"] == "node_started" and event["nodeId"] == "frontend":
            await started.wait()
            await stream.aclose()
            break
    assert stopped.is_set()


@pytest.mark.asyncio
async def test_total_timeout(definition):
    async def runner(node, inputs):
        await asyncio.sleep(60)
    events = [event async for event in run_flow(
        definition, RouteContext(user_message="test"), ToolRegistry(),
        "timeout", asyncio.Event(), runner=runner, timeout_ms=15,
    )]
    assert events[-1]["type"] == "flow_failed"


@pytest.mark.asyncio
async def test_hitl_resume_does_not_rerun_agents(definition):
    saver = InMemorySaver()
    events, calls = await collect(definition, outputs(missing=["时间"]), checkpointer=saver, hitl=True)
    assert events[-1]["type"] == "flow_waiting_input"
    assert len(calls) == 3
    resumed, resumed_calls = await collect(definition, checkpointer=saver, hitl=True, resume="10:30")
    assert resumed[-1]["type"] == "flow_completed"
    assert resumed_calls == []
    assert resumed[-1]["output"]["user_supplement"] == "10:30"


def test_empty_registry_really_has_no_tools():
    filtered = tool_registry.filter([])
    assert filtered.get_definitions() == []
    assert filtered.list_names() == []


def test_redaction():
    assert redact({"api_key": "secret", "facts": {"Authorization": "Bearer abc"}}) == {
        "api_key": "[REDACTED]", "facts": {"Authorization": "[REDACTED]"},
    }


@pytest.mark.asyncio
async def test_admin_required():
    user = AsyncMock()
    user.role = "user"
    with pytest.raises(HTTPException) as error:
        await admin(user)
    assert error.value.status_code == 403


def test_revision_conflict():
    flow = AsyncMock()
    flow.draft_revision = 2
    with pytest.raises(HTTPException) as error:
        check_revision(flow, 1)
    assert error.value.status_code == 409
