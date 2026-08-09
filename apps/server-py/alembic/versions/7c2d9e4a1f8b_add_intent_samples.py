"""add_intent_samples

为路由 L2 语义层创建 intent_samples 意图样本表（镜像 TS prisma schema）。
embedding 用 Vector(1536) 对齐 Python 默认 embedding_model（text-embedding-3-small）。
IVFFlat embedding 索引由种子脚本在建向量后创建（对齐 TS 做法），此处只建 route/active 索引。

Revision ID: 7c2d9e4a1f8b
Revises: fe46665d041c
Create Date: 2026-08-09
"""

from collections.abc import Sequence
from typing import Union

from alembic import op
from pgvector.sqlalchemy import Vector
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "7c2d9e4a1f8b"
down_revision: Union[str, Sequence[str], None] = "fe46665d041c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 intent_samples 表 + route/active 索引。"""
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "intent_samples",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("route", sa.String(20), nullable=False),
        sa.Column("text", sa.String(2000), nullable=False),
        sa.Column("embedding", Vector(1536), nullable=True),
        sa.Column("source", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.create_index("ix_intent_samples_route", "intent_samples", ["route"])
    op.create_index("ix_intent_samples_active", "intent_samples", ["active"])


def downgrade() -> None:
    """回滚：删除表。"""
    op.drop_table("intent_samples")
