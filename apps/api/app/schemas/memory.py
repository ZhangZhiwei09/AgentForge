from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class MemoryOut(BaseModel):
    id: str
    user_id: str
    type: str
    content: str
    importance: float
    meta_info: Optional[dict] = None
    conversation_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MemorySearchResult(MemoryOut):
    score: float = 0.0


class MemoryCreate(BaseModel):
    type: str = "semantic"
    content: str
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    conversation_id: Optional[str] = None
    meta_info: Optional[dict] = Field(default_factory=dict)
