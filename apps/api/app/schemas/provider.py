from pydantic import BaseModel
from typing import Optional


class ProviderInfo(BaseModel):
    type: str
    models: list[dict]
