"""Public diagnosis DTO adapter over the existing configured diagnosis runtime."""

import asyncio
import json
import logging
import uuid
from contextlib import aclosing
from dataclasses import replace
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.diagnosis.nodes import (
    build_clarification_content,
    classify_intent_from_query,
    extract_entities_from_query,
    get_missing_fields,
)
from src.agent.router.entry_decision import safety_route_scan
from src.agent.tools.registry import tool_registry
from src.agent.types import (
    DiagnosisWaitingInput,
    RouteContext,
    StreamError,
    StreamToken,
)
from src.api.deps import get_chat_user, get_db
from src.api.v1 import chat
from src.models.user import User
from src.providers.registry import resolve_model
from src.services.knowledge_retrieval import result_dto, retrieval_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["diagnosis"])


class DiagnosisQuery(BaseModel):
    query: str = Field(min_length=1, max_length=16000)
    kbIds: list[Annotated[str, Field(min_length=1)]] | None = Field(default=None, max_length=100)
    sessionId: str | None = Field(default=None, max_length=64)

    @field_validator("query")
    @classmethod
    def trim_query(cls, value):
        if not value.strip():
            raise ValueError("query must not be blank")
        return value.strip()


@router.post("/api/diagnosis/query")
async def diagnosis_query(
    body: DiagnosisQuery, db: Annotated[AsyncSession, Depends(get_db)],
    actor: Annotated[User, Depends(get_chat_user)],
):
    intent = classify_intent_from_query(body.query)
    entities = extract_entities_from_query(body.query)
    missing = get_missing_fields(intent, entities)
    response = {
        "intent": intent, "status": "diagnosed", "entities": entities, "missingFields": missing,
        "evidence": [], "toolResults": [], "answer": "", "warnings": [],
    }
    if safety_route_scan(body.query):
        response.update(status="unsupported", answer="此问题不在可支持的诊断范围内。", missingFields=[])
        return response
    if missing:
        response.update(
            status="needs_clarification", answer=build_clarification_content(intent, missing, entities)[0],
        )
        return response
    registry = tool_registry.filter(["query_trace_log", "search_knowledge_base"])
    service = retrieval_service(db)

    async def search(args, run_id):
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            return {"status": "failed", "error": "搜索词不能为空"}
        results = await service.retrieve(query, body.kbIds, 5)
        for item in results:
            response["evidence"].append({
                "id": item.chunk_id, "source": "knowledge", "title": item.doc_title, "detail": item.content,
            })
        return {"status": "success", "output": json.dumps({
            "found": bool(results), "query": query,
            "results": [{"index": index + 1, **result_dto(item)} for index, item in enumerate(results)],
        }, ensure_ascii=False)}

    registry.register(replace(registry.get("search_knowledge_base"), execute=search))
    trace_tool = registry.get("query_trace_log")

    async def trace(args, run_id):
        result = await trace_tool.execute(args, run_id)
        data = result.get("output")
        response["toolResults"].append({
            "toolName": "query_trace_log", "ok": result.get("status") == "success",
            "summary": "已查询链路日志" if result.get("status") == "success" else "链路查询失败",
            "data": data if isinstance(data, dict) else {},
        })
        return result

    registry.register(replace(trace_tool, execute=trace))
    cancel = asyncio.Event()
    try:
        conversation = await chat._get_or_create_conversation(db, actor.id, body.sessionId)
        resolved = resolve_model(None)
        context = RouteContext(
            conversation_id=conversation.id, session_id=conversation.session_id, user_message=body.query,
            assistant_msg_id=str(uuid.uuid4()), resolved_model=resolved["model_id"],
            provider_name=resolved["provider_name"], intent="diagnosis",
        )
        async with asyncio.timeout(180):
            async with aclosing(chat._stream_diagnosis(
                context, actor.id, waiting=False, cancel=cancel, registry=registry,
            )) as stream:
                async for event in stream:
                    if isinstance(event, StreamToken):
                        response["answer"] += event.content
                    elif isinstance(event, DiagnosisWaitingInput):
                        response.update(status="needs_clarification", missingFields=event.missing_fields)
                    elif isinstance(event, StreamError):
                        response.update(status="failed")
                        response["warnings"].append(event.content)
        if not response["answer"]:
            response.update(status="failed", answer="诊断未生成结果，请稍后重试。")
        return response
    except asyncio.CancelledError:
        cancel.set()
        raise
    except HTTPException:
        raise
    except Exception:
        logger.exception("Public diagnosis runtime failed")
        response.update(status="failed", answer="诊断服务暂不可用，请稍后重试。")
        response["warnings"].append("诊断运行失败")
        return response
    finally:
        cancel.set()
