"""聊天相关 Schema —— 请求/响应/流式片段的 Pydantic 模型。

对应 TS: apps/server/src/providers/types.ts
"""

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    """对话消息 —— 支持简单文本消息和 tool_call 消息。

    对应 TS 的 ChatMessage interface。
    """

    role: str  # "user" | "assistant" | "system" | "tool"
    content: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None


class StreamChunk(BaseModel):
    """LLM 流式响应的每个片段。

    type 取值：
    - "token": 文本增量，content 字段有值
    - "tool_call": LLM 请求调用工具，tool_call 字段有值
    - "done": 流结束，usage 字段有 token 统计

    对应 TS 的 StreamChunk interface。
    """

    type: str
    content: str | None = None
    tool_call: dict | None = None
    usage: dict | None = None


class ChatSyncResult(BaseModel):
    """非流式调用的返回结果。

    对应 TS 的 ChatSyncResult interface。
    """

    content: str
    usage: dict


class ChatRequest(BaseModel):
    """客户端发送的聊天请求。

    这一版只做单轮对话：用户发一句话 → LLM 流式返回。
    model 可选，不传则用 DEFAULT_MODEL。
    """

    message: str = Field(..., min_length=1, description="用户消息")
    model: str | None = Field(default=None, description="模型 ID，不传则用默认模型")
