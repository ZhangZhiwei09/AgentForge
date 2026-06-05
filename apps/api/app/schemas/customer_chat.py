from pydantic import BaseModel, Field

class CustomerChatRequest(BaseModel):
    message: str = Field(..., min_length=1)