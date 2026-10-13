"""FastAPI 依赖注入 —— 提供 get_db 和 get_current_user。

TS 端使用全局中间件 + 白名单模式：
    app.use("*", authMiddleware)  →  c.set("user", user)

Python 端使用按路由显式声明依赖：
    @router.get("/me")
    async def me(user: User = Depends(get_current_user)): ...

这是 FastAPI 的风格——不走全局中间件，每个需要认证的路由自己声明 Depends。
"""

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.db import async_session
from src.models.user import User
from src.services.auth import authenticate

# ---- Token 提取器 ----
# HTTPBearer 自动从 Authorization: Bearer <token> 头提取 token
# 缺少凭证由依赖统一返回 401；兼容已有 api_key 查询参数。
security = HTTPBearer(auto_error=False)
ANONYMOUS_USER_ID = "00000000-0000-0000-0000-000000000002"


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
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """从 Bearer Token 解析当前用户。

    流程：提取 token → 验证 JWT → 查数据库 → 返回 User ORM 对象。
    任何一步失败都返回 401。

    用法：
        @router.get("/me")
        async def me(user: User = Depends(get_current_user)):
            return {"id": user.id, "email": user.email}
    """
    token = credentials.credentials if credentials else request.query_params.get("api_key")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized - missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = await authenticate(db, token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    return user


async def get_chat_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Public chat retains the legacy actor; invalid credentials never become anonymous."""
    if "authorization" in request.headers or "api_key" in request.query_params:
        if "authorization" in request.headers and credentials is None:
            raise HTTPException(401, "Invalid authorization header")
        return await get_current_user(request, credentials, db)

    user = await db.get(User, ANONYMOUS_USER_ID)
    if user is None:
        try:
            async with db.begin_nested():
                db.add(User(
                    id=ANONYMOUS_USER_ID, email="customer@agentforge.local", role="user",
                ))
                await db.flush()
        except IntegrityError:
            # Another request may have created the reserved actor concurrently.
            user = await db.get(User, ANONYMOUS_USER_ID)
            if user is None:
                raise HTTPException(503, "匿名会话身份配置冲突，请联系管理员") from None
        await db.commit()
        user = await db.get(User, ANONYMOUS_USER_ID)
    return user
