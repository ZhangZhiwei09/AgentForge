"""Start the platform runtime with the public server's database and JWT config."""

import argparse
import os
import sys
from collections.abc import Mapping
from pathlib import Path

from dotenv import dotenv_values

SERVER_ENV = Path(__file__).resolve().parents[2] / "server" / ".env"


def platform_environment(
    environment: Mapping[str, str], server_env: Path = SERVER_ENV,
) -> dict[str, str]:
    configured = dotenv_values(server_env)
    database = environment.get("DATABASE_URL") or configured.get("DATABASE_URL")
    database = database or "postgresql://postgres:postgres@127.0.0.1:5434/agentforge"
    scheme, separator, address = database.partition("://")
    if not separator or scheme not in {"postgres", "postgresql", "postgresql+asyncpg"}:
        raise ValueError("Platform DATABASE_URL must use PostgreSQL")
    return {
        "DATABASE_URL": f"postgresql+asyncpg://{address}",
        "JWT_SECRET": environment.get("JWT_SECRET") or configured.get("JWT_SECRET")
        or "agentforge-dev-secret-change-in-production",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8004)
    parser.add_argument("--no-reload", action="store_true")
    arguments = parser.parse_args()
    # Reload workers inherit these overrides; standalone src.main keeps its own .env.
    os.environ.update(platform_environment(os.environ))
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    import uvicorn
    uvicorn.run(
        "src.main:app", host="0.0.0.0", port=arguments.port,
        reload=not arguments.no_reload, loop="none",
    )


if __name__ == "__main__":
    main()
