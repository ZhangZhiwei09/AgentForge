"""Auth 端点 —— 最小化实现，仅用于本地测试。

正式架构：认证由 TS 端负责，Python 只做 LLM + Agent Runtime。
此文件是开发环境下的实用妥协，生产环境应禁用。
"""

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from jose import jwt
import bcrypt as _bcrypt
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.config import settings
from src.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignUpRequest(BaseModel):
    email: str
    password: str = Field(min_length=6)


class SignInRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: dict


def _create_tokens(user: User) -> dict:
    now = int(time.time())
    access_payload = {
        "sub": user.id, "email": user.email, "role": user.role,
        "type": "access", "iat": now, "exp": now + 3600,
    }
    refresh_payload = {
        "sub": user.id, "type": "refresh", "iat": now, "exp": now + 86400 * 7,
    }
    return {
        "access_token": jwt.encode(access_payload, settings.jwt_secret, algorithm="HS256"),
        "refresh_token": jwt.encode(refresh_payload, settings.jwt_secret, algorithm="HS256"),
        "user": {"id": user.id, "email": user.email, "role": user.role},
    }


@router.post("/signup", response_model=TokenResponse)
async def signup(body: SignUpRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(id=str(uuid.uuid4()), email=body.email,
                password_hash=_bcrypt.hashpw(body.password.encode(), _bcrypt.gensalt()).decode(), role="user")
    db.add(user)
    await db.commit()
    return _create_tokens(user)


@router.post("/signin", response_model=TokenResponse)
async def signin(body: SignInRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user.password_hash and not _bcrypt.checkpw(body.password.encode(), user.password_hash.encode()):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return _create_tokens(user)


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "email": user.email, "role": user.role}
