from datetime import datetime
from pydantic import BaseModel, Field


class UserOut(BaseModel):
    id: str
    email: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CreateUserDTO(BaseModel):
    email: str = Field(..., max_length=255)
