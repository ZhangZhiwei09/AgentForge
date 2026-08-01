"""通用 Schema —— 供多个模块复用的基础模型。"""

from pydantic import BaseModel


class ErrorResponse(BaseModel):
    """标准错误响应格式，对应 TS HTTPException 的 JSON body。"""

    detail: str
