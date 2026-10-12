"""HS256 credential verification, compatible with existing public API tokens."""

from jose import JWTError, jwt

from src.config import settings


def decode_token(token: str, token_type: str) -> dict | None:
    try:
        payload: dict = jwt.decode(
            token, settings.jwt_secret, algorithms=["HS256"],
            options={"require_exp": True, "require_sub": True},
        )
        if payload.get("type") != token_type or not payload.get("sub"):
            return None
        return payload
    except (JWTError, ValueError, TypeError):
        return None


def decode_access_token(token: str) -> dict | None:
    return decode_token(token, "access")
