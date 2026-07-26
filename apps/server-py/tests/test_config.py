"""测试：配置系统 (Step 1)。"""

import os

import pytest

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
            settings = Settings()
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
