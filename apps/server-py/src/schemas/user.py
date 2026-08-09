"""用户相关 Schema —— 请求/响应的 Pydantic 模型。

对应 TS packages/shared-types/src/user.ts 中的类型定义。
Pydantic 的 EmailStr 自动校验 email 格式，Field 控制约束。
"""

from pydantic import BaseModel, Field


class SignUpRequest(BaseModel):
    """注册请求，对应 TS signUpSchema。

    注意：email 用 str 而非 EmailStr —— pydantic EmailStr 拒绝 `.local` 等
    特殊用途域名，而前端默认登录账号 demo@agentforge.local 正属此类；TS 端
    zod z.string().email() 允许该域名。这里保持与 TS 一致。
    """

    email: str
    password: str = Field(min_length=6, description="密码最少 6 位")


class SignInRequest(BaseModel):
    """登录请求，对应 TS signInSchema。"""

    email: str
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    """认证令牌响应，对应 TS AuthResponse。

    字段名必须与前端 SDK 契约一致（camelCase）：前端读 result.accessToken /
    result.refreshToken，snake_case 会导致 localStorage 存入字符串 "undefined"，
    后续请求带 `Bearer undefined` 而 401。
    """

    user: dict
    accessToken: str
    refreshToken: str
