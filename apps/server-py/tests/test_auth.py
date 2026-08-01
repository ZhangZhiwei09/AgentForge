"""测试：JWT 认证模块 (Step 5)。"""

import time

import pytest
from jose import jwt

from src.api.v1.auth import _create_tokens
from src.config import settings
from src.lib.auth import decode_access_token
from src.models.user import User


def _make_token(payload: dict, expires_in: int = 3600) -> str:
    """辅助函数：签发测试 Token。"""
    data = payload.copy()
    data.setdefault("iat", int(time.time()))
    data.setdefault("exp", int(time.time()) + expires_in)
    return jwt.encode(data, settings.jwt_secret, algorithm="HS256")


class TestJWT:
    """JWT 解码验证测试。"""

    def test_decode_valid_token(self):
        """有效 token 应正确解码。"""
        payload = {"sub": "user-123", "email": "test@example.com", "role": "user", "type": "access"}
        token = _make_token(payload)
        decoded = decode_access_token(token)
        assert decoded is not None
        assert decoded["sub"] == "user-123"
        assert decoded["email"] == "test@example.com"

    def test_decode_expired_token(self):
        """过期 token 应返回 None。"""
        payload = {"sub": "user-123", "type": "access"}
        token = _make_token(payload, expires_in=-1)
        decoded = decode_access_token(token)
        assert decoded is None

    def test_decode_invalid_token(self):
        """无效 token 应返回 None。"""
        decoded = decode_access_token("not-a-valid-token")
        assert decoded is None

    def test_decode_wrong_type(self):
        """type 不是 'access' 应返回 None。"""
        payload = {"sub": "user-123", "type": "refresh"}
        token = _make_token(payload)
        decoded = decode_access_token(token)
        assert decoded is None

    def test_decode_empty_token(self):
        """空字符串应返回 None。"""
        assert decode_access_token("") is None


class TestCreateTokensContract:
    """认证响应契约：必须 camelCase，匹配前端 SDK AuthResponse。

    snake_case（access_token）会让前端 LoginPage 读到 undefined，存入
    localStorage 的字符串 "undefined"，后续请求 `Bearer undefined` → 401。
    """

    def test_returns_camelcase_keys(self):
        user = User(id="u-1", email="a@b.c", password_hash="x", role="user")
        tokens = _create_tokens(user)
        assert set(tokens) == {"user", "accessToken", "refreshToken"}
        assert "access_token" not in tokens
        assert "refresh_token" not in tokens
        assert tokens["user"] == {"id": "u-1", "email": "a@b.c", "role": "user"}
        # token 可被本服务自身解码（同一 jwt_secret）
        decoded = decode_access_token(tokens["accessToken"])
        assert decoded is not None and decoded["sub"] == "u-1"
