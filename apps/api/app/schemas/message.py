from datetime import datetime
from pydantic import BaseModel


class MessageOut(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    model: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class CreateMessageDTO(BaseModel):
    role: str
    content: str
    model: str | None = None
