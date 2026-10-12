"""Map existing entry routing tables without changing production schema."""

from typing import ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, TimestampMixin

entry_json = JSONB(none_as_null=True).with_variant(JSON(none_as_null=True), "sqlite")


class EntryRouteFlow(Base, TimestampMixin):
    __tablename__ = "entry_route_flows"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (
        CheckConstraint("NOT enabled OR (published IS NOT NULL AND published_version > 0 AND NOT archived)",
                        name="entry_route_flows_enabled_published"),
        CheckConstraint("draft_revision > 0 AND published_version >= 0 AND published_revision >= 0 AND published_revision <= draft_revision",
                        name="entry_route_flows_revisions"),
        Index("entry_route_flows_one_enabled", text("(true)"), unique=True,
              postgresql_where=text("enabled = true"), sqlite_where=text("enabled = true")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    draft: Mapped[dict] = mapped_column(entry_json)
    draft_revision: Mapped[int] = mapped_column(Integer, default=1)
    published: Mapped[dict | None] = mapped_column(entry_json, nullable=True)
    published_version: Mapped[int] = mapped_column(Integer, default=0)
    published_revision: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_by: Mapped[str] = mapped_column(String(36))


class EntryRouteFlowRun(Base, TimestampMixin):
    __tablename__ = "entry_route_flow_runs"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (
        CheckConstraint("status IN ('running', 'completed', 'failed', 'cancelled')",
                        name="entry_route_flow_runs_status"),
        Index("entry_route_flow_runs_flow_id_created_at_id_idx", "flow_id", "created_at", "id"),
        Index("entry_route_flow_runs_conversation_id_idx", "conversation_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    flow_id: Mapped[str] = mapped_column(String(36), ForeignKey("entry_route_flows.id", ondelete="RESTRICT"))
    version: Mapped[int] = mapped_column(Integer)
    draft_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot: Mapped[dict] = mapped_column(entry_json)
    actor_id: Mapped[str] = mapped_column(String(36))
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assistant_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    test: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="running")
    input_summary: Mapped[str] = mapped_column(String(2000), default="")
    records: Mapped[list] = mapped_column(entry_json, default=list)
    output: Mapped[dict | None] = mapped_column(entry_json, nullable=True)
    terminal_node_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
