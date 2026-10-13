"""Authenticated tools and disabled long-term memory compatibility endpoints."""

from fastapi import APIRouter, Depends, HTTPException

from src.agent.tools.registry import tool_registry
from src.api.deps import get_current_user

router = APIRouter(tags=["platform"], dependencies=[Depends(get_current_user)])


@router.get("/api/tools")
async def tools():
    tool_registry.init()
    definitions = []
    for name in tool_registry.list_names():
        tool = tool_registry.get(name)
        definitions.append({
            "name": name, "description": tool.definition.function.description,
            "parameters": tool.definition.function.parameters, "risk_level": str(tool.risk_level),
            "timeout_ms": tool.timeout, "require_approval": tool.require_approval,
            "category": tool.category, "sandbox": getattr(tool, "sandbox", False),
            "parallelizable": tool.parallelizable,
        })
    return {"tools": definitions, "count": len(definitions)}


@router.get("/api/memories")
async def memories():
    return {"memories": [], "message": "长期记忆系统已禁用"}


@router.get("/api/memories/search")
async def search_memories():
    return {"results": [], "message": "长期记忆搜索已禁用"}


@router.delete("/api/memories/{memory_id}")
async def delete_memory(memory_id: str):
    raise HTTPException(404, "长期记忆系统已禁用")
