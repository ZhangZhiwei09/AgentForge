"""Chat API —— POST /api/v1/chat 流式聊天端点。

对应 TS: apps/server/src/routes/agent-runtime.ts

流程:
    用户消息 → Router(L1关键词) → AgentExecutor(ReAct) → SSE Stream

路由:
    SAFETY → 安全拦截
    CHAT   → 直接 LLM 回复（当前版本复用 TASK）
    TASK   → ReAct AgentExecutor（工具调用）
    HUMAN  → 转人工

Python 新概念：
- isinstance() 模式匹配：根据事件类型（StreamToken/StreamDone/StreamError）处理
- QueryRouter + AgentExecutor 管线编排
"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.executor import AgentExecutor
from src.agent.router.pipeline import QueryRouter
from src.agent.types import (
    RouteContext,
    RouteName,
    StreamDone,
    StreamError,
    StreamToken,
)
from src.api.deps import get_current_user, get_db
from src.models.user import User
from src.providers.registry import resolve_model
from src.schemas.chat import ChatRequest

router = APIRouter(prefix="/api/v1", tags=["chat"])

# ── 模块级单例（惰性初始化）──
_router: QueryRouter | None = None
_executor: AgentExecutor | None = None


def _get_router() -> QueryRouter:
    global _router
    if _router is None:
        _router = QueryRouter()
    return _router


def _get_executor() -> AgentExecutor:
    global _executor
    if _executor is None:
        _executor = AgentExecutor()
    return _executor


# ── SAMessage SSE ──


async def _to_sse(events: AsyncIterator) -> AsyncIterator[str]:
    """将 Agent 事件流转为 SSE 格式字符串流。"""
    async for event in events:
        if isinstance(event, StreamToken):
            payload = json.dumps(
                {"type": "token", "content": event.content, "message_id": event.message_id},
                ensure_ascii=False,
            )
        elif isinstance(event, StreamDone):
            payload = json.dumps(
                {
                    "type": "done",
                    "message_id": event.message_id,
                    "usage": event.usage,
                    "suggestions": event.suggestions,
                    "validated": event.validated,
                    "fallback_used": event.fallback_used,
                    "route": event.route,
                },
                ensure_ascii=False,
            )
        elif isinstance(event, StreamError):
            payload = json.dumps(
                {"type": "error", "content": event.content},
                ensure_ascii=False,
            )
        else:
            # StreamMeta → 也转成 meta 事件
            payload = json.dumps(
                {
                    "type": event.type,
                    "message_id": getattr(event, "message_id", ""),
                    "model": getattr(event, "model", ""),
                    "provider": getattr(event, "provider", ""),
                    "route": getattr(event, "route", ""),
                },
                ensure_ascii=False,
            )

        yield f"data: {payload}\n\n"


# ── 安全拦截响应 ──
SAFETY_RESPONSE = "抱歉，您的消息包含不安全内容，无法处理。如有需要，请联系人工客服。"


async def _stream_safety(assistant_msg_id: str) -> AsyncIterator:
    """SAFETY 路由：返回安全拦截消息。"""
    yield StreamToken(content=SAFETY_RESPONSE, message_id=assistant_msg_id)
    yield StreamDone(
        message_id=assistant_msg_id,
        usage={},
        route=RouteName.SAFETY.value,
        fallback_used=True,
    )


async def _stream_human(assistant_msg_id: str) -> AsyncIterator:
    """HUMAN 路由：告知用户将转接人工。"""
    human_msg = "正在为您转接人工客服，请稍候..."
    for char in human_msg:
        yield StreamToken(content=char, message_id=assistant_msg_id)
    yield StreamDone(
        message_id=assistant_msg_id,
        usage={},
        route=RouteName.HUMAN.value,
    )


# ═══════════════════════════════════════════════════════════
# POST /api/v1/chat
# ═══════════════════════════════════════════════════════════


@router.post("/chat")
async def chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """流式聊天端点 —— POST /api/v1/chat。

    流程:
    1. JWT 验证
    2. Router 分类（L1 关键词正则）
    3. 按路由分发:
       - SAFETY → 安全拦截回复
       - HUMAN  → 转人工提示
       - CHAT/TASK → ReAct AgentExecutor（LLM + Tool Calling）
    4. SSE StreamingResponse 返回

    示例:
        curl -N -X POST http://localhost:8000/api/v1/chat \\
          -H "Content-Type: application/json" \\
          -H "Authorization: Bearer <token>" \\
          -d '{"message": "你好"}'
    """
    import uuid

    # 解析模型
    resolved = resolve_model(body.model)
    assistant_msg_id = str(uuid.uuid4())

    # ── Router 分类 ──
    router = _get_router()
    decision = router.classify(body.message)

    # ── 按路由分发 ──
    if decision.route == RouteName.SAFETY:
        events = _stream_safety(assistant_msg_id)

    elif decision.route == RouteName.HUMAN:
        events = _stream_human(assistant_msg_id)

    else:
        # CHAT / TASK → ReAct AgentExecutor
        context = RouteContext(
            user_message=body.message,
            resolved_model=resolved["model_id"],
            provider_name=resolved["provider_name"],
            assistant_msg_id=assistant_msg_id,
            intent=decision.route.value,
        )
        executor = _get_executor()
        events = executor.execute(context)

    return StreamingResponse(
        _to_sse(events),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
