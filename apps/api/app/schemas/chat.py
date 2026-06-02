from pydantic import BaseModel, Field
from typing import Optional


class ChatRequest(BaseModel):
    conversation_id: str
    message: str = Field(..., min_length=1)
    model: Optional[str] = None


class ChatStreamChunk(BaseModel):
    type: str
    content: Optional[str] = None
    message_id: Optional[str] = None
    model: Optional[str] = None
    usage: Optional[dict] = None
