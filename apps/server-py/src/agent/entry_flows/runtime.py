import asyncio
import time
from dataclasses import dataclass

from src.agent.entry_flows.schema import (
    ConditionNode,
    EntryDefinition,
    ReplyNode,
    RouteNode,
    normalize_entry_text,
    parse_entry_definition,
)


@dataclass
class EntryExecution:
    result: dict
    terminal_node_id: str
    records: list[dict]
    duration_ms: int


def check_cancel(cancel: asyncio.Event | None):
    if cancel is not None and cancel.is_set():
        raise asyncio.CancelledError()


def execute_entry_flow(value: EntryDefinition | dict, message: str, cancel: asyncio.Event | None = None) -> EntryExecution:
    started = time.monotonic()
    check_cancel(cancel)
    if not message.strip() or len(message) > 16000:
        raise ValueError("消息不能为空且不能超过 16000 字符")
    definition = parse_entry_definition(value)
    nodes = {node.id: node for node in definition.nodes}
    current_id = next(node.id for node in definition.nodes if node.type == "start")
    records = []
    for _ in range(30):
        check_cancel(cancel)
        node = nodes[current_id]
        node_started = time.monotonic()
        record = {"nodeId": node.id, "name": node.name, "type": node.type, "durationMs": 0}
        branch = None
        result = None
        if isinstance(node, ConditionNode):
            config = node.condition
            message_text = normalize_entry_text(message, config)
            words = [normalize_entry_text(word, config) for word in config.words]
            excluded = [normalize_entry_text(word, config) for word in config.excludeAny]
            matches = (
                message_text in words if config.operator == "equals_any"
                else all(word in message_text for word in words) if config.operator == "contains_all"
                else any(word in message_text for word in words)
            )
            matched = matches and not any(word in message_text for word in excluded)
            branch = "true" if matched else "false"
            record.update(matched=matched, branch=branch)
        elif isinstance(node, ReplyNode):
            result = {"action": "reply", "answer": node.answer, "suggestions": list(node.suggestions)}
        elif isinstance(node, RouteNode):
            result = {"action": "route", "target": node.target}
            if node.handoff is not None:
                result["handoff"] = node.handoff.model_dump()
        elif node.type == "continue":
            result = {"action": "continue"}
        record["durationMs"] = int((time.monotonic() - node_started) * 1000)
        records.append(record)
        if result is not None:
            return EntryExecution(result, node.id, records, int((time.monotonic() - started) * 1000))
        edge = next(edge for edge in definition.edges if edge.source == node.id and edge.branch == branch)
        current_id = edge.target
    raise ValueError("一级流程执行超过节点上限")
