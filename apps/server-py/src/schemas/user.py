"""用户相关 Schema —— 请求/响应的 Pydantic 模型。

对应 TS packages/shared-types/src/user.ts 中的类型定义。
Pydantic 的 EmailStr 自动校验 email 格式，Field 控制约束。
"""

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class SignUpRequest(BaseModel):
    """注册请求，对应 TS signUpSchema。"""

    email: EmailStr
    password: str = Field(min_length=6, description="密码最少 6 位")


class SignInRequest(BaseModel):
    """登录请求，对应 TS signInSchema。"""

    email: EmailStr
    password: str = Field(min_length=1)


class UserResponse(BaseModel):
    """用户信息响应，对应 TS AuthUser + User。"""

    id: str
    email: str
    role: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}  # 允许从 ORM 对象直接构造


class TokenResponse(BaseModel):
    """认证令牌响应，对应 TS AuthResponse。"""

    access_token: str
    refresh_token: str
