"""add memories table

Revision ID: v2_001
Revises:
Create Date: 2026-06-03
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "v2_001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "memories",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "type",
            sa.Enum("episodic", "semantic", "preference", name="memory_type"),
            nullable=False,
        ),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("importance", sa.Float, nullable=False, server_default="0.5"),
        sa.Column("embedding_id", sa.BigInteger, nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True, server_default="{}"),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("conversations.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_memories_user_id", "memories", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_memories_user_id", table_name="memories")
    op.drop_table("memories")
    op.execute("DROP TYPE IF EXISTS memory_type")
