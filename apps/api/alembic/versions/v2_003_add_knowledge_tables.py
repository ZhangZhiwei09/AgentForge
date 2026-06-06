"""add knowledge_bases, knowledge_documents, knowledge_chunks tables

Revision ID: v2_003
Revises: v2_002
Create Date: 2026-06-06
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "v2_003"
down_revision: Union[str, None] = "v2_002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "knowledge_bases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("knowledge_base_id", sa.String(36), sa.ForeignKey("knowledge_bases.id"), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_knowledge_documents_kb_id", "knowledge_documents", ["knowledge_base_id"])

    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("knowledge_documents.id"), nullable=False),
        sa.Column("knowledge_base_id", sa.String(36), sa.ForeignKey("knowledge_bases.id"), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("milvus_id", sa.Integer(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_knowledge_chunks_doc_id", "knowledge_chunks", ["document_id"])
    op.create_index("ix_knowledge_chunks_kb_id", "knowledge_chunks", ["knowledge_base_id"])


def downgrade() -> None:
    op.drop_index("ix_knowledge_chunks_kb_id", table_name="knowledge_chunks")
    op.drop_index("ix_knowledge_chunks_doc_id", table_name="knowledge_chunks")
    op.drop_table("knowledge_chunks")
    op.drop_index("ix_knowledge_documents_kb_id", table_name="knowledge_documents")
    op.drop_table("knowledge_documents")
    op.drop_table("knowledge_bases")
