"""Public auth lifecycle against an isolated SQL database, without a TS server."""

import asyncio
import hashlib
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from jose import jwt
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.deps import get_db
from src.config import settings
from src.main import create_app
from src.models.auth import ApiKey, RefreshToken
from src.models.base import Base
from src.models.user import User
from src.services import auth
from src.services.auth import hash_token


@pytest_asyncio.fixture
async def auth_api(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'auth.db').as_posix()}")

    @event.listens_for(engine.sync_engine, "connect")
    def enable_foreign_keys(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(
            lambda sync: Base.metadata.create_all(
                sync, tables=[User.__table__, RefreshToken.__table__, ApiKey.__table__],
            ),
        )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app()

    async def isolated_db():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = isolated_db
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        ) as client:
            yield client, sessions
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def register(client, email="demo@agentforge.local"):
    response = await client.post("/api/auth/signup", json={"email": email, "password": "password-123"})
    assert response.status_code == 201, response.text
    result = response.json()
    assert set(result) == {"user", "accessToken", "refreshToken"}
    return result


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


async def test_signup_signin_and_persisted_refresh_rotation(auth_api):
    client, sessions = auth_api
    initial = await register(client)
    assert initial["user"]["role"] == "user"
    access = jwt.decode(initial["accessToken"], settings.jwt_secret, algorithms=["HS256"])
    assert access["exp"] - access["iat"] == 900
    assert access["jti"]

    async with sessions() as db:
        stored = await db.scalar(select(RefreshToken))
        assert stored.user_id == initial["user"]["id"]
        assert stored.token_hash == hash_token(initial["refreshToken"])
        assert stored.token_hash != initial["refreshToken"]
        user = await db.get(User, stored.user_id)
        assert user.password_hash.startswith("$2")

    me = await client.get("/api/auth/me", headers=bearer(initial["accessToken"]))
    assert me.json() == initial["user"]
    duplicate = await client.post(
        "/api/auth/signup", json={"email": initial["user"]["email"], "password": "different"},
    )
    assert duplicate.status_code == 400
    wrong = await client.post(
        "/api/auth/signin", json={"email": initial["user"]["email"], "password": "wrong"},
    )
    assert wrong.status_code == 401
    signed_in = await client.post(
        "/api/auth/signin", json={"email": initial["user"]["email"], "password": "password-123"},
    )
    assert signed_in.status_code == 200
    assert signed_in.json()["refreshToken"] != initial["refreshToken"]

    rotated = await client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]})
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["user"] == initial["user"]
    assert rotated.json()["refreshToken"] != initial["refreshToken"]
    replay = await client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]})
    assert replay.status_code == 401
    async with sessions() as db:
        old = await db.scalar(select(RefreshToken).where(
            RefreshToken.token_hash == hash_token(initial["refreshToken"]),
        ))
        assert old.revoked is True


async def test_concurrent_refresh_has_one_winner(auth_api):
    client, sessions = auth_api
    initial = await register(client)
    responses = await asyncio.gather(
        client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]}),
        client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]}),
    )
    assert sorted(response.status_code for response in responses) == [200, 401]
    winner = next(response.json() for response in responses if response.status_code == 200)
    async with sessions() as db:
        active = list(await db.scalars(select(RefreshToken).where(RefreshToken.revoked.is_(False))))
        assert len(active) == 1
        assert active[0].token_hash == hash_token(winner["refreshToken"])


async def test_failed_rotation_rolls_back_claim_before_retry(auth_api, monkeypatch):
    client, sessions = auth_api
    initial = await register(client)

    def fail_to_store(_db, _user):
        raise RuntimeError("simulated persistence failure")

    with monkeypatch.context() as patch:
        patch.setattr(auth, "_store_tokens", fail_to_store)
        with pytest.raises(RuntimeError, match="simulated persistence failure"):
            await client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]})
    async with sessions() as db:
        stored = await db.scalar(select(RefreshToken))
        assert stored.revoked is False
    retry = await client.post("/api/auth/refresh", json={"refresh_token": initial["refreshToken"]})
    assert retry.status_code == 200


async def test_concurrent_signup_creates_one_account(auth_api):
    client, sessions = auth_api
    responses = await asyncio.gather(*[
        client.post(
            "/api/auth/signup", json={"email": "same@example.com", "password": "password"},
        )
        for _ in range(2)
    ])
    assert sorted(response.status_code for response in responses) == [201, 400]
    async with sessions() as db:
        assert len(list(await db.scalars(select(User)))) == 1
        assert len(list(await db.scalars(select(RefreshToken)))) == 1


async def test_sdk_signout_revokes_refresh_sessions_for_only_current_user(auth_api):
    client, sessions = auth_api
    initial = await register(client)
    other = await register(client, "other@example.com")
    again = await client.post(
        "/api/auth/signin", json={"email": initial["user"]["email"], "password": "password-123"},
    )
    signout = await client.post("/api/auth/signout", headers=bearer(initial["accessToken"]))
    assert signout.json() == {"status": "ok"}
    for tokens in (initial, again.json()):
        assert (await client.post(
            "/api/auth/refresh", json={"refresh_token": tokens["refreshToken"]},
        )).status_code == 401
    assert (await client.post(
        "/api/auth/refresh", json={"refresh_token": other["refreshToken"]},
    )).status_code == 200
    async with sessions() as db:
        assert not list(await db.scalars(select(RefreshToken).where(
            RefreshToken.user_id == initial["user"]["id"], RefreshToken.revoked.is_(False),
        )))


async def test_refresh_requires_stored_unexpired_matching_user_token(auth_api):
    client, sessions = auth_api
    initial = await register(client)
    assert (await client.post(
        "/api/auth/refresh", json={"refresh_token": initial["accessToken"]},
    )).status_code == 401
    now = int(time.time())
    unstored = jwt.encode(
        {"sub": initial["user"]["id"], "type": "refresh", "iat": now, "exp": now + 60},
        settings.jwt_secret, algorithm="HS256",
    )
    assert (await client.post(
        "/api/auth/refresh", json={"refresh_token": unstored},
    )).status_code == 401
    async with sessions() as db:
        await db.execute(update(RefreshToken).values(
            expires_at=datetime.now(UTC) - timedelta(seconds=10),
        ))
        await db.commit()
    assert (await client.post(
        "/api/auth/refresh", json={"refresh_token": initial["refreshToken"]},
    )).status_code == 401


async def test_existing_ts_refresh_token_rotates_and_legacy_password_upgrades(auth_api):
    client, sessions = auth_api
    password, salt = "legacy-password", "legacy-salt"
    legacy_hash = f"{salt}:{hashlib.sha256((salt + password).encode()).hexdigest()}"
    now = int(time.time())
    token = jwt.encode(
        {"sub": "legacy-user", "email": "", "role": "", "jti": "ts-token",
         "type": "refresh", "iat": now, "exp": now + 3600},
        settings.jwt_secret, algorithm="HS256",
    )
    async with sessions() as db:
        db.add(User(
            id="legacy-user", email="legacy@example.com", password_hash=legacy_hash, role="admin",
        ))
        await db.flush()
        db.add(RefreshToken(
            id="ts-refresh-row", user_id="legacy-user", token_hash=hash_token(token),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        ))
        await db.commit()
    rotated = await client.post("/api/auth/refresh", json={"refresh_token": token})
    assert rotated.status_code == 200
    assert rotated.json()["user"]["role"] == "admin"
    login = await client.post(
        "/api/auth/signin", json={"email": "legacy@example.com", "password": password},
    )
    assert login.status_code == 200
    async with sessions() as db:
        user = await db.get(User, "legacy-user")
        assert user.password_hash.startswith("$2")
    assert (await client.post(
        "/api/auth/signin", json={"email": "legacy@example.com", "password": password},
    )).status_code == 200


@pytest.mark.parametrize("stored_hash", [None, "", "invalid", "$2b$malformed", "salt:bad-hash"])
async def test_users_without_valid_password_hash_cannot_login(auth_api, stored_hash):
    client, sessions = auth_api
    async with sessions() as db:
        db.add(User(id="no-password", email="missing@example.com", password_hash=stored_hash, role="user"))
        await db.commit()
    response = await client.post(
        "/api/auth/signin", json={"email": "missing@example.com", "password": "anything"},
    )
    assert response.status_code == 401
    async with sessions() as db:
        assert not list(await db.scalars(select(RefreshToken)))


async def test_api_key_lifecycle_hash_storage_and_ownership(auth_api):
    client, sessions = auth_api
    owner = await register(client)
    other = await register(client, "other@example.com")
    created = await client.post(
        "/api/auth/api-keys", json={"name": "migration test"}, headers=bearer(owner["accessToken"]),
    )
    assert created.status_code == 201, created.text
    key = created.json()
    assert key["key"].startswith("af_")
    assert set(key) == {"key", "id", "name"}
    async with sessions() as db:
        stored = await db.get(ApiKey, key["id"])
        assert stored.key_hash == hash_token(key["key"])
        assert stored.last_used is None

    assert (await client.get("/api/auth/me", headers=bearer(key["key"]))).json() == owner["user"]
    assert (await client.get("/api/agent-flows", headers=bearer(key["key"]))).status_code == 403
    assert (await client.get("/api/auth/me", params={"api_key": key["key"]})).json() == owner["user"]
    listed = await client.get("/api/auth/api-keys", headers=bearer(owner["accessToken"]))
    item = listed.json()[0]
    assert set(item) == {"id", "name", "last_used", "expires_at", "created_at"}
    assert item["last_used"].endswith("Z")
    assert item["expires_at"] is None
    assert (await client.get(
        "/api/auth/api-keys", headers=bearer(other["accessToken"]),
    )).json() == []
    forbidden = await client.delete(
        f"/api/auth/api-keys/{key['id']}", headers=bearer(other["accessToken"]),
    )
    assert forbidden.status_code == 404
    assert (await client.get("/api/auth/me", headers=bearer(key["key"]))).status_code == 200
    revoked = await client.delete(
        f"/api/auth/api-keys/{key['id']}", headers=bearer(owner["accessToken"]),
    )
    assert revoked.json() == {"status": "revoked"}
    assert (await client.get("/api/auth/me", headers=bearer(key["key"]))).status_code == 401
    assert (await client.get(
        "/api/auth/api-keys", headers=bearer(owner["accessToken"]),
    )).json() == []


async def test_expired_api_key_and_deleted_user_are_rejected(auth_api):
    client, sessions = auth_api
    owner = await register(client)
    created = await client.post(
        "/api/auth/api-keys", json={"name": "expired"}, headers=bearer(owner["accessToken"]),
    )
    key = created.json()
    async with sessions() as db:
        await db.execute(update(ApiKey).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await db.commit()
    assert (await client.get("/api/auth/me", headers=bearer(key["key"]))).status_code == 401
    async with sessions() as db:
        user = await db.get(User, owner["user"]["id"])
        await db.delete(user)
        await db.commit()
    assert (await client.get("/api/auth/me", headers=bearer(owner["accessToken"]))).status_code == 401


@pytest.mark.parametrize("path", ["/api/auth/me", "/api/auth/api-keys", "/api/agent-flows"])
async def test_protected_routes_reject_missing_and_refresh_credentials(auth_api, path):
    client, _ = auth_api
    assert (await client.get(path)).status_code == 401
    tokens = await register(client)
    assert (await client.get(path, headers=bearer(tokens["refreshToken"]))).status_code == 401
    assert (await client.get(path, headers=bearer("invalid"))).status_code == 401


@pytest.mark.parametrize("path,body", [
    ("/api/auth/signup", {"email": "bad-email", "password": "password"}),
    ("/api/auth/signup", {"email": "valid@example.com", "password": "short"}),
    ("/api/auth/signin", {"email": "valid@example.com", "password": ""}),
    ("/api/auth/refresh", {"refresh_token": ""}),
])
async def test_auth_inputs_are_validated(auth_api, path, body):
    client, _ = auth_api
    assert (await client.post(path, json=body)).status_code == 422


async def test_cors_request_ids_and_empty_api_key_name(auth_api):
    client, _ = auth_api
    tokens = await register(client)
    invalid = await client.post(
        "/api/auth/api-keys", json={"name": ""}, headers=bearer(tokens["accessToken"]),
    )
    assert invalid.status_code == 422
    response = await client.get(
        "/api/health", headers={"Origin": "http://localhost:5200", "X-Request-ID": "migration-check"},
    )
    assert response.json() == {"status": "ok"}
    assert response.headers["x-request-id"] == "migration-check"
    assert response.headers["access-control-allow-origin"] == "http://localhost:5200"
    assert (await client.get("/api/health")).headers["x-request-id"]
    forbidden = await client.get("/api/health", headers={"Origin": "https://untrusted.example"})
    assert "access-control-allow-origin" not in forbidden.headers
    preflight = await client.options("/api/auth/signin", headers={
        "Origin": "http://localhost:5200", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization,x-request-id",
    })
    assert preflight.status_code == 200
