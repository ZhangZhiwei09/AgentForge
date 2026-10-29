"""测试：配置系统 (Step 1)。"""

import os

import pytest
from pydantic import ValidationError

from src.config import Settings


class TestSettings:
    """Settings 加载与默认值测试。"""

    def test_default_values(self):
        """所有字段应有合理默认值。"""
        # 清除环境变量以确保默认值
        env_vars = [
            "DATABASE_URL", "REDIS_URL", "JWT_SECRET",
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "DEFAULT_MODEL",
            "PORT", "DEBUG",
        ]
        saved = {k: os.environ.pop(k, None) for k in env_vars}

        try:
            # _env_file=None：仅验证代码默认值，排除 .env 覆盖
            # （否则 .env 的 DEFAULT_MODEL=deepseek-v4-pro 会遮蔽代码默认）
            settings = Settings(_env_file=None)
            assert "postgresql+asyncpg" in settings.database_url
            assert "redis://" in settings.redis_url
            assert len(settings.jwt_secret) > 0
            assert settings.default_model == "gpt-4o-mini"
            assert settings.port == 8000
            assert settings.debug is False
        finally:
            # 恢复环境变量
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_redis_memory_defaults(self):
        """Redis 短期记忆配置应有纯代码默认值（排除 .env 与环境变量）。"""
        env_vars = [
            "REDIS_MEMORY_ENABLED", "REDIS_MEMORY_WINDOW_SIZE",
            "REDIS_MEMORY_MESSAGE_TTL_SECONDS", "REDIS_MEMORY_SUMMARY_TTL_SECONDS",
            "REDIS_MEMORY_VERIFY_LATEST_ID",
        ]
        saved = {k: os.environ.pop(k, None) for k in env_vars}

        try:
            settings = Settings(_env_file=None)
            assert settings.redis_memory_enabled is True
            assert settings.redis_memory_window_size == 20
            assert settings.redis_memory_message_ttl_seconds == 604800
            assert settings.redis_memory_summary_ttl_seconds == 2592000
            assert settings.redis_memory_verify_latest_id is False
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_port_is_int(self):
        """PORT 应为 int 类型。"""
        settings = Settings()
        assert isinstance(settings.port, int)

    def test_debug_is_bool(self):
        """DEBUG 应为 bool 类型。"""
        settings = Settings()
        assert isinstance(settings.debug, bool)

    def test_model_config_env_file(self):
        """应配置从 .env 文件加载。"""
        assert Settings.model_config.get("env_file") == ".env"

    def test_shared_env_accepts_not_yet_migrated_settings(self, tmp_path):
        config = tmp_path / "shared.env"
        config.write_text("ELASTICSEARCH_URL=http://localhost:9200\nMINIO_BUCKET=documents\n")
        loaded = Settings(_env_file=config)
        assert loaded.port == 8000


@pytest.fixture
def deployment_env(monkeypatch):
    for name in ("APP_ENV", "DEBUG", "JWT_SECRET", "AUTH_SIGNUP_ENABLED",
                 "ANONYMOUS_CHAT_ENABLED", "PUBLIC_FAQ_ENABLED"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("mode", ["development", "test", "production"])
def test_deployment_defaults(deployment_env, mode):
    loaded = Settings(_env_file=None, app_env=mode, jwt_secret="isolated-test-signing-secret")
    expected = mode != "production"
    assert loaded.auth_signup_enabled is expected
    assert loaded.anonymous_chat_enabled is expected
    assert loaded.public_faq_enabled is expected


@pytest.mark.parametrize("unsafe", [
    {"debug": True}, {"jwt_secret": ""}, {"jwt_secret": "agentforge-dev-secret-change-in-production"},
    {"auth_signup_enabled": True}, {"anonymous_chat_enabled": True}, {"public_faq_enabled": True},
])
def test_production_rejects_unsafe_settings_without_leaking_input(deployment_env, unsafe):
    secret = "private-production-test-secret"
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, **{
            "app_env": "production", "jwt_secret": secret, **unsafe,
        })
    assert secret not in str(error.value)
    assert "input_value" not in str(error.value)


def test_production_env_defaults_and_rejects_explicit_open_switch(deployment_env, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "private-production-test-secret")
    loaded = Settings(_env_file=None)
    assert not loaded.anonymous_chat_enabled
    monkeypatch.setenv("PUBLIC_FAQ_ENABLED", "true")
    with pytest.raises(ValidationError, match="Production disables"):
        Settings(_env_file=None)


def test_local_public_switches_can_be_disabled(deployment_env):
    loaded = Settings(
        _env_file=None, auth_signup_enabled=False, anonymous_chat_enabled=False, public_faq_enabled=False,
    )
    assert not loaded.auth_signup_enabled
    assert not loaded.anonymous_chat_enabled
    assert not loaded.public_faq_enabled
