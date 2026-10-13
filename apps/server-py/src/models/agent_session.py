"""Mappings for the existing task session and tool approval tables."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base

task_json = JSONB(none_as_null=True).with_variant(JSON(none_as_null=True), "sqlite")


class AgentSession(Base):
    __tablename__ = "agent_sessions"
    __table_args__ = (Index("ix_agent_sessions_conversation_id", "conversation_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"),
    )
    task: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="running")
    scratchpad: Mapped[list[dict[str, Any]]] = mapped_column(task_json, default=list)
    final_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    compressed_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    runtime_state: Mapped[dict[str, Any] | None] = mapped_column(task_json, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentApproval(Base):
    __tablename__ = "agent_approvals"
    __table_args__ = (
        Index("ix_agent_approvals_session_id", "session_id"),
        Index("ix_agent_approvals_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_sessions.id", ondelete="CASCADE"),
    )
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"),
    )
    step_number: Mapped[int] = mapped_column(Integer)
    tool_name: Mapped[str] = mapped_column(String(128))
    tool_args: Mapped[dict[str, Any]] = mapped_column(task_json)
    risk_level: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    approved_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    modified_args: Mapped[dict[str, Any] | None] = mapped_column(task_json, nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    timeout_ms: Mapped[int] = mapped_column(Integer, default=300000)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
