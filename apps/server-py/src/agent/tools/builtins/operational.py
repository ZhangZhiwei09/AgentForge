"""Operational tools on the shared registry, with bounded inputs and outputs."""

import ast
import asyncio
import json
import logging
import math
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from pydantic import AnyHttpUrl, BaseModel, Field, ValidationError, field_validator
from simpleeval import SimpleEval
from sqlalchemy import text
from sqlglot import exp, parse

from src.agent.tools.base import RegisteredTool, RiskLevel, ToolDefinition, ToolFunction
from src.config import settings
from src.models.support_ticket import SupportTicket

logger = logging.getLogger(__name__)


def result(output, *, partial=False):
    return {"status": "partial" if partial else "success",
            "output": output if isinstance(output, str) else json.dumps(output, ensure_ascii=False, default=str)}


class TimeInput(BaseModel):
    timezone: str = Field(default="UTC", max_length=100)


class CalculationInput(BaseModel):
    expression: str = Field(min_length=1, max_length=500)


class SearchInput(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    max_results: int = Field(default=5, ge=1, le=10)


class RequestInput(BaseModel):
    url: AnyHttpUrl
    method: Literal["GET", "POST"] = "GET"
    body: str | None = Field(default=None, max_length=1000000)
    headers: dict[str, str] = Field(default_factory=dict, max_length=50)

    @field_validator("method", mode="before")
    @classmethod
    def upper_method(cls, value):
        return value.upper() if isinstance(value, str) else value


class FetchInput(BaseModel):
    url: AnyHttpUrl
    max_chars: int = Field(default=10000, ge=1, le=50000)


class ReadInput(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    max_lines: int = Field(default=500, ge=1, le=2000)


class WriteInput(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(max_length=2000000)


class FileSearchInput(BaseModel):
    pattern: str = Field(default="**/*", min_length=1, max_length=300)
    contains: str | None = Field(default=None, max_length=1000)
    max_results: int = Field(default=20, ge=1, le=100)


class SqlInput(BaseModel):
    query: str = Field(min_length=1, max_length=16000)


class TicketInput(BaseModel):
    summary: str = Field(min_length=1, max_length=4000)
    priority: Literal["normal", "urgent"] = "normal"
    category: str = Field(default="通用", min_length=1, max_length=100)


async def current_time(body: TimeInput, run_id: str):
    try:
        zone = ZoneInfo(body.timezone)
    except ZoneInfoNotFoundError:
        return result(f"Invalid timezone. Current UTC time: {datetime.now(UTC).isoformat()}", partial=True)
    return result(datetime.now(zone).isoformat())


async def calculate(body: CalculationInput, run_id: str):
    functions = {name: getattr(math, name) for name in (
        "sqrt", "floor", "ceil", "sin", "cos", "tan", "log", "log10", "exp",
    )}
    evaluator = SimpleEval(functions={**functions, "abs": abs, "round": round},
                           names={"PI": math.pi, "E": math.e})
    # Retain simpleeval's bounded power operator, including the pow() alias.
    evaluator.functions["pow"] = evaluator.operators[ast.Pow]
    value = evaluator.eval(body.expression)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Result must be a finite number")
    return result(format(value, ".12g"))


def workspace_path(path: str) -> Path:
    if not settings.file_workspace:
        raise ValueError("An isolated file workspace must be explicitly configured")
    root = Path(settings.file_workspace).resolve()
    candidate = Path(path)
    if candidate.is_absolute():
        raise ValueError("A relative workspace path is required")
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("Path is outside the workspace")
    return resolved


async def file_read(body: ReadInput, run_id: str):
    path = workspace_path(body.path)

    def read():
        with path.open("r", encoding="utf-8", errors="replace") as source:
            return source.read(2000001)

    content = await asyncio.to_thread(read)
    lines = content[:2000000].splitlines(keepends=True)
    return result("".join(lines[:body.max_lines]), partial=len(content) > 2000000 or len(lines) > body.max_lines)


async def file_write(body: WriteInput, run_id: str):
    path = workspace_path(body.path)

    def write():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body.content, encoding="utf-8")

    await asyncio.to_thread(write)
    return result(f'File written successfully: "{body.path}" ({len(body.content)} characters)')


async def file_search(body: FileSearchInput, run_id: str):
    root = workspace_path(".")
    pattern = Path(body.pattern)
    if pattern.is_absolute() or ".." in pattern.parts:
        raise ValueError("Search pattern must remain inside the workspace")

    def search():
        matches = []
        for path in root.glob(body.pattern):
            relative = path.relative_to(root)
            if any(part.startswith(".") or part == "node_modules" for part in relative.parts):
                continue
            if not path.is_file() or not path.resolve().is_relative_to(root):
                continue
            if body.contains:
                try:
                    with path.open("r", encoding="utf-8", errors="replace") as source:
                        if body.contains not in source.read(2000000):
                            continue
                except OSError:
                    logger.debug("File search skipped an unreadable file", exc_info=True)
                    continue
            matches.append(relative.as_posix())
            if len(matches) > body.max_results:
                break
        return matches

    matches = await asyncio.to_thread(search)
    return result({
        "pattern": body.pattern, "contains": body.contains, "matches": matches[:body.max_results],
        "total": min(len(matches), body.max_results),
    }, partial=len(matches) > body.max_results)


async def request_text(url: str, method: str, headers: dict[str, str], body: str | None, limit: int):
    async with (
        httpx.AsyncClient(timeout=15, follow_redirects=True, max_redirects=5) as client,
        client.stream(method, url, headers=headers, content=body if method == "POST" else None) as response,
    ):
        pieces = []
        size = 0
        async for piece in response.aiter_text():
            pieces.append(piece[:max(0, limit + 1 - size)])
            size += len(pieces[-1])
            if size > limit:
                break
        return response, "".join(pieces)


async def http_request(body: RequestInput, run_id: str):
    headers = {"User-Agent": "AgentForge/1.0", "Accept": "application/json, text/plain, */*", **body.headers}
    if body.method == "POST" and body.body:
        headers.setdefault("Content-Type", "application/json")
    response, content = await request_text(str(body.url), body.method, headers, body.body, 5000)
    return result({
        "status": response.status_code, "statusText": response.reason_phrase,
        "headers": dict(response.headers), "body": content[:5000],
    }, partial=len(content) > 5000)


async def web_fetch(body: FetchInput, run_id: str):
    started = time.monotonic()
    response, content = await request_text(str(body.url), "GET", {"User-Agent": "AgentForge/1.0"}, None, body.max_chars)
    response.raise_for_status()
    return result({
        "url": str(body.url), "status": response.status_code,
        "content_type": response.headers.get("content-type", "unknown"), "content_length": len(content),
        "returned_chars": min(len(content), body.max_chars), "truncated": len(content) > body.max_chars,
        "content": content[:body.max_chars], "duration_ms": round((time.monotonic() - started) * 1000),
    }, partial=len(content) > body.max_chars)


class SearchHit(BaseModel):
    title: str
    url: str
    content: str
    score: float


class SearchResponse(BaseModel):
    answer: str | None = None
    results: list[SearchHit] = Field(default_factory=list, max_length=100)


async def web_search(body: SearchInput, run_id: str):
    if not settings.tavily_api_key:
        return result({"query": body.query, "results": [], "note": "Web search API key is not configured"}, partial=True)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post("https://api.tavily.com/search", headers={
            "Authorization": f"Bearer {settings.tavily_api_key}",
        }, json={"query": body.query, "max_results": body.max_results, "search_depth": "basic", "include_answer": True})
        response.raise_for_status()
        data = SearchResponse.model_validate(response.json())
    results = [{"title": hit.title, "url": hit.url, "snippet": hit.content[:300], "score": hit.score}
               for hit in data.results[:body.max_results]]
    return result({"query": body.query, "answer": (data.answer or "")[:10000] or None,
                   "results": results, "total": len(results)})


def select_query(query: str) -> str:
    statements = parse(query, read="postgres")
    if len(statements) != 1 or not isinstance(statements[0], (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        raise ValueError("Only one SELECT query is allowed")
    tree = statements[0]
    if any(isinstance(node, (exp.DML, exp.DDL, exp.Command, exp.Into, exp.Lock)) for node in tree.walk()):
        raise ValueError("SQL writes and locking queries are not allowed")
    return tree.sql(dialect="postgres")


async def db_query(body: SqlInput, run_id: str):
    from src.db import async_session

    query = select_query(body.query)
    started = time.monotonic()
    async with async_session() as db, db.begin():
        await db.execute(text("SET TRANSACTION READ ONLY"))
        await db.execute(text("SET LOCAL statement_timeout = '10s'"))
        rows = (await db.execute(text(f"SELECT * FROM ({query}) AS agent_query LIMIT 101"))).mappings().all()
    payload = {"row_count": min(len(rows), 100), "rows": [dict(row) for row in rows[:100]],
               "truncated": len(rows) > 100, "duration_ms": round((time.monotonic() - started) * 1000)}
    output = json.dumps(payload, ensure_ascii=False, default=str)
    if len(output) > 80000:
        payload["rows"] = payload["rows"][:20]
        while payload["rows"] and len(json.dumps(payload, ensure_ascii=False, default=str)) > 80000:
            payload["rows"].pop()
        payload["truncated"] = True
        return result(payload, partial=True)
    return result(output, partial=len(rows) > 100)


async def create_ticket(body: TicketInput, run_id: str):
    from src.db import async_session

    now = datetime.now(UTC)
    ticket_id = f"TKT-{int(now.timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    async with async_session() as db:
        db.add(SupportTicket(id=str(uuid.uuid4()), ticket_id=ticket_id, summary=body.summary,
                             priority=body.priority, category=body.category))
        await db.commit()
    return result({
        "ticket_id": ticket_id, "status": "已创建", "priority": body.priority, "category": body.category,
        "summary": body.summary, "created_at": now.isoformat(),
        "response_time": "支持团队将在 1 小时内响应处理。" if body.priority == "urgent" else "支持团队将在 24 小时内响应处理。",
        "tracking_tip": f"您可以通过工单号 {ticket_id} 查询处理进度。",
    })


def define[T: BaseModel](
    name: str, description: str, schema: type[T], execute: Callable[[T, str], Awaitable[dict]],
    *, risk=RiskLevel.READ_ONLY, category="utility", timeout=15000, approval=False,
) -> RegisteredTool:
    async def validated(args: dict, run_id: str):
        try:
            parsed = schema.model_validate(args)
        except ValidationError:
            return {"status": "failed", "error": f"Invalid arguments for {name}"}
        return await execute(parsed, run_id)

    return RegisteredTool(
        definition=ToolDefinition(function=ToolFunction(
            name=name, description=description, parameters=schema.model_json_schema(),
        )), execute=validated, risk_level=risk, category=category, timeout=timeout,
        require_approval=approval, parallelizable=risk not in {RiskLevel.MUTATION, RiskLevel.DESTRUCTIVE},
    )


OPERATIONAL_TOOLS = [
    define("get_current_time", "获取指定 IANA 时区的当前日期和时间，默认 UTC。", TimeInput, current_time, risk=RiskLevel.SAFE),
    define("calculator", "计算算术表达式，支持四则运算、幂、括号和常见数学函数。", CalculationInput, calculate, risk=RiskLevel.SAFE),
    define("web_search", "搜索互联网中的实时资料，返回标题、摘要、链接和搜索回答。", SearchInput, web_search, category="search"),
    define("http_request", "发送 GET 或 POST 请求，返回状态、响应头和最多 5000 字的响应内容。",
           RequestInput, http_request, risk=RiskLevel.MUTATION, category="network", approval=True),
    define("web_fetch", "读取网页或 URL 的文本内容。", FetchInput, web_fetch, category="network", timeout=20000),
    define("file_read", "读取工作区内的文本文件，可限制行数。", ReadInput, file_read, risk=RiskLevel.SAFE, category="file"),
    define("file_write", "写入工作区内的文本文件，会覆盖已有内容，需要审批。",
           WriteInput, file_write, risk=RiskLevel.DESTRUCTIVE, category="file", approval=True),
    define("file_search", "按 glob 文件名模式和文本内容搜索工作区文件。", FileSearchInput, file_search, category="file"),
    define("db_query", "以只读事务执行单条 SELECT 查询，最多返回 100 行。", SqlInput, db_query, category="database"),
    define("create_support_ticket", "创建并持久化支持工单，支持普通或紧急优先级，需要审批。",
           TicketInput, create_ticket, risk=RiskLevel.MUTATION, category="business", timeout=30000, approval=True),
]
