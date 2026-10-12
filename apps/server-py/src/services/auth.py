"""Public authentication with existing database and credential compatibility."""

import asyncio
import hashlib
import hmac
import time
import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
from fastapi import HTTPException
from jose import jwt
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.lib.auth import decode_access_token, decode_token
from src.models.auth import ApiKey, RefreshToken
from src.models.user import User

ACCESS_TOKEN_TTL = 15 * 60
REFRESH_TOKEN_TTL = 7 * 24 * 3600


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    # bcryptjs truncates UTF-8 input at 72 bytes; preserve existing login semantics.
    return bcrypt.hashpw(password.encode()[:72], bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, stored_hash: str | None) -> tuple[bool, bool]:
    if not stored_hash:
        return False, False
    if stored_hash.startswith("$2"):
        try:
            return bcrypt.checkpw(password.encode()[:72], stored_hash.encode()), False
        except ValueError:
            return False, False
    salt, separator, digest = stored_hash.partition(":")
    if not separator:
        return False, False
    computed = hashlib.sha256((salt + password).encode()).hexdigest()
    valid = hmac.compare_digest(computed.encode(), digest.encode())
    return valid, valid


def user_dto(user: User) -> dict:
    return {"id": user.id, "email": user.email, "role": user.role}


def _create_tokens(user: User) -> dict:
    now = int(time.time())
    identity = {"sub": user.id, "email": user.email, "role": user.role}

    def encode(token_type: str, ttl: int) -> str:
        return jwt.encode(
            {**identity, "type": token_type, "jti": str(uuid.uuid4()), "iat": now, "exp": now + ttl},
            settings.jwt_secret, algorithm="HS256",
        )

    return {
        "user": user_dto(user),
        "accessToken": encode("access", ACCESS_TOKEN_TTL),
        "refreshToken": encode("refresh", REFRESH_TOKEN_TTL),
    }


def _store_tokens(db: AsyncSession, user: User) -> dict:
    tokens = _create_tokens(user)
    db.add(RefreshToken(
        id=str(uuid.uuid4()), user_id=user.id,
        token_hash=hash_token(tokens["refreshToken"]),
        expires_at=datetime.now(UTC) + timedelta(seconds=REFRESH_TOKEN_TTL),
    ))
    return tokens


async def sign_up(db: AsyncSession, email: str, password: str) -> dict:
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(400, "Email already registered")
    password_hash = await asyncio.to_thread(hash_password, password)
    user = User(id=str(uuid.uuid4()), email=email, password_hash=password_hash, role="user")
    db.add(user)
    try:
        await db.flush()
        tokens = _store_tokens(db, user)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Only a duplicate email is a client error; do not mask schema/FK failures.
        if await db.scalar(select(User.id).where(User.email == email)):
            raise HTTPException(400, "Email already registered") from None
        raise
    return tokens


async def sign_in(db: AsyncSession, email: str, password: str) -> dict:
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        raise HTTPException(401, "Invalid email or password")
    valid, upgrade = await asyncio.to_thread(verify_password, password, user.password_hash)
    if not valid:
        raise HTTPException(401, "Invalid email or password")
    if upgrade:
        user.password_hash = await asyncio.to_thread(hash_password, password)
    tokens = _store_tokens(db, user)
    await db.commit()
    return tokens


async def refresh_access_token(db: AsyncSession, token: str) -> dict:
    payload = decode_token(token, "refresh")
    if payload is None:
        raise HTTPException(401, "Invalid refresh token")
    # Claim and revoke in one statement: only one concurrent request can rotate.
    claimed = await db.scalar(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == hash_token(token),
            RefreshToken.user_id == payload["sub"],
            RefreshToken.revoked.is_(False),
            RefreshToken.expires_at > datetime.now(UTC),
        )
        .values(revoked=True)
        .returning(RefreshToken.user_id)
    )
    if claimed is None:
        await db.rollback()
        raise HTTPException(401, "Refresh token revoked or expired")
    user = await db.get(User, claimed)
    if user is None:
        await db.rollback()
        raise HTTPException(401, "User not found")
    tokens = _store_tokens(db, user)
    await db.commit()
    return tokens


async def authenticate(db: AsyncSession, token: str) -> User | None:
    payload = decode_access_token(token)
    if payload is not None:
        return await db.get(User, payload["sub"])
    if not token.startswith("af_"):
        return None
    now = datetime.now(UTC)
    key = await db.scalar(select(ApiKey).where(
        ApiKey.key_hash == hash_token(token), ApiKey.revoked.is_(False),
        or_(ApiKey.expires_at.is_(None), ApiKey.expires_at > now),
    ))
    if key is None:
        return None
    user = await db.get(User, key.user_id)
    if user is None:
        return None
    key.last_used = now
    await db.commit()
    return user


async def sign_out(db: AsyncSession, user: User) -> dict:
    # The SDK sends its access token on signout, not its refresh token.
    await db.execute(update(RefreshToken).where(
        RefreshToken.user_id == user.id, RefreshToken.revoked.is_(False),
    ).values(revoked=True))
    await db.commit()
    return {"status": "ok"}


async def create_api_key(db: AsyncSession, user: User, name: str) -> dict:
    key_id, key = str(uuid.uuid4()), f"af_{uuid.uuid4().hex}"
    db.add(ApiKey(id=key_id, user_id=user.id, name=name, key_hash=hash_token(key)))
    await db.commit()
    return {"id": key_id, "key": key, "name": name}


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def list_api_keys(db: AsyncSession, user: User) -> list[dict]:
    keys = await db.scalars(
        select(ApiKey).where(ApiKey.user_id == user.id, ApiKey.revoked.is_(False))
        .order_by(ApiKey.created_at.desc(), ApiKey.id.desc()),
    )
    return [
        {
            "id": key.id, "name": key.name, "last_used": _timestamp(key.last_used),
            "expires_at": _timestamp(key.expires_at), "created_at": _timestamp(key.created_at),
        }
        for key in keys
    ]


async def revoke_api_key(db: AsyncSession, user: User, key_id: str) -> dict:
    revoked = await db.scalar(
        update(ApiKey).where(
            ApiKey.id == key_id, ApiKey.user_id == user.id, ApiKey.revoked.is_(False),
        ).values(revoked=True).returning(ApiKey.id),
    )
    if revoked is None:
        raise HTTPException(404, "API key not found")
    await db.commit()
    return {"status": "revoked"}
