"""认证工具 —— 验证 TS 端签发的 JWT Token。

本模块不做密码哈希，不做 signup/signin。
用户注册/登录由 TS 端负责，Python 端只验证 Token 有效性。

TS 端 JWT payload 格式（apps/server/src/services/auth.ts）：
    { sub, email, role, jti, iat, exp, type: "access" | "refresh" }

两端共享同一个 JWT_SECRET 环境变量。
"""

from jose import JWTError, jwt

from src.config import settings


def decode_access_token(token: str) -> dict | None:
    """验证并解码 TS 端签发的 JWT access token。

    验证签名（HMAC-SHA256）和过期时间，
    并检查 type == "access"（拒绝 refresh token 用于认证）。

    Returns:
        payload dict on success，None on any failure（签名不对/过期/type 不对）。
    """
    try:
        payload: dict = jwt.decode(
            token, settings.jwt_secret, algorithms=["HS256"]
        )
        if payload.get("type") != "access":
            return None
        return payload
    except JWTError:
        return None
