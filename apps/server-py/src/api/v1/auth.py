"""Public auth endpoints preserving the frontend SDK contract."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.config import settings
from src.models.user import User
from src.schemas.user import (
    ApiKeyRequest,
    RefreshRequest,
    SignInRequest,
    SignUpRequest,
    TokenResponse,
)
from src.services import auth
from src.services.auth import _create_tokens  # noqa: F401 - existing internal import compatibility

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=TokenResponse, status_code=201)
async def signup(body: SignUpRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    if not settings.auth_signup_enabled:
        raise HTTPException(403, "注册已关闭，请联系管理员创建账户")
    return await auth.sign_up(db, body.email, body.password)


@router.post("/signin", response_model=TokenResponse)
async def signin(body: SignInRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    return await auth.sign_in(db, body.email, body.password)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    return await auth.refresh_access_token(db, body.refresh_token)


@router.post("/signout")
async def signout(
    user: Annotated[User, Depends(get_current_user)], db: Annotated[AsyncSession, Depends(get_db)],
):
    return await auth.sign_out(db, user)


@router.get("/me")
async def me(user: Annotated[User, Depends(get_current_user)]):
    return auth.user_dto(user)


@router.post("/api-keys", status_code=201)
async def create_api_key(
    body: ApiKeyRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    return await auth.create_api_key(db, user, body.name)


@router.get("/api-keys")
async def list_api_keys(
    user: Annotated[User, Depends(get_current_user)], db: Annotated[AsyncSession, Depends(get_db)],
):
    return await auth.list_api_keys(db, user)


@router.delete("/api-keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    return await auth.revoke_api_key(db, user, key_id)
