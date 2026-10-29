"""Python database upgrade, inspection and account provisioning commands."""

import argparse
import asyncio
import getpass
import json
import os
import re
import uuid
from pathlib import Path

from alembic.config import Config
from sqlalchemy import inspect, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from alembic import command
from src.models.base import Base

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "alembic/baselines/20261013.json"
LEGACY_HEAD = "a3f2e1d0c9b8"
BASELINE_HEAD = "20261013_python_baseline"


def compatible_type(expected: str, actual: str) -> bool:
    actual = re.sub(r"^TIMESTAMP\(\d+\)", "TIMESTAMP", actual)
    if expected == actual or {expected, actual} <= {"JSON", "JSONB"}:
        return True
    if expected == "VARCHAR[]" and actual == "TEXT[]":
        return True
    if expected == "FLOAT" and actual == "DOUBLE PRECISION":
        return True
    if expected.startswith("VARCHAR"):
        if actual == "TEXT":
            return True
        expected_length = re.fullmatch(r"VARCHAR\((\d+)\)", expected)
        actual_length = re.fullmatch(r"VARCHAR\((\d+)\)", actual)
        return bool(expected_length and actual_length and int(actual_length[1]) >= int(expected_length[1]))
    return False


def validate_existing_schema(connection):
    """Inspect before stamping; do not disguise incompatible schemas as migrated."""
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    inspector = inspect(connection)
    schema = connection.scalar(text("SELECT current_schema()"))
    present = set(inspector.get_table_names(schema=schema))
    errors = []
    for name, expected in baseline["tables"].items():
        if name not in present:
            continue
        columns = {column["name"]: column for column in inspector.get_columns(name, schema=schema)}
        for column, expected_type in expected["columns"].items():
            actual = columns.get(column)
            if actual is None:
                errors.append(f"{name}.{column}: missing column")
            elif name == "intent_samples" and column == "last_used_at" and str(
                actual["type"].compile(dialect=connection.dialect),
            ).startswith("TIMESTAMP"):
                # Prisma used a naive timestamp; historical Alembic used timestamptz.
                # Usage updates use SQL NOW(), so retain either existing definition.
                continue
            elif not compatible_type(expected_type, str(actual["type"].compile(dialect=connection.dialect))):
                errors.append(f"{name}.{column}: incompatible type (expected {expected_type})")
        if inspector.get_pk_constraint(name, schema=schema)["constrained_columns"] != expected["primary_key"]:
            errors.append(f"{name}: incompatible primary key")
    if errors:
        raise RuntimeError("Schema adoption refused; apply an explicit repair migration:\n" + "\n".join(errors))


def upgrade_connection(connection):
    if connection.dialect.name != "postgresql":
        raise ValueError("Database migrations require PostgreSQL with pgvector")
    # Serialize bootstrap and upgrades, including the initial Alembic stamp.
    connection.execute(text("SELECT pg_advisory_xact_lock(2147130013)"))
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["connection"] = connection
    schema = connection.scalar(text("SELECT current_schema()"))
    present = set(inspect(connection).get_table_names(schema=schema))
    current = connection.scalar(text("SELECT version_num FROM alembic_version")) if "alembic_version" in present else None
    if current is None:
        validate_existing_schema(connection)
        # Old revisions depended on Prisma creating knowledge tables. Bootstrap
        # from the frozen complete baseline instead of replaying that hybrid chain.
        command.stamp(config, LEGACY_HEAD)
    elif current != BASELINE_HEAD:
        validate_existing_schema(connection)
        # A compatible legacy database already contains the old vector changes.
        # Replaying historical 1536d migrations could corrupt 1024d embeddings.
        if current in {"49c2e8e35a6e", "fe46665d041c", "7c2d9e4a1f8b"}:
            command.stamp(config, LEGACY_HEAD)
    command.upgrade(config, "head")
    validate_existing_schema(connection)
    return connection.scalar(text("SELECT version_num FROM alembic_version"))


async def upgrade_database(url: str):
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            return await connection.run_sync(upgrade_connection)
    finally:
        await engine.dispose()


async def _create_account(
    db: AsyncSession, email: str, password: str, *, role: str, label: str,
) -> tuple[str, bool]:
    from src.models.user import User
    from src.schemas.user import SignInRequest
    from src.services.auth import hash_password

    normalized = SignInRequest(email=email, password=password).email
    existing = await db.scalar(select(User).where(User.email == normalized))
    if existing:
        if existing.role != role:
            raise ValueError(f"This email belongs to a non-{role} account; no account was changed")
        return existing.id, False
    if len(password) < 8:
        raise ValueError(f"{label} password must contain at least 8 characters")
    user = User(
        id=str(uuid.uuid4()), email=normalized, role=role,
        password_hash=await asyncio.to_thread(hash_password, password),
    )
    db.add(user)
    await db.commit()
    return user.id, True


async def create_admin(db: AsyncSession, email: str, password: str) -> tuple[str, bool]:
    return await _create_account(db, email, password, role="admin", label="Administrator")


async def create_user(db: AsyncSession, email: str, password: str) -> tuple[str, bool]:
    return await _create_account(db, email, password, role="user", label="User")


def main():
    from src.dev import PYTHON_ENV, ROOT_ENV, SERVER_ENV, platform_environment

    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("upgrade")
    subparsers.add_parser("check")
    for action, password_env in (
        ("create-admin", "AGENTFORGE_ADMIN_PASSWORD"),
        ("create-user", "AGENTFORGE_USER_PASSWORD"),
    ):
        account = subparsers.add_parser(action, allow_abbrev=False)
        account.add_argument("--email", required=True)
        account.add_argument("--password-env", default=password_env)
    args = parser.parse_args()
    configured = platform_environment(os.environ, env_files=(SERVER_ENV, ROOT_ENV, PYTHON_ENV))
    url = configured["DATABASE_URL"]

    async def run():
        if args.action == "upgrade":
            print(f"Database ready at revision {await upgrade_database(url)}")
            return
        engine = create_async_engine(url)
        try:
            if args.action == "check":
                async with engine.connect() as connection:
                    await connection.run_sync(validate_existing_schema)
                    present = await connection.run_sync(lambda sync: set(inspect(sync).get_table_names(
                        schema=sync.scalar(text("SELECT current_schema()")),
                    )))
                    required = set(Base.metadata.tables)
                    if required - present:
                        raise RuntimeError("Missing tables: " + ", ".join(sorted(required - present)))
                print("Database schema is compatible")
            else:
                provision = create_admin if args.action == "create-admin" else create_user
                label = "Administrator" if args.action == "create-admin" else "User"
                password = os.environ.get(args.password_env) or getpass.getpass(f"{label} password: ")
                async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                    user_id, created = await provision(db, args.email, password)
                print(f"{label} {'created' if created else 'already exists'}: {user_id}")
        finally:
            await engine.dispose()

    try:
        asyncio.run(run())
    except (ValueError, RuntimeError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
