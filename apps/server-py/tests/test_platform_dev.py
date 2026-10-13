from src.dev import environment_paths, platform_environment


def test_env_paths_support_monorepo_and_shallow_container_layout(tmp_path):
    assert environment_paths(tmp_path / "apps/server-py") == (
        tmp_path / "apps/server/.env", tmp_path / ".env", tmp_path / "apps/server-py/.env",
    )
    assert environment_paths(tmp_path / "app") == (
        tmp_path / "app/apps/server/.env", tmp_path / "app/.env", tmp_path / "app/.env",
    )


def test_platform_defaults_ignore_the_standalone_python_database(tmp_path):
    result = platform_environment({}, tmp_path / "missing.env")
    assert result["DATABASE_URL"].endswith("/agentforge")
    assert result["DATABASE_URL"].startswith("postgresql+asyncpg://")
    assert result["JWT_SECRET"] == "agentforge-dev-secret-change-in-production"
    assert result["DEFAULT_MODEL"] == "gpt-4o-mini"
    assert result["OPENAI_API_KEY"] == ""
    assert result["OPENAI_BASE_URL"] == "https://api.openai.com/v1"


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
        "DEFAULT_MODEL": "keep-independent",
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
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
        "DEFAULT_MODEL": "independent",
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
    }
    assert environment["DEFAULT_MODEL"] == "independent"


def test_platform_accepts_postgres_url_alias(tmp_path):
    result = platform_environment({"DATABASE_URL": "postgres://user:password@host/db"}, tmp_path / ".env")
    assert result["DATABASE_URL"] == "postgresql+asyncpg://user:password@host/db"


def test_platform_rejects_non_postgres_urls(tmp_path):
    import pytest
    with pytest.raises(ValueError, match="PostgreSQL"):
        platform_environment({"DATABASE_URL": "sqlite:///standalone.db"}, tmp_path / ".env")


def test_platform_maps_deepseek_to_the_compatible_python_provider(tmp_path):
    config = tmp_path / ".env"
    contents = (
        "DEFAULT_MODEL=deepseek-chat\n"
        "DEEPSEEK_API_KEY=deepseek-test-key\n"
        "DEEPSEEK_BASE_URL=https://models.example.com/v1\n"
        "OPENAI_API_KEY=other-provider-key\n"
        "OPENAI_BASE_URL=https://other.example.com/v1\n"
    )
    config.write_text(contents)
    result = platform_environment({}, config)
    assert result["DEFAULT_MODEL"] == "deepseek-chat"
    assert result["OPENAI_API_KEY"] == "deepseek-test-key"
    assert result["OPENAI_BASE_URL"] == "https://models.example.com/v1"
    assert config.read_text() == contents


def test_platform_preserves_explicit_python_model_credentials(tmp_path):
    config = tmp_path / ".env"
    config.write_text(
        "DEFAULT_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=shared-key\n"
    )
    result = platform_environment({
        "OPENAI_API_KEY": "explicit-key",
        "OPENAI_BASE_URL": "https://override.example.com/v1",
    }, config)
    assert result["OPENAI_API_KEY"] == "explicit-key"
    assert result["OPENAI_BASE_URL"] == "https://override.example.com/v1"


def test_platform_reads_openai_credentials_for_other_models(tmp_path):
    config = tmp_path / ".env"
    config.write_text(
        "DEFAULT_MODEL=gpt-4o-mini\n"
        "OPENAI_API_KEY=openai-test-key\n"
        "OPENAI_BASE_URL=https://compatible.example.com/v1\n"
        "DEEPSEEK_API_KEY=unused-key\n"
    )
    result = platform_environment({}, config)
    assert result["OPENAI_API_KEY"] == "openai-test-key"
    assert result["OPENAI_BASE_URL"] == "https://compatible.example.com/v1"


def test_python_config_overrides_legacy_and_root_files_without_modifying_them(tmp_path):
    legacy, root, python = (tmp_path / name for name in ("legacy.env", "root.env", "python.env"))
    legacy.write_text("JWT_SECRET=legacy\nDEFAULT_MODEL=legacy-model\nREDIS_URL=redis://legacy\n")
    root.write_text("JWT_SECRET=root\nDEFAULT_MODEL=root-model\n")
    python.write_text("JWT_SECRET=python\nDEFAULT_MODEL=python-model\nCORS_ORIGINS=http://localhost:5200\n")
    contents = [path.read_text() for path in (legacy, root, python)]
    result = platform_environment({}, env_files=(legacy, root, python))
    assert result["JWT_SECRET"] == "python"
    assert result["DEFAULT_MODEL"] == "python-model"
    assert result["REDIS_URL"] == "redis://legacy"
    assert result["CORS_ORIGINS"] == "http://localhost:5200"
    assert [path.read_text() for path in (legacy, root, python)] == contents


def test_public_config_does_not_require_node_server_env(tmp_path):
    python = tmp_path / "python.env"
    python.write_text("DATABASE_URL=postgresql://python:password@localhost/platform\nJWT_SECRET=python\n")
    result = platform_environment(
        {}, env_files=(tmp_path / "missing-legacy.env", tmp_path / "missing-root.env", python),
    )
    assert result["DATABASE_URL"] == "postgresql+asyncpg://python:password@localhost/platform"
    assert result["JWT_SECRET"] == "python"


def test_non_model_process_configuration_has_highest_priority(tmp_path):
    python = tmp_path / "python.env"
    python.write_text("REDIS_URL=redis://file\nCORS_ORIGINS=http://file\nDEBUG=false\n")
    result = platform_environment(
        {"REDIS_URL": "redis://process", "CORS_ORIGINS": "http://process", "DEBUG": "true"},
        env_files=(python,),
    )
    assert result["REDIS_URL"] == "redis://process"
    assert result["CORS_ORIGINS"] == "http://process"
    assert result["DEBUG"] == "true"


def test_public_launch_uses_python_config_and_explicit_port(tmp_path, monkeypatch):
    import sys

    import uvicorn

    from src import dev

    python = tmp_path / "python.env"
    python.write_text("PORT=8123\nJWT_SECRET=python-file\nREDIS_URL=redis://python\n")
    monkeypatch.setattr(dev, "SERVER_ENV", tmp_path / "missing-legacy.env")
    monkeypatch.setattr(dev, "ROOT_ENV", tmp_path / "missing-root.env")
    monkeypatch.setattr(dev, "PYTHON_ENV", python)
    monkeypatch.setattr(sys, "argv", ["dev", "--public", "--no-reload", "--port", "8124"])
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    # main writes process configuration; keep it isolated from later tests.
    monkeypatch.setattr("os.environ", {})
    dev.main()
    assert calls == [(("src.main:app",), {
        "host": "0.0.0.0", "port": 8124, "reload": False, "loop": "none", "access_log": False,
    })]
    assert dev.os.environ["PORT"] == "8124"
    assert dev.os.environ["JWT_SECRET"] == "python-file"
    assert dev.os.environ["REDIS_URL"] == "redis://python"


def test_explicit_flow_launch_keeps_8004_even_when_server_env_has_public_port(tmp_path, monkeypatch):
    import sys

    import uvicorn

    from src import dev

    legacy = tmp_path / "legacy.env"
    legacy.write_text("PORT=8000\n")
    monkeypatch.setattr(dev, "SERVER_ENV", legacy)
    monkeypatch.setattr(sys, "argv", ["dev", "--flow-service", "--no-reload"])
    monkeypatch.setattr(dev, "ROOT_ENV", tmp_path / "missing-root.env")
    monkeypatch.setattr(dev, "PYTHON_ENV", tmp_path / "missing-python.env")
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr("os.environ", {})
    dev.main()
    assert calls[0][1]["port"] == 8004
    assert dev.os.environ["PORT"] == "8004"


def test_default_launch_is_public_and_reads_python_configuration(tmp_path, monkeypatch):
    import sys

    import uvicorn

    from src import dev

    python = tmp_path / "python.env"
    python.write_text("JWT_SECRET=python-file\n")
    monkeypatch.setattr(dev, "SERVER_ENV", tmp_path / "missing-legacy.env")
    monkeypatch.setattr(dev, "ROOT_ENV", tmp_path / "missing-root.env")
    monkeypatch.setattr(dev, "PYTHON_ENV", python)
    monkeypatch.setattr(sys, "argv", ["dev", "--no-reload"])
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr("os.environ", {})
    dev.main()
    assert calls[0][1]["port"] == 8000
    assert dev.os.environ["JWT_SECRET"] == "python-file"
