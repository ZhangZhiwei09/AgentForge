"""Checkpoint 管理 —— LangGraph AsyncPostgresSaver 的单例封装。

使用 AsyncConnectionPool 作为后端，进程内共享一个连接池。
setup() 自动创建 checkpoints 表（幂等）。

对应 python-core-upgrade-plan.md: G1 Checkpointing
"""

import logging

from psycopg_pool import AsyncConnectionPool

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from src.config import settings

logger = logging.getLogger(__name__)

_saver: AsyncPostgresSaver | None = None
_pool: AsyncConnectionPool | None = None


async def get_checkpointer() -> AsyncPostgresSaver | None:
    """获取 checkpointer 单例。config 关闭时返回 None。

    首次调用时创建 AsyncConnectionPool 并初始化 AsyncPostgresSaver。
    后续调用返回同一实例。

    Returns:
        AsyncPostgresSaver 实例，或 None（langgraph_checkpoint_enabled=False 时）
    """
    if not settings.langgraph_checkpoint_enabled:
        return None

    global _saver, _pool

    if _pool is None:
        # 将 asyncpg URL 转为 psycopg 格式（psycopg 不识别 +asyncpg 后缀）
        conn_string = settings.database_url.replace("+asyncpg", "")
        logger.info("Creating checkpoint connection pool for %s", conn_string)
        _pool = AsyncConnectionPool(conn_string, open=False)
        await _pool.open()

    if _saver is None:
        _saver = AsyncPostgresSaver(conn=_pool)
        await _saver.setup()  # 幂等：自动创建 checkpoints / checkpoint_blobs / checkpoint_writes 表
        logger.info("Checkpointer initialized (tables created if not exist)")

    return _saver


async def close_checkpointer() -> None:
    """关闭 checkpointer 连接池（shutdown 时调用）。"""
    global _saver, _pool

    if _saver is not None:
        _saver = None

    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("Checkpointer connection pool closed")
