"""Start the Python public API with shared local configuration."""

import argparse
import os
import sys
from collections.abc import Mapping
from pathlib import Path

from dotenv import dotenv_values


def environment_paths(application_root: Path):
    workspace = application_root.parent.parent if application_root.parent.name == "apps" else application_root
    return workspace / "apps/server/.env", workspace / ".env", application_root / ".env"


SERVER_ENV, ROOT_ENV, PYTHON_ENV = environment_paths(Path(__file__).resolve().parents[1])


def platform_environment(
    environment: Mapping[str, str], server_env: Path = SERVER_ENV,
    *, env_files: tuple[Path, ...] | None = None,
) -> dict[str, str]:
    configured: dict[str, str] = {}
    for path in env_files if env_files is not None else (server_env,):
        configured.update({
            key: value for key, value in dotenv_values(path).items() if value is not None
        })
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
        **configured,
        **{key: environment[key] for key in configured if key in environment},
        "DATABASE_URL": f"postgresql+asyncpg://{address}",
        "JWT_SECRET": environment.get("JWT_SECRET") or configured.get("JWT_SECRET")
        or "agentforge-dev-secret-change-in-production",
        "DEFAULT_MODEL": model,
        "OPENAI_API_KEY": environment.get("OPENAI_API_KEY", api_key or ""),
        "OPENAI_BASE_URL": environment.get("OPENAI_BASE_URL", base_url),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int)
    parser.add_argument(
        "--public", action="store_true",
        help="Compatibility alias; the public API is now the default.",
    )
    parser.add_argument("--flow-service", action="store_true", help="Use the former flow port 8004.")
    parser.add_argument("--no-reload", action="store_true")
    arguments = parser.parse_args()
    configure_environment()
    port = arguments.port
    if port is None:
        port = 8004 if arguments.flow_service else int(os.environ.get("PORT", "8000"))
    os.environ["PORT"] = str(port)
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    import uvicorn
    uvicorn.run(
        "src.main:app", host="0.0.0.0", port=port,
        reload=not arguments.no_reload, loop="none", access_log=False,
    )


def configure_environment():
    overrides = platform_environment(os.environ, env_files=(SERVER_ENV, ROOT_ENV, PYTHON_ENV))
    # Process environment always wins over files, including non-model settings.
    os.environ.update({key: value for key, value in overrides.items() if key not in os.environ})
    # These fields additionally normalize URL schemes and provider credentials.
    for key in ("DATABASE_URL", "JWT_SECRET", "DEFAULT_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL"):
        os.environ[key] = overrides[key]


if __name__ == "__main__":
    main()
