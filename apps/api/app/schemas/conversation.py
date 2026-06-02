from datetime import datetime
from pydantic import BaseModel, Field
from typing import Optional


class ConversationOut(BaseModel):
    id: str
    title: str
    user_id: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CreateConversationDTO(BaseModel):
    title: str = Field(default="New Conversation", max_length=255)


class UpdateConversationDTO(BaseModel):
    title: Optional[str] = Field(default=None, max_length=255)
