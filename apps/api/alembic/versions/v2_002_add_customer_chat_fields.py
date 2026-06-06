"""add type and session_id to conversations

Revision ID: v2_002
Revises: v2_001
Create Date: 2026-06-05
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "v2_002"
down_revision: Union[str, None] = "v2_001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("conversations", sa.Column("type", sa.String(32), nullable=False, server_default="chat"))
    op.add_column("conversations", sa.Column("session_id", sa.String(64), nullable=True))
    op.create_index("ix_conversations_session_id", "conversations", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_conversations_session_id", table_name="conversations")
    op.drop_column("conversations", "session_id")
    op.drop_column("conversations", "type")
