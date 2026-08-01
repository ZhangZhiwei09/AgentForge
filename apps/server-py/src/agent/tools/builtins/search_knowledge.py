"""搜索知识库工具 —— 语义搜索 + ILIKE fallback。

Phase B: pgvector 语义搜索优先，ILIKE 关键词搜索为 fallback。
删除 raw asyncpg 直连，改用 SQLAlchemy + PgVectorKnowledgeService。
"""

import json as _json
import logging
import re
from typing import Any

from sqlalchemy import text

from src.agent.tools.base import (
    RegisteredTool,
    RiskLevel,
    ToolDefinition,
    ToolFunction,
)
from src.config import settings
from src.db import async_session
from src.rag.pgvector import get_knowledge_service

logger = logging.getLogger(__name__)

# CJK 字符范围（Unicode block）
_CJK_RE = re.compile(r"[一-鿿㐀-䶿豈-﫿]")


def _tokenize(query: str, max_keywords: int = 5) -> list[str]:
    """将查询拆分为搜索关键词，支持中英文混合。

    策略：
    1. 先按空白字符切分
    2. 对每个 token，分离 ASCII 和 CJK 段落
    3. CJK 段落生成 bigram 子串（2-gram 滑动窗口）
    4. ASCII 段落保留原样
    5. 去重，截断到 max_keywords
    """
    raw_tokens = query.split()
    keywords: list[str] = []

    for token in raw_tokens:
        token = token.strip()
        if not token:
            continue

        # 如果整个 token 不含 CJK，直接作为关键词
        if not _CJK_RE.search(token):
            keywords.append(token)
            continue

        # 含 CJK：分离 ASCII/CJK 段落
        segments: list[str] = []
        current = ""
        current_is_cjk: bool | None = None

        for ch in token:
            ch_is_cjk = bool(_CJK_RE.match(ch))
            if current_is_cjk is None or ch_is_cjk == current_is_cjk:
                current += ch
                current_is_cjk = ch_is_cjk
            else:
                segments.append(current)
                current = ch
                current_is_cjk = ch_is_cjk
        if current:
            segments.append(current)

        for seg in segments:
            if _CJK_RE.search(seg):
                # CJK 段落 → bigram
                chars = list(seg)
                for i in range(len(chars) - 1):
                    keywords.append("".join(chars[i : i + 2]))
                if len(seg) <= 4:
                    keywords.append(seg)
            else:
                if seg:
                    keywords.append(seg)

    # 去重 + 截断
    seen: set[str] = set()
    unique: list[str] = []
    for kw in keywords:
        if kw not in seen:
            seen.add(kw)
            unique.append(kw)
            if len(unique) >= max_keywords:
                break

    return unique


async def _semantic_search(query: str) -> list[dict]:
    """使用 pgvector 语义搜索。"""
    service = get_knowledge_service(session_factory=async_session)
    results = await service.search(query=query, top_k=5)

    return [
        {
            "docTitle": r.doc_title,
            "content": r.content[:500] if r.content else "",
            "score": r.score,
        }
        for r in results
    ]


async def _ilike_search(query: str) -> list[dict]:
    """ILIKE 关键词搜索（fallback）。"""
    keywords = _tokenize(query, max_keywords=5)
    if not keywords:
        return []

    conditions = []
    params: dict = {}
    for i, kw in enumerate(keywords):
        param_name = f"kw{i}"
        conditions.append(
            f"(title ILIKE '%' || :{param_name} || '%' "
            f"OR content ILIKE '%' || :{param_name} || '%')"
        )
        params[param_name] = kw

    where_clause = " OR ".join(conditions)
    sql = f"""
        SELECT title, content, status
        FROM knowledge_documents
        WHERE enabled = TRUE AND ({where_clause})
        ORDER BY created_at DESC
        LIMIT 5
    """

    async with async_session() as session:
        result = await session.execute(text(sql), params)
        rows = result.fetchall()

    results: list[dict] = []
    for row in rows:
        content_snippet = row.content[:500] if row.content else ""
        results.append({
            "docTitle": row.title,
            "content": content_snippet,
            "score": 0.5,  # ILIKE 无评分，统一返回 0.5
        })
    return results


async def search_knowledge_execute(args: dict[str, Any], run_id: str) -> dict[str, Any]:
    """搜索知识库 —— pgvector 语义搜索优先，ILIKE fallback。"""
    query = args.get("query", "").strip()
    if not query:
        return {"status": "failed", "error": "搜索词不能为空"}

    try:
        results: list[dict] = []

        # 优先使用 pgvector 语义搜索
        if settings.pgvector_enabled:
            try:
                results = await _semantic_search(query)
            except Exception as exc:
                logger.warning(
                    "pgvector search failed, falling back to ILIKE: %s", exc
                )

        # Fallback: ILIKE 关键词搜索
        if not results:
            results = await _ilike_search(query)

        output = _json.dumps(
            {
                "found": len(results) > 0,
                "query": query,
                "results": results,
                "total": len(results),
            },
            ensure_ascii=False,
        )
        return {"status": "success", "output": output}

    except Exception as exc:
        logger.error("Knowledge search failed: %s", exc)
        return {"status": "failed", "error": str(exc)}


search_knowledge_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="search_knowledge_base",
            description="搜索知识库。使用此工具查找产品文档、FAQ、政策规则等内部知识。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索查询词，使用用户原始提问中的关键词",
                    },
                },
                "required": ["query"],
            },
        ),
    ),
    execute=search_knowledge_execute,
    risk_level=RiskLevel.READ_ONLY,
    timeout=15000,
    require_approval=False,
    category="search",
    parallelizable=True,
)
