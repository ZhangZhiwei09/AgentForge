"""add_pgvector_embedding

Phase B: 为 knowledge_chunks 表添加 pgvector embedding 列 + HNSW 索引。

Revision ID: fe46665d041c
Revises: 49c2e8e35a6e
Create Date: 2026-07-26
"""

from collections.abc import Sequence
from typing import Union

from alembic import op
from pgvector.sqlalchemy import Vector
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "fe46665d041c"
down_revision: Union[str, Sequence[str], None] = "49c2e8e35a6e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """添加 pgvector 扩展 + embedding 列 + HNSW 索引。"""
    # 1. 启用 pgvector 扩展
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 2. 添加 embedding 列（1536d = text-embedding-3-small）
    op.add_column(
        "knowledge_chunks",
        sa.Column("embedding", Vector(1536), nullable=True),
    )

    # 3. 创建 HNSW 索引（余弦相似度）
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_embedding_cosine
        ON knowledge_chunks
        USING hnsw (embedding vector_cosine_ops)
        """
    )


def downgrade() -> None:
    """回滚：删除索引 + 列。"""
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_cosine")
    op.drop_column("knowledge_chunks", "embedding")
