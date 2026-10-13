"""Knowledge tool backed by the shared hybrid retrieval service."""

import json
import logging
from typing import Any

from src.agent.tools.base import RegisteredTool, RiskLevel, ToolDefinition, ToolFunction
from src.db import async_session
from src.rag.pgvector import get_knowledge_service
from src.rag.types import HybridSearchParams
from src.services.knowledge_retrieval import result_dto

logger = logging.getLogger(__name__)


async def _semantic_search(query: str) -> list[dict]:
    service = get_knowledge_service(session_factory=async_session)
    results = await service.hybrid_search(HybridSearchParams(query=query, top_k=5))
    return [{"index": index + 1, **result_dto(result)} for index, result in enumerate(results)]


async def search_knowledge_execute(args: dict[str, Any], run_id: str) -> dict[str, Any]:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 1000:
        return {"status": "failed", "error": "搜索词必须为 1 到 1000 字符"}
    try:
        results = await _semantic_search(query.strip())
        score_type = results[0].get("scoreType") if results else None
        output = {
            "found": bool(results), "query": query.strip(), "results": results, "total": len(results),
            "score_type": score_type, "top_score": results[0]["score"] if results else 0,
            "top_relevance_score": results[0]["score"] if results and score_type == "reranker" else None,
            "quality": "ranked" if score_type == "rrf" else "high" if results else "low",
        }
        return {"status": "success", "output": json.dumps(output, ensure_ascii=False)}
    except Exception:
        logger.exception("Knowledge tool retrieval failed run=%s", run_id)
        return {"status": "failed", "error": "知识库检索暂不可用"}


search_knowledge_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="search_knowledge_base",
            description="搜索知识库，查找内部文档、FAQ 和政策。只使用最近检索结果的 index 编号引用资料。",
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string", "description": "搜索查询词"}},
                "required": ["query"],
            },
        ),
    ),
    execute=search_knowledge_execute, risk_level=RiskLevel.READ_ONLY, timeout=15000,
    require_approval=False, category="search", parallelizable=True,
)
