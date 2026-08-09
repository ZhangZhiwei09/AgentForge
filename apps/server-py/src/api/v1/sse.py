"""SSE 序列化 —— 将 Agent 流事件转为 SSE 格式字符串。

与聊天管线解耦：新增事件类型时，只需为 _sse_payload 再注册一个 overload。
"""

import functools
import json
from collections.abc import AsyncIterator

from src.agent.types import (
    ClarificationNeeded,
    DiagnosisCompleted,
    DiagnosisPhase,
    DiagnosisPhaseDone,
    DiagnosisStarted,
    DiagnosisWaitingInput,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)


@functools.singledispatch
def _sse_payload(event: object) -> dict:
    """将单个 Agent 事件序列化为 SSE payload dict（未知类型走兜底）。

    新增事件类型时，只需再注册一个 _sse_payload 的 overload。
    """
    return {
        "type": getattr(event, "type", "unknown"),
        "message_id": getattr(event, "message_id", ""),
    }


@_sse_payload.register
def _(event: StreamToken) -> dict:
    return {"type": "token", "content": event.content, "message_id": event.message_id}


@_sse_payload.register
def _(event: StreamDone) -> dict:
    return {
        "type": "done",
        "message_id": event.message_id,
        "usage": event.usage,
        "suggestions": event.suggestions,
        "validated": event.validated,
        "fallback_used": event.fallback_used,
        "route": event.route,
    }


@_sse_payload.register
def _(event: StreamError) -> dict:
    return {"type": "error", "content": event.content}


@_sse_payload.register
def _(event: StreamMeta) -> dict:
    return {
        "type": event.type,
        "message_id": event.message_id,
        "conversation_id": getattr(event, "conversation_id", ""),
        "session_id": event.session_id,
        "model": event.model,
        "provider": event.provider,
        "route": event.route,
        "intent": getattr(event, "intent", ""),
        "within_service_hours": getattr(event, "within_service_hours", None),
        "memory_count": getattr(event, "memory_count", 0),
    }


@_sse_payload.register
def _(event: DiagnosisStarted) -> dict:
    return {"type": "diagnosis_started", "message_id": event.message_id, "agents": event.agents}


@_sse_payload.register
def _(event: DiagnosisPhase) -> dict:
    return {"type": "diagnosis_phase", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label}


@_sse_payload.register
def _(event: DiagnosisPhaseDone) -> dict:
    return {"type": "diagnosis_phase_done", "message_id": event.message_id, "phase": event.phase, "agent": event.agent, "label": event.label, "summary": event.summary}


@_sse_payload.register
def _(event: DiagnosisCompleted) -> dict:
    return {"type": "diagnosis_completed", "message_id": event.message_id, "output": event.output}


@_sse_payload.register
def _(event: ClarificationNeeded) -> dict:
    return {
        "type": "clarification_needed",
        "message_id": event.message_id,
        "intent": event.intent,
        "missing_fields": event.missing_fields,
        "prompt_message": event.prompt_message,
        "hints": event.hints,
    }


@_sse_payload.register
def _(event: DiagnosisWaitingInput) -> dict:
    # Phase 3b HITL：诊断在阶段边界暂停，等待用户补充信息。
    return {
        "type": "diagnosis_waiting_input",
        "message_id": event.message_id,
        "message": event.message,
        "missing_fields": event.missing_fields,
    }


async def _to_sse(events: AsyncIterator) -> AsyncIterator[str]:
    """将 Agent 事件流转为 SSE 格式字符串流。"""
    async for event in events:
        payload = json.dumps(_sse_payload(event), ensure_ascii=False)
        yield f"data: {payload}\n\n"
