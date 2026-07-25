"""Chat API —— POST /api/v1/chat 流式聊天端点。

对应 TS: apps/server/src/routes/agent-runtime.ts（基础 chat 部分）

这一版只做：用户发一句话 → 选 Provider → 调 LLM → SSE 流式返回。
不做：Agent Router、ReAct 循环、工具调用、知识库上下文。

Python 新概念：
- StreamingResponse：FastAPI 的流式响应，media_type="text/event-stream"
- SSE 格式："data: <json>\n\n"，浏览器 EventSource 可直接消费
- async generator 管道：LLM stream → StreamChunk → JSON → SSE string → HTTP response
"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.models.user import User
from src.providers.registry import get_provider, resolve_model
from src.schemas.chat import ChatMessage, ChatRequest, StreamChunk

router = APIRouter(prefix="/api/v1", tags=["chat"])


async def _to_sse(chunks: AsyncIterator[StreamChunk]) -> AsyncIterator[str]:
    """将 StreamChunk 异步迭代器转为 SSE 格式的字符串流。

    SSE (Server-Sent Events) 格式：
        data: {"type":"token","content":"你好"}\n
        \n
        data: {"type":"done","usage":{...}}\n
        \n

    Pydantic model_dump(exclude_none=True) 去掉 None 字段，减小传输体积。
    ensure_ascii=False 保留中文原文。
    """
    async for chunk in chunks:
        payload = json.dumps(
            chunk.model_dump(exclude_none=True), ensure_ascii=False
        )
        yield f"data: {payload}\n\n"


@router.post("/chat")
async def chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """流式聊天端点 —— POST /api/v1/chat。

    请求头需携带 JWT Bearer token（由 TS 端签发），
    请求体为 ChatRequest JSON。

    流程：
    1. JWT 验证（Depends → get_current_user）
    2. 解析模型（resolve_model）
    3. 获取 Provider（get_provider）
    4. 构建单轮消息
    5. 调 LLM 流式 API
    6. SSE StreamingResponse 返回

    示例 curl:
        curl -N -X POST http://localhost:8000/api/v1/chat \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer <token>" \
          -d '{"message": "你好"}'
    """
    # 解析模型 → Provider
    resolved = resolve_model(body.model)
    provider = get_provider(resolved["provider_name"])

    # 构建消息（这一版只做单轮，没有历史）
    messages = [ChatMessage(role="user", content=body.message)]

    # 调 LLM → 异步生成器
    chunks = provider.stream_chat(
        messages=messages,
        model=resolved["model_id"],
    )

    return StreamingResponse(
        _to_sse(chunks),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 nginx 缓冲（如有反代）
        },
    )
