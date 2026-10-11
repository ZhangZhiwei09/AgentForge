"""Start the platform runtime with the public server's database, auth and model."""

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
    shared = {**configured, **environment}
    database = environment.get("DATABASE_URL") or configured.get("DATABASE_URL")
    database = database or "postgresql://postgres:postgres@127.0.0.1:5434/agentforge"
    scheme, separator, address = database.partition("://")
    if not separator or scheme not in {"postgres", "postgresql", "postgresql+asyncpg"}:
        raise ValueError("Platform DATABASE_URL must use PostgreSQL")
    model = shared.get("DEFAULT_MODEL") or "gpt-4o-mini"
    deepseek = model.startswith("deepseek") and shared.get("DEEPSEEK_API_KEY")
    api_key = shared.get("DEEPSEEK_API_KEY") if deepseek else shared.get("OPENAI_API_KEY")
    base_url = (
        shared.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/v1"
        if deepseek else shared.get("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    )
    return {
        "DATABASE_URL": f"postgresql+asyncpg://{address}",
        "JWT_SECRET": environment.get("JWT_SECRET") or configured.get("JWT_SECRET")
        or "agentforge-dev-secret-change-in-production",
        "DEFAULT_MODEL": model,
        "OPENAI_API_KEY": environment.get("OPENAI_API_KEY", api_key or ""),
        "OPENAI_BASE_URL": environment.get("OPENAI_BASE_URL", base_url),
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
