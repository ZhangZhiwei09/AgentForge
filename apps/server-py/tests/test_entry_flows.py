import asyncio
import copy

import pytest
from pydantic import ValidationError

from src.agent.entry_flows.privacy import redact_entry_text, redact_entry_value
from src.agent.entry_flows.runtime import execute_entry_flow
from src.agent.entry_flows.schema import (
    EntryDefinition,
    EntryFlowError,
    parse_entry_definition,
    validate_entry_definition,
)
from src.agent.entry_flows.templates import default_entry_template, empty_entry_template


def branch_flow(operator="contains_any"):
    return {
        "schemaVersion": 1,
        "nodes": [
            {"id": "start", "type": "start", "name": "start", "position": {"x": 0, "y": 0}},
            {"id": "condition", "type": "condition", "name": "condition", "position": {"x": 200, "y": 0},
             "condition": {"operator": operator, "words": ["hello", "world"], "excludeAny": ["deny"],
                           "ignoreCase": True, "stripTrailingPunctuation": operator == "equals_any"}},
            {"id": "reply", "type": "reply", "name": "reply", "position": {"x": 400, "y": 0},
             "answer": "configured answer", "suggestions": ["next"]},
            {"id": "continue", "type": "continue", "name": "continue", "position": {"x": 400, "y": 200}},
        ],
        "edges": [
            {"id": "first", "source": "start", "target": "condition", "branch": None},
            {"id": "yes", "source": "condition", "target": "reply", "branch": "true"},
            {"id": "no", "source": "condition", "target": "continue", "branch": "false"},
        ],
    }


@pytest.mark.parametrize("operator,message,action", [
    ("contains_any", "  HELLO ", "reply"), ("contains_any", "world only", "reply"),
    ("contains_any", "HELLO deny", "continue"), ("contains_any", "unmatched", "continue"),
    ("contains_all", "hello world", "reply"), ("contains_all", "hello", "continue"),
    ("equals_any", " Hello！。 ", "reply"), ("equals_any", "hello there", "continue"),
    ("equals_any", "hello?", "continue"), ("equals_any", "he!llo", "continue"),
])
def test_keyword_semantics(operator, message, action):
    execution = execute_entry_flow(branch_flow(operator), message)
    assert execution.result["action"] == action
    assert [record["nodeId"] for record in execution.records] == ["start", "condition", action]
    assert execution.records[1]["matched"] == (action == "reply")


def test_execution_is_immutable_and_independent_of_canvas_order():
    flow = default_entry_template()
    before = copy.deepcopy(flow)
    execution = execute_entry_flow(flow, "转人工失败")
    assert flow == before
    flow["nodes"].reverse()
    flow["edges"].reverse()
    assert execute_entry_flow(flow, "转人工失败").result == execution.result == {"action": "route", "target": "HUMAN"}


@pytest.mark.parametrize("target", ["CHAT", "TASK", "HUMAN", "DIAGNOSIS"])
def test_route_result_does_not_execute_an_agent(target):
    flow = branch_flow()
    flow["nodes"][2] = {"id": "reply", "type": "route", "name": "route", "position": {"x": 0, "y": 0}, "target": target}
    assert execute_entry_flow(flow, "hello").result == {"action": "route", "target": target}


@pytest.mark.parametrize("message,action", [
    ("你好", "reply"), ("谢谢", "reply"), ("再见", "reply"), ("HI！", "reply"),
    ("转人工", "route"), ("traceId: abc 报错", "route"), ("普通业务咨询", "continue"),
])
def test_default_template(message, action):
    assert execute_entry_flow(default_entry_template(), message).result["action"] == action


@pytest.mark.parametrize("message", ["", " ", "x" * 16001])
def test_bounded_messages(message):
    with pytest.raises(ValueError, match="消息"):
        execute_entry_flow(branch_flow(), message)


def test_cancellation_checked_before_graph_execution():
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        execute_entry_flow(branch_flow(), "hello", cancel)


@pytest.mark.parametrize("mutation", [
    lambda flow: flow["nodes"].append(copy.deepcopy(flow["nodes"][2])),
    lambda flow: flow["edges"][2].update(id=flow["edges"][1]["id"]),
    lambda flow: flow["edges"][0].update(target="unknown"),
    lambda flow: flow["edges"][0].update(target="start"),
    lambda flow: flow["nodes"].append({"id": "other", "type": "start", "name": "other", "position": {"x": 0, "y": 0}}),
    lambda flow: flow["nodes"].pop(0),
    lambda flow: flow["nodes"][3].update(type="reply", answer="answer", suggestions=[]),
    lambda flow: flow["edges"].pop(),
    lambda flow: flow["edges"][2].update(branch="true"),
    lambda flow: flow["edges"].append({"id": "bad", "source": "reply", "target": "condition", "branch": None}),
    lambda flow: flow["edges"][2].update(target="condition"),
    lambda flow: flow["nodes"].append({"id": "orphan", "type": "continue", "name": "orphan", "position": {"x": 0, "y": 0}}),
    lambda flow: flow["nodes"][1]["condition"].update(words=[" "]),
    lambda flow: flow["nodes"][1]["condition"].update(words=["！"], operator="equals_any", stripTrailingPunctuation=True),
    lambda flow: flow["nodes"][1]["condition"].update(excludeAny=["HELLO"]),
    lambda flow: flow["nodes"][1]["condition"].update(words=["hello", "HELLO"]),
    lambda flow: flow["nodes"][1]["condition"].update(stripTrailingPunctuation=True),
    lambda flow: flow["nodes"][1]["condition"].update(words=[f"word{i}" for i in range(51)]),
    lambda flow: flow["nodes"][1]["condition"].update(words=["x" * 129]),
    lambda flow: flow["nodes"][2].update(answer="x" * 8001),
    lambda flow: flow["nodes"][2].update(suggestions=["suggestion"] * 6),
    lambda flow: flow.update(script="arbitrary"),
    lambda flow: flow.update(schemaVersion=2),
    lambda flow: flow.update(schemaVersion=True),
    lambda flow: flow["nodes"][0]["position"].update(x=float("inf")),
    lambda flow: flow["nodes"][1]["condition"].update(ignoreCase="true"),
])
def test_invalid_graphs(mutation):
    flow = branch_flow()
    mutation(flow)
    assert not validate_entry_definition(flow)["valid"]
    with pytest.raises(EntryFlowError):
        parse_entry_definition(flow)


def test_start_only_draft_is_structurally_valid_but_cannot_publish():
    flow = empty_entry_template()
    flow["nodes"].pop()
    flow["edges"] = []
    EntryDefinition.model_validate(flow)
    assert not validate_entry_definition(flow)["valid"]
    flow["extra"] = "unknown"
    with pytest.raises(ValidationError):
        EntryDefinition.model_validate(flow)


def test_redaction_before_storage_and_on_legacy_reads():
    value = "Bearer abc.def.ghi api_key=secret password:12345 sk-12345678901234567890 a@example.test 13812345678"
    redacted = "Bearer [REDACTED] api_key=[REDACTED] password:[REDACTED] [REDACTED] [EMAIL] [PHONE]"
    assert redact_entry_text(value) == redacted
    assert redact_entry_value({"answer": value, "password": "secret", "nodes": [{"name": "safe"}]}) == {
        "answer": redacted, "password": "[REDACTED]", "nodes": [{"name": "safe"}],
    }
