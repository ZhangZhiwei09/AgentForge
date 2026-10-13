"""Fresh/adopted PostgreSQL schema and administrator lifecycle checks."""

import json
import logging
from pathlib import Path

import pytest
from sqlalchemy import inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from src.database import BASELINE, create_admin, upgrade_connection
from src.models.base import Base
from src.models.user import User
from src.services.auth import verify_password

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
