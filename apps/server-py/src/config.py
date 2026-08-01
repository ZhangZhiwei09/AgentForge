"""配置模块 —— 从 .env 加载环境变量，统一导出为 settings 单例。"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置，每个环境变量一个字段，均有合理默认值。"""

    model_config = SettingsConfigDict(env_file=".env")

    # ── 数据库 ──────────────────────────────────────────
    # 端口 5434 与 TS 项目保持一致，避免冲突
    # 使用 +asyncpg 指定异步驱动（sync 连接用 psycopg2，async 用 asyncpg）
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5434/agentforge_py"
    )

    # ── Redis ───────────────────────────────────────────
    redis_url: str = Field(default="redis://localhost:6379")

    # ── Auth ────────────────────────────────────────────
    # 与 TS 端共享同一个 JWT_SECRET，用于验证 TS 签发的 Token
    jwt_secret: str = Field(default="agentforge-dev-secret-change-in-production")

    # ── LLM ─────────────────────────────────────────────
    openai_api_key: str = Field(default="")
    openai_base_url: str = Field(default="https://api.openai.com/v1")
    default_model: str = Field(default="gpt-4o-mini")

    # ── Embedding ───────────────────────────────────────
    embedding_model: str = Field(default="text-embedding-3-small")
    embedding_base_url: str = Field(default="https://api.openai.com/v1")
    embedding_api_key: str = Field(default="")  # 空则 fallback 到 openai_api_key
    chunk_size_tokens: int = Field(default=512)
    chunk_overlap_tokens: int = Field(default=64)

    # ── PgVector ────────────────────────────────────────
    pgvector_enabled: bool = Field(default=False)

    # ── Langfuse ────────────────────────────────────────
    langfuse_enabled: bool = Field(default=False)
    langfuse_public_key: str = Field(default="")
    langfuse_secret_key: str = Field(default="")
    langfuse_base_url: str = Field(default="https://cloud.langfuse.com")

    # ── LangGraph Checkpoint ─────────────────────────
    langgraph_checkpoint_enabled: bool = Field(default=False)

    # ── Server ──────────────────────────────────────────
    port: int = Field(default=8000)
    debug: bool = Field(default=False)


# 模块级单例 —— import 即加载 .env，进程内唯一
settings = Settings()
