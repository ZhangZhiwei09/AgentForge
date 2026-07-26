"""Dev-only endpoints —— 仅用于本地测试，生产环境禁用。"""

import time

from fastapi import APIRouter
from jose import jwt

from src.config import settings

router = APIRouter(prefix="/api/dev", tags=["dev"])


@router.get("/token")
async def dev_token():
    """生成测试用 JWT Token（仅本地开发）。

    生产环境应通过环境变量或配置禁用此端点。
    """
    if not settings.debug:
        return {"error": "Dev endpoints are disabled when DEBUG=false"}

    payload = {
        "sub": "test-user-001",
        "email": "test@agentforge.io",
        "role": "user",
        "type": "access",
        "iat": int(time.time()),
        "exp": int(time.time()) + 86400,  # 24h
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    return {"token": token, "user": payload["email"], "expires_in": "24h"}
