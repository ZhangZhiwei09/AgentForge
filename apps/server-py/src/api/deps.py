"""FastAPI 依赖注入 —— 提供 get_db 和 get_current_user。

TS 端使用全局中间件 + 白名单模式：
    app.use("*", authMiddleware)  →  c.set("user", user)

Python 端使用按路由显式声明依赖：
    @router.get("/me")
    async def me(user: User = Depends(get_current_user)): ...

这是 FastAPI 的风格——不走全局中间件，每个需要认证的路由自己声明 Depends。
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db import async_session
from src.lib.auth import decode_access_token
from src.models.user import User

# ---- Token 提取器 ----
# HTTPBearer 自动从 Authorization: Bearer <token> 头提取 token
# 如果请求没有 Bearer token，FastAPI 自动返回 403
security = HTTPBearer()


# ---- 数据库会话 ----
async def get_db():
    """每个请求分配一个 DB 会话，请求结束时自动回收。

    用 async generator（yield）而非 return：
    yield 之前的代码在请求开始时执行，
    yield 之后的代码在请求结束时执行（自动 close session）。
    """
    async with async_session() as session:
        yield session


# ---- 当前用户 ----
async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """从 Bearer Token 解析当前用户。

    流程：提取 token → 验证 JWT → 查数据库 → 返回 User ORM 对象。
    任何一步失败都返回 401。

    用法：
        @router.get("/me")
        async def me(user: User = Depends(get_current_user)):
            return {"id": user.id, "email": user.email}
    """
    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    result = await db.execute(select(User).where(User.id == payload["sub"]))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    return user
