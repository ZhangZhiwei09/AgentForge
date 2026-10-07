"""Flow configuration and immutable run snapshots, migrated through Prisma."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, TimestampMixin


class AgentFlow(Base, TimestampMixin):
    __tablename__ = "agent_flows"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    scene: Mapped[str] = mapped_column(String(30), default="diagnosis")
    draft: Mapped[dict] = mapped_column(JSONB)
    draft_revision: Mapped[int] = mapped_column(Integer, default=1)
    published: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    published_version: Mapped[int] = mapped_column(Integer, default=0)
    published_revision: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_by: Mapped[str] = mapped_column(String(36))


class AgentFlowRun(Base):
    __tablename__ = "agent_flow_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    flow_id: Mapped[str] = mapped_column(String(36), ForeignKey("agent_flows.id"))
    version: Mapped[int] = mapped_column(Integer)
    draft_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSONB)
    actor_id: Mapped[str] = mapped_column(String(36))
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    test: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(30), default="running")
    records: Mapped[dict] = mapped_column(JSONB, default=dict)
    output: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )
