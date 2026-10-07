"""Adapt private flow events to the existing public diagnosis event contract."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import aclosing

from src.agent.flows.runtime import agent_order
from src.agent.flows.schema import FlowDefinition
from src.agent.flows.service import execute_run
from src.agent.tools.registry import ToolRegistry
from src.agent.types import (
    DiagnosisCompleted, DiagnosisPhase, DiagnosisPhaseDone, DiagnosisStarted,
    DiagnosisWaitingInput, RouteContext, RouteStreamEvent, StreamDone, StreamError, StreamToken,
)
from src.models.agent_flow import AgentFlowRun


async def diagnosis_events(
    run: AgentFlowRun, context: RouteContext, registry: ToolRegistry,
    cancel: asyncio.Event, *, resume=False,
) -> AsyncIterator[RouteStreamEvent]:
    from src.agent.diagnosis.route_agent import _extract_conclusion_text, _extract_summary

    definition = FlowDefinition.model_validate(run.snapshot)
    phases = {node.id: index + 1 for index, node in enumerate(agent_order(definition))}
    names = {node.id: node.name for node in definition.nodes}
    async with aclosing(execute_run(run, context, registry, cancel, resume=resume)) as stream:
        async for event in stream:
            node_id = event.get("nodeId")
            kind = event["type"]
            if kind == "flow_started":
                yield DiagnosisStarted(message_id=context.assistant_msg_id, agents=event["agents"])
                if resume:
                    for key, record in run.records.items():
                        if key in phases and record["status"] == "completed":
                            yield DiagnosisPhaseDone(
                                message_id=context.assistant_msg_id, phase=phases[key],
                                agent=key, label=names[key], summary=_extract_summary(record.get("output")),
                            )
            elif node_id in phases and kind == "node_started":
                yield DiagnosisPhase(
                    message_id=context.assistant_msg_id, phase=phases[node_id],
                    agent=node_id, label=names[node_id],
                )
            elif node_id in phases and kind == "node_completed":
                yield DiagnosisPhaseDone(
                    message_id=context.assistant_msg_id, phase=phases[node_id],
                    agent=node_id, label=names[node_id], summary=_extract_summary(event["output"]),
                )
            elif kind == "flow_completed":
                output = {**event["output"], "skipped_nodes": event["skippedNodes"]}
                yield DiagnosisCompleted(message_id=context.assistant_msg_id, output=output)
                yield StreamToken(
                    message_id=context.assistant_msg_id, content=_extract_conclusion_text(output),
                )
            elif kind == "flow_waiting_input":
                yield DiagnosisWaitingInput(
                    message_id=context.assistant_msg_id, message=event["message"],
                    missing_fields=event["missing_fields"],
                )
                yield StreamToken(message_id=context.assistant_msg_id, content=event["message"])
            elif kind in ("flow_failed", "flow_cancelled"):
                yield StreamError(content="诊断已取消。" if kind == "flow_cancelled" else "配置诊断执行失败，请联系管理员查看运行记录。")
    yield StreamDone(message_id=context.assistant_msg_id, route="DIAGNOSIS", usage={})
