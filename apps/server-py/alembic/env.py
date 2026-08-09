"""Alembic 迁移引擎 —— 连接数据库 + 读取模型元数据，生成并执行迁移脚本。"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import create_async_engine

from src.config import settings
from src.models.base import Base

# 加载所有模型，确保 Base.metadata 包含了全部表定义
# 每新增一个模型文件，在这里加一行 import
import src.models.user  # noqa: F401
import src.models.knowledge  # noqa: F401
import src.models.intent_sample  # noqa: F401

# Alembic Config 对象，从 alembic.ini 读取配置
config = context.config

# 设置日志
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 把数据库 URL 设置到 alembic 配置中，覆盖 alembic.ini 里的占位符
config.set_main_option("sqlalchemy.url", settings.database_url)

# target_metadata = 所有模型的"目录"，Alembic 对比这个和数据库实际结构来生成迁移
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：不连数据库，只输出 SQL 到文件。

    用途：生产环境先生成 SQL，DBA 审核后再执行。
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    """在给定连接上执行迁移。"""
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """在线模式（常用）：连数据库，检测差异，生成并执行迁移。

    使用 async engine，和业务代码保持一致。
    """
    connectable = create_async_engine(settings.database_url, poolclass=pool.NullPool)

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
