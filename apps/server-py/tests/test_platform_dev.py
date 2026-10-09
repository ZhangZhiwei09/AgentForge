from src.dev import platform_environment


def test_platform_defaults_ignore_the_standalone_python_database(tmp_path):
    result = platform_environment({}, tmp_path / "missing.env")
    assert result["DATABASE_URL"].endswith("/agentforge")
    assert result["DATABASE_URL"].startswith("postgresql+asyncpg://")
    assert result["JWT_SECRET"] == "agentforge-dev-secret-change-in-production"


def test_platform_reads_the_public_server_config_without_rewriting_it(tmp_path):
    config = tmp_path / ".env"
    contents = (
        'DATABASE_URL="postgresql://platform:password@127.0.0.1:5434/agentforge"\n'
        "JWT_SECRET='test-shared-secret'\n"
        "DEFAULT_MODEL=keep-independent\n"
    )
    config.write_text(contents)
    result = platform_environment({}, config)
    assert result == {
        "DATABASE_URL": "postgresql+asyncpg://platform:password@127.0.0.1:5434/agentforge",
        "JWT_SECRET": "test-shared-secret",
    }
    assert config.read_text() == contents


def test_platform_preserves_explicit_environment_overrides(tmp_path):
    config = tmp_path / ".env"
    config.write_text("DATABASE_URL=postgresql://local/db\nJWT_SECRET=local\n")
    environment = {
        "DATABASE_URL": "postgresql+asyncpg://override/production",
        "JWT_SECRET": "override-secret", "DEFAULT_MODEL": "independent",
    }
    result = platform_environment(environment, config)
    assert result == {
        "DATABASE_URL": "postgresql+asyncpg://override/production",
        "JWT_SECRET": "override-secret",
    }
    assert environment["DEFAULT_MODEL"] == "independent"


def test_platform_accepts_postgres_url_alias(tmp_path):
    result = platform_environment({"DATABASE_URL": "postgres://user:password@host/db"}, tmp_path / ".env")
    assert result["DATABASE_URL"] == "postgresql+asyncpg://user:password@host/db"


def test_platform_rejects_non_postgres_urls(tmp_path):
    import pytest
    with pytest.raises(ValueError, match="PostgreSQL"):
        platform_environment({"DATABASE_URL": "sqlite:///standalone.db"}, tmp_path / ".env")
