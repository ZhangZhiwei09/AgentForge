"""PostgreSQL schema checks and isolated SQLite account provisioning tests."""

import asyncio
import json
import logging
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src import database
from src.database import BASELINE, create_admin, create_user, upgrade_connection
from src.models.auth import RefreshToken
from src.models.base import Base
from src.models.user import User
from src.services.auth import sign_in, verify_password

LATEST_HEAD = "20261013_support_tickets"


@pytest.mark.asyncio
async def test_fresh_bootstrap_is_complete_and_idempotent(empty_postgres):
    probe_logger = logging.getLogger("agentforge.bootstrap-probe")
    assert not probe_logger.disabled
    engine, _ = empty_postgres
    async with engine.begin() as connection:
        assert await connection.run_sync(upgrade_connection) == LATEST_HEAD
        names = await connection.run_sync(lambda sync: set(inspect(sync).get_table_names(
            schema=sync.dialect.default_schema_name,
        )))
        assert set(json.loads(BASELINE.read_text(encoding="utf-8"))["tables"]) <= names
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == LATEST_HEAD
        assert not probe_logger.disabled
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        user_id, created = await create_admin(db, "bootstrap@example.test", "test-password")
        assert created
    async with engine.begin() as connection:
        await connection.run_sync(upgrade_connection)
        assert await connection.scalar(text("SELECT id FROM users WHERE email='bootstrap@example.test'")) == user_id
        assert await connection.scalar(text("SELECT atttypmod FROM pg_attribute WHERE attrelid='knowledge_chunks'::regclass AND attname='embedding'")) == 1024
        await connection.execute(text("""
            INSERT INTO knowledge_bases (id, name) VALUES ('kb', 'Baseline defaults');
        """))
        assert await connection.scalar(text("SELECT enabled FROM knowledge_bases WHERE id='kb'")) is True


@pytest.mark.asyncio
async def test_adopts_existing_unversioned_schema_without_changing_data(empty_postgres):
    engine, _ = empty_postgres
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(text("INSERT INTO users (id, email, role) VALUES ('keep', 'keep@example.test', 'user')"))
    async with engine.begin() as connection:
        await connection.run_sync(upgrade_connection)
        assert await connection.scalar(text("SELECT email FROM users WHERE id='keep'")) == "keep@example.test"
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == LATEST_HEAD


@pytest.mark.asyncio
async def test_incompatible_adoption_rolls_back_stamp_and_ddl(empty_postgres):
    engine, _ = empty_postgres
    async with engine.begin() as connection:
        await connection.execute(text("CREATE TABLE users (id varchar(36) PRIMARY KEY, email varchar(255))"))
        await connection.execute(text("INSERT INTO users VALUES ('keep', 'keep@example.test')"))
    with pytest.raises(RuntimeError, match="Schema adoption refused"):
        async with engine.begin() as connection:
            await connection.run_sync(upgrade_connection)
    async with engine.connect() as connection:
        names = await connection.run_sync(lambda sync: set(inspect(sync).get_table_names(
            schema=sync.dialect.default_schema_name,
        )))
        assert "alembic_version" not in names and "knowledge_bases" not in names
        assert await connection.scalar(text("SELECT email FROM users WHERE id='keep'")) == "keep@example.test"


@pytest.mark.asyncio
async def test_bootstrap_ignores_tables_and_versions_in_other_visible_schemas(empty_postgres):
    engine, schema = empty_postgres
    shadow = f"{schema}_shadow"
    async with engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{shadow}"'))
        await connection.execute(text(f'CREATE TABLE "{shadow}".users (id text PRIMARY KEY, email text)'))
        await connection.execute(text(f"INSERT INTO \"{shadow}\".users VALUES ('keep', 'keep@example.test')"))
        await connection.execute(text(f'CREATE TABLE "{shadow}".alembic_version (version_num varchar(32) PRIMARY KEY)'))
        await connection.execute(text(f"INSERT INTO \"{shadow}\".alembic_version VALUES ('unrelated_revision')"))
        await connection.execute(
            text("SELECT set_config('search_path', :path, true)"),
            {"path": f"{schema},{shadow},public"},
        )
        assert await connection.run_sync(upgrade_connection) == LATEST_HEAD
        assert await connection.scalar(text("SELECT count(*) FROM users")) == 0
        assert await connection.scalar(text(f'SELECT email FROM "{shadow}".users')) == "keep@example.test"
        assert await connection.scalar(text(f'SELECT version_num FROM "{shadow}".alembic_version')) == "unrelated_revision"
        await connection.execute(text(f'DROP SCHEMA "{shadow}" CASCADE'))


@pytest.mark.asyncio
async def test_existing_legacy_stamp_is_preserved_then_upgraded(empty_postgres):
    engine, _ = empty_postgres
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(text("CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)"))
        await connection.execute(text("INSERT INTO alembic_version VALUES ('a3f2e1d0c9b8')"))
    async with engine.begin() as connection:
        await connection.run_sync(upgrade_connection)
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == LATEST_HEAD


@pytest.mark.asyncio
async def test_adopts_actual_prisma_migration_history(empty_postgres):
    engine, _ = empty_postgres
    migrations = Path(__file__).resolve().parents[3] / "packages/database/prisma/migrations"
    async with engine.begin() as connection:
        raw = await connection.get_raw_connection()
        for migration in sorted(migrations.glob("*/migration.sql")):
            await raw.driver_connection.execute(migration.read_text(encoding="utf-8"))
        await connection.execute(text("INSERT INTO users (id, email) VALUES ('legacy-user', 'legacy@example.local')"))
    async with engine.begin() as connection:
        await connection.run_sync(upgrade_connection)
        assert await connection.scalar(text("SELECT email FROM users WHERE id='legacy-user'")) == "legacy@example.local"


@pytest.mark.asyncio
async def test_create_admin_is_idempotent_and_never_resets_existing_users(entry_api):
    _, sessions = entry_api
    async with sessions() as db:
        user_id, created = await create_admin(db, "new-admin@example.test", "first-password")
        assert created
        second_id, created = await create_admin(db, "new-admin@example.test", "different-password")
        assert second_id == user_id and not created
        admin = await db.scalar(select(User).where(User.id == user_id))
        assert admin.role == "admin" and verify_password("first-password", admin.password_hash)[0]
        assert not verify_password("different-password", admin.password_hash)[0]
        with pytest.raises(ValueError, match="non-admin"):
            await create_admin(db, "user@example.test", "anything-new")


@pytest.fixture
def provisioning_url(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'accounts.db').as_posix()}"

    async def initialize():
        engine = create_async_engine(url)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(
                    lambda sync: Base.metadata.create_all(
                        sync, tables=[User.__table__, RefreshToken.__table__],
                    ),
                )
        finally:
            await engine.dispose()

    asyncio.run(initialize())
    return url


@pytest_asyncio.fixture
async def provisioning_sessions(provisioning_url):
    engine = create_async_engine(provisioning_url)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("provision,role", [(create_admin, "admin"), (create_user, "user")])
async def test_provisioned_account_uses_signin_password_hash(provisioning_sessions, provision, role):
    async with provisioning_sessions() as db:
        user_id, created = await provision(db, "operator@example.test", "first-password")
        assert created
    async with provisioning_sessions() as db:
        account = await db.get(User, user_id)
        assert account.role == role
        assert account.password_hash != "first-password"
        assert verify_password("first-password", account.password_hash)[0]
        result = await sign_in(db, account.email, "first-password")
        assert result["user"] == {"id": user_id, "email": account.email, "role": role}


@pytest.mark.parametrize("provision", [create_admin, create_user])
@pytest.mark.parametrize("repeat_password", ["different-password", "x"])
async def test_repeated_provisioning_preserves_all_account_data(
    provisioning_sessions, provision, repeat_password,
):
    async with provisioning_sessions() as db:
        user_id, _ = await provision(db, "repeat@example.test", "first-password")
        account = await db.get(User, user_id)
        account.avatar_url = "https://example.test/avatar.png"
        await db.commit()
        before = (await db.execute(select(User.__table__))).mappings().all()
    async with provisioning_sessions() as db:
        assert await provision(db, "repeat@example.test", repeat_password) == (user_id, False)
        await db.commit()
        after = (await db.execute(select(User.__table__))).mappings().all()
        assert after == before
        assert verify_password("first-password", after[0]["password_hash"])[0]


@pytest.mark.parametrize("provision,existing_role", [
    (create_user, "admin"), (create_user, "auditor"),
    (create_admin, "user"), (create_admin, "auditor"),
])
async def test_provisioning_role_conflict_leaves_database_unchanged(
    provisioning_sessions, provision, existing_role,
):
    async with provisioning_sessions() as db:
        db.add(User(
            id="retained", email="retained@example.test", role=existing_role,
            password_hash="retained-hash", avatar_url="https://example.test/avatar.png",
        ))
        await db.commit()
        before = (await db.execute(select(User.__table__))).mappings().all()
        with pytest.raises(ValueError, match="no account was changed"):
            await provision(db, "retained@example.test", "replacement-password")
        await db.commit()
    async with provisioning_sessions() as db:
        assert (await db.execute(select(User.__table__))).mappings().all() == before


@pytest.mark.parametrize("provision", [create_admin, create_user])
@pytest.mark.parametrize("email,password", [
    ("invalid-email", "valid-password"),
    (f"{'a' * 250}@example.test", "valid-password"),
    ("valid@example.test", ""),
    ("valid@example.test", "short"),
])
async def test_invalid_provisioning_input_writes_nothing(provisioning_sessions, provision, email, password):
    async with provisioning_sessions() as db:
        with pytest.raises(ValueError):
            await provision(db, email, password)
        await db.commit()
    async with provisioning_sessions() as db:
        assert list(await db.scalars(select(User))) == []


async def _provisioned_rows(url):
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            return (await connection.execute(select(User.__table__))).mappings().all()
    finally:
        await engine.dispose()


@pytest.fixture
def account_cli(monkeypatch, provisioning_url):
    from src import dev

    # Exercise the real CLI/session code without loading operator .env files.
    monkeypatch.setattr(dev, "platform_environment", lambda *args, **kwargs: {"DATABASE_URL": provisioning_url})
    for name in ("AGENTFORGE_USER_PASSWORD", "AGENTFORGE_ADMIN_PASSWORD", "TEST_ACCOUNT_PASSWORD"):
        monkeypatch.delenv(name, raising=False)

    def unexpected_prompt(prompt):
        pytest.fail(f"Unexpected hidden password prompt: {prompt}")

    monkeypatch.setattr(database.getpass, "getpass", unexpected_prompt)

    def run(action, *arguments):
        monkeypatch.setattr(sys, "argv", ["src.database", action, "--email", "cli@example.test", *arguments])
        database.main()

    return run


@pytest.mark.parametrize("action,role,label,default_env", [
    ("create-user", "user", "User", "AGENTFORGE_USER_PASSWORD"),
    ("create-admin", "admin", "Administrator", "AGENTFORGE_ADMIN_PASSWORD"),
])
@pytest.mark.parametrize("source", ["default-env", "custom-env", "prompt"])
def test_account_cli_password_sources(
    account_cli, provisioning_url, monkeypatch, capsys, action, role, label, default_env, source,
):
    password = "cli-secret-password"
    arguments = []
    prompts = []
    if source == "prompt":
        monkeypatch.setenv(default_env, "")

        def hidden_password(prompt):
            prompts.append(prompt)
            return password

        monkeypatch.setattr(database.getpass, "getpass", hidden_password)
    else:
        name = default_env if source == "default-env" else "TEST_ACCOUNT_PASSWORD"
        monkeypatch.setenv(name, password)
        if source == "custom-env":
            monkeypatch.setenv(default_env, "wrong-default-password")
            arguments = ["--password-env", name]
    account_cli(action, *arguments)
    output = capsys.readouterr()
    rows = asyncio.run(_provisioned_rows(provisioning_url))
    assert len(rows) == 1 and rows[0]["role"] == role
    assert verify_password(password, rows[0]["password_hash"])[0]
    assert f"{label} created: {rows[0]['id']}" in output.out
    assert password not in output.out + output.err
    assert prompts == ([f"{label} password: "] if source == "prompt" else [])


@pytest.mark.parametrize("action,other_action,password_env", [
    ("create-user", "create-admin", "AGENTFORGE_USER_PASSWORD"),
    ("create-admin", "create-user", "AGENTFORGE_ADMIN_PASSWORD"),
])
def test_account_cli_duplicate_and_role_conflict_preserve_data(
    account_cli, provisioning_url, monkeypatch, capsys, action, other_action, password_env,
):
    monkeypatch.setenv(password_env, "first-password")
    account_cli(action)
    capsys.readouterr()
    before = asyncio.run(_provisioned_rows(provisioning_url))
    monkeypatch.setenv(password_env, "different-password")
    account_cli(action)
    assert "already exists" in capsys.readouterr().out
    assert asyncio.run(_provisioned_rows(provisioning_url)) == before
    with pytest.raises(SystemExit) as exc:
        account_cli(other_action, "--password-env", password_env)
    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "no account was changed" in output.err
    assert "different-password" not in output.out + output.err
    assert asyncio.run(_provisioned_rows(provisioning_url)) == before


@pytest.mark.parametrize("action,password_env", [
    ("create-user", "AGENTFORGE_USER_PASSWORD"),
    ("create-admin", "AGENTFORGE_ADMIN_PASSWORD"),
])
def test_account_cli_rejects_short_password(account_cli, provisioning_url, monkeypatch, capsys, action, password_env):
    monkeypatch.setenv(password_env, "short")
    with pytest.raises(SystemExit) as exc:
        account_cli(action)
    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "at least 8 characters" in output.err
    assert asyncio.run(_provisioned_rows(provisioning_url)) == []


@pytest.mark.parametrize("action,password_env", [
    ("create-user", "AGENTFORGE_USER_PASSWORD"),
    ("create-admin", "AGENTFORGE_ADMIN_PASSWORD"),
])
def test_account_cli_rejects_invalid_email(account_cli, provisioning_url, monkeypatch, capsys, action, password_env):
    password = "valid-secret-password"
    monkeypatch.setenv(password_env, password)
    with pytest.raises(SystemExit) as exc:
        account_cli(action, "--email", "invalid-email")
    assert exc.value.code == 1
    output = capsys.readouterr()
    assert password not in output.out + output.err
    assert asyncio.run(_provisioned_rows(provisioning_url)) == []


@pytest.mark.parametrize("action", ["create-user", "create-admin"])
def test_account_cli_has_no_plaintext_password_argument(account_cli, provisioning_url, capsys, action):
    with pytest.raises(SystemExit) as exc:
        account_cli(action, "--password=do-not-pass-secrets")
    assert exc.value.code == 2
    assert asyncio.run(_provisioned_rows(provisioning_url)) == []
    capsys.readouterr()
