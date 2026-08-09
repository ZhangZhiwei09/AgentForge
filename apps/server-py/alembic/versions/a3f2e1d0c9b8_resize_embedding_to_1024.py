"""resize_embedding_to_1024

embedding 维度从 vector(1536) 改为 vector(1024)，对齐本地 Ollama bge-m3。
两表当前均无向量数据（intent_samples 全 NULL、knowledge_chunks 空表），ALTER 无数据迁移风险。

Revision ID: a3f2e1d0c9b8
Revises: 7c2d9e4a1f8b
Create Date: 2026-08-09
"""

from collections.abc import Sequence
from typing import Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "a3f2e1d0c9b8"
down_revision: Union[str, Sequence[str], None] = "7c2d9e4a1f8b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """两表 embedding 列缩到 vector(1024)。"""
    op.execute("ALTER TABLE intent_samples ALTER COLUMN embedding TYPE vector(1024)")
    op.execute("ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(1024)")


def downgrade() -> None:
    """回滚：恢复 vector(1536)。"""
    op.execute("ALTER TABLE intent_samples ALTER COLUMN embedding TYPE vector(1536)")
    op.execute("ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(1536)")
