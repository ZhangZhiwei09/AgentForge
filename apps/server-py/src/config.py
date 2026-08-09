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

    # ── Redis 短期记忆（短期记忆存储层）──────────────────
    # 最近消息滑动窗口 + 摘要镜像到 Redis，PG 始终是事实源。
    # Redis 不可用时自动降级读 PG；写入失败只记结构化日志、零影响主流程。
    redis_memory_enabled: bool = Field(default=True)             # 总开关，False 时全走 PG（等价现状）
    redis_memory_window_size: int = Field(default=20)            # 窗口原始消息条数 = RAW_WINDOW(10) * 2
    redis_memory_message_ttl_seconds: int = Field(default=604800)  # 消息窗口 TTL（7 天），滑动刷新
    redis_memory_summary_ttl_seconds: int = Field(default=2592000) # 摘要 TTL（30 天），滑动刷新
    redis_memory_verify_latest_id: bool = Field(default=False)     # 读窗口时对 PG 做 last-id 新鲜度核对；生产默认关（纯 Redis 读）

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
    # G1 全局门控：开启后 TASK 路由的 ReAct 也会挂 checkpointer（thread=conversation_id）。
    # 保持默认关 —— 团队级诊断 checkpoint 由下方独立的
    # langgraph_diagnosis_checkpoint_enabled 控制，二者互不牵连。
    langgraph_checkpoint_enabled: bool = Field(default=False)

    # ── LangGraph Diagnosis ──────────────────────────
    # 团队级 checkpoint（Phase 2）：父图挂 AsyncPostgresSaver（thread_id=team_run_id）。
    # 与 langgraph_checkpoint_enabled 独立 —— 仅诊断父图启用，不影响 TASK/内层 ReAct。
    # 开启时父图 checkpoint 中间态；DB 不可用时会降级为无状态执行（见 graph.py）。
    langgraph_diagnosis_checkpoint_enabled: bool = Field(default=True)
    # Phase 3a：每阶段超时（毫秒）。0 = 禁用（保持外层整体 180s 超时）。
    langgraph_diagnosis_stage_timeout_ms: int = Field(default=0)
    # 阶段超时后的重试次数（仅超时触发重试，异常不重试）。
    langgraph_diagnosis_stage_max_retries: int = Field(default=1)
    # Phase 3b：HITL —— Leader 判定信息不足时 interrupt 暂停等用户补充
    # （需团队级 checkpoint 已开启；checkpointer 不可用时自动降级为 needs_human）。
    langgraph_diagnosis_hitl_enabled: bool = Field(default=False)

    # ── Router（L1-L5 五层路由）─────────────────────────
    # 对齐 TS routing/pipeline.ts 的编排阈值。
    # L2 语义层需要 embedding provider + intent_samples 表；缺失时优雅降级 L1→L5。
    router_semantic_enabled: bool = Field(default=True)
    router_semantic_top_k: int = Field(default=5)
    router_semantic_min_similarity: float = Field(default=0.5)
    router_semantic_high_confidence: float = Field(default=0.8)   # ≥ 直接返回
    router_semantic_low_confidence: float = Field(default=0.5)    # ≥ 且有 matches → L3
    router_semantic_ambiguity_gap: float = Field(default=0.15)
    router_semantic_ambiguity_penalty: float = Field(default=0.8)
    router_llm_enabled: bool = Field(default=True)
    router_llm_max_tokens_l3: int = Field(default=200)
    router_llm_max_tokens_l4: int = Field(default=150)
    router_llm_history_window: int = Field(default=4)
    router_fallback_enabled: bool = Field(default=True)

    # ── Server ──────────────────────────────────────────
    port: int = Field(default=8000)
    debug: bool = Field(default=False)


# 模块级单例 —— import 即加载 .env，进程内唯一
settings = Settings()
