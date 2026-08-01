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


async def get_checkpointer(
    *,
    required: bool = False,
) -> AsyncPostgresSaver | None:
    """获取 checkpointer 单例。config 关闭时返回 None。

    首次调用时创建 AsyncConnectionPool 并初始化 AsyncPostgresSaver。
    后续调用返回同一实例。

    Args:
        required: 无条件创建 saver，不受 langgraph_checkpoint_enabled 门控。
            供团队级诊断 checkpoint 使用（graph.py，Phase 2）—— 与 G1 全局门控
            隔离，避免激活 G1 时 TASK 路由的 ReAct 也挂 checkpointer。

    Returns:
        AsyncPostgresSaver 实例，或 None（required=False 且
        langgraph_checkpoint_enabled=False 时）。
    """
    if not settings.langgraph_checkpoint_enabled and not required:
        return None

    global _saver, _pool

    if _pool is None:
        # 将 asyncpg URL 转为 psycopg 格式（psycopg 不识别 +asyncpg 后缀）
        conn_string = settings.database_url.replace("+asyncpg", "")
        logger.info("Creating checkpoint connection pool for %s", conn_string)
        # autocommit=True：langgraph 的 saver.setup() 含 CREATE INDEX CONCURRENTLY，
        # 该语句不能在事务块内执行（psycopg3 默认隐式事务）。checkpoint 写入均为
        # 单语句（CTE），autocommit 语义安全。
        _pool = AsyncConnectionPool(
            conn_string,
            open=False,
            kwargs={"autocommit": True},
        )
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
