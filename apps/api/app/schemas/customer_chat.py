from pydantic import BaseModel, Field
from typing import Optional

class CustomerChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str = Field(..., min_length=1)