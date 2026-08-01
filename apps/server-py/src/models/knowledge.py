"""知识库 SQLAlchemy ORM 模型。

对应已有表结构（由 scripts/seed_identity_kb.py 创建）。
Phase B 新增: knowledge_chunks.embedding 列（pgvector）。
"""

from datetime import datetime
from typing import Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base


class KnowledgeBase(Base):
    """知识库。

    对应表: knowledge_bases
    """

    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    chunk_size_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    chunk_overlap_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    separator_mode: Mapped[Optional[str]] = mapped_column(String(20), default="auto")
    custom_separator: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    chunk_structure: Mapped[Optional[str]] = mapped_column(String(20), default="paragraph")
    child_chunk_size_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    child_chunk_overlap_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    remove_extra_spaces: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    remove_urls_emails: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # 关联
    documents: Mapped[list["KnowledgeDocument"]] = relationship(
        back_populates="knowledge_base", lazy="selectin"
    )


class KnowledgeDocument(Base):
    """知识文档。

    对应表: knowledge_documents
    """

    __tablename__ = "knowledge_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    knowledge_base_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("knowledge_bases.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    original_filename: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    original_file_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    original_file_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    original_file_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    quality_label: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    processing_detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processing_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    downloading_completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    parsing_completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # 关联
    knowledge_base: Mapped["KnowledgeBase"] = relationship(back_populates="documents")
    chunks: Mapped[list["KnowledgeChunk"]] = relationship(
        back_populates="document", lazy="selectin"
    )


class KnowledgeChunk(Base):
    """知识分片（chunk）。

    对应表: knowledge_chunks
    Phase B 新增: embedding 列（pgvector vector(1536)）
    """

    __tablename__ = "knowledge_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("knowledge_documents.id"), nullable=False
    )
    knowledge_base_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("knowledge_bases.id"), nullable=False
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    source_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    quality_label: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    parent_chunk_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("knowledge_chunks.id"), nullable=True
    )
    # Phase B 新增: pgvector embedding
    embedding: Mapped[Optional[list[float]]] = mapped_column(
        Vector(1536), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # 关联
    document: Mapped["KnowledgeDocument"] = relationship(back_populates="chunks")
