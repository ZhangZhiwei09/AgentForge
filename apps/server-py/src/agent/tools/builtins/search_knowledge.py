"""搜索知识库工具 —— 从 PostgreSQL 检索文档。

对应 TS: apps/server/src/tools/builtin/search-knowledge-base.ts

当前版本使用 PostgreSQL ILIKE 全文搜索。
Step 11+ 将升级为 Embedding + pgvector 向量检索。
"""

import json
import logging
import re
from typing import Any

import asyncpg

from src.agent.tools.base import (
    RegisteredTool,
    RiskLevel,
    ToolDefinition,
    ToolFunction,
)
from src.config import settings

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

        # 如果整个 token 不含 CJK，直接作为关键词（如 "SDK", "API"）
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
                # 短段落也保留原样
                if len(seg) <= 4:
                    keywords.append(seg)
            else:
                # ASCII 段落保留原样
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


async def _get_conn() -> asyncpg.Connection:
    """从 DATABASE_URL 创建 asyncpg 连接。"""
    url = settings.database_url
    # postgresql+asyncpg://user:pass@host:port/dbname
    rest = url.replace("postgresql+asyncpg://", "")
    user_pass, host_db = rest.split("@", 1) if "@" in rest else ("", rest)
    user, password = user_pass.split(":", 1) if ":" in user_pass else (user_pass, "")
    host_port, db_name = host_db.split("/", 1) if "/" in host_db else (host_db, "postgres")
    host, port = host_port.split(":", 1) if ":" in host_port else (host_port, "5434")

    return await asyncpg.connect(
        user=user,
        password=password,
        host=host,
        port=int(port),
        database=db_name,
    )


async def search_knowledge_execute(args: dict[str, Any], run_id: str) -> dict[str, Any]:
    """搜索知识库 —— 从 knowledge_documents 表全文检索。"""
    query = args.get("query", "").strip()
    if not query:
        return {"status": "failed", "error": "搜索词不能为空"}

    conn: asyncpg.Connection | None = None
    try:
        conn = await _get_conn()

        # 分词：中英文混合 tokenize，取前 5 个关键词做 ILIKE 匹配
        keywords = _tokenize(query, max_keywords=5)
        if not keywords:
            return {"status": "success", "output": json.dumps({"found": False, "results": [], "total": 0}, ensure_ascii=False)}

        # 构建 ILIKE 条件（每个关键词 OR 匹配 title/content）
        conditions = []
        params: list[Any] = []
        for i, kw in enumerate(keywords):
            param_name = f"kw{i}"
            conditions.append(
                f"(title ILIKE '%' || ${i + 1} || '%' OR content ILIKE '%' || ${i + 1} || '%')"
            )
            params.append(kw)

        where_clause = " OR ".join(conditions)
        sql = f"""
            SELECT title, content, status
            FROM knowledge_documents
            WHERE enabled = TRUE AND ({where_clause})
            ORDER BY created_at DESC
            LIMIT 5
        """

        rows = await conn.fetch(sql, *params)

        results = []
        for row in rows:
            # 返回文档摘要（内容截断前 500 字）
            content_snippet = row["content"][:500] if row["content"] else ""
            results.append({
                "docTitle": row["title"],
                "content": content_snippet,
                "score": 0.5,  # ILIKE 无评分，统一返回 0.5
            })

        output = json.dumps(
            {"found": len(results) > 0, "query": query, "results": results, "total": len(results)},
            ensure_ascii=False,
        )
        return {"status": "success", "output": output}

    except Exception as exc:
        logger.error("Knowledge search failed: %s", exc)
        return {"status": "failed", "error": str(exc)}

    finally:
        if conn:
            await conn.close()


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
