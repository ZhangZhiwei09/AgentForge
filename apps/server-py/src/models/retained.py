"""Retained workflow/team and routing audit tables from the shared schema."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, TimestampMixin

json_type = JSONB().with_variant(JSON(), "sqlite")
tags_type = ARRAY(String()).with_variant(JSON(), "sqlite")


class RouteClassificationLog(Base):
    __tablename__ = "route_classification_logs"
    __table_args__ = tuple(Index(f"ix_route_classification_log_{suffix}", column) for suffix, column in (
        ("source", "source"), ("route", "route"), ("session", "session_id"), ("created", "created_at"),
    ))
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str | None] = mapped_column(String(64))
    conversation_id: Mapped[str | None] = mapped_column(String(36))
    user_message: Mapped[str] = mapped_column(String(2000))
    route: Mapped[str] = mapped_column(String(20))
    confidence: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(20))
    top_matches: Mapped[dict | list | None] = mapped_column(json_type)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Workflow(Base, TimestampMixin):
    __tablename__ = "workflows"
    __table_args__ = (
        Index("ix_workflows_user_status", "user_id", "status"),
        Index("ix_workflows_user_id", "user_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    definition: Mapped[dict] = mapped_column(json_type)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    tags: Mapped[list[str]] = mapped_column(tags_type, default=list)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"
    __table_args__ = (
        Index("ix_workflow_runs_workflow", "workflow_id"),
        Index("ix_workflow_runs_user_status", "user_id", "status"),
        Index("ix_workflow_runs_started", "started_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workflow_id: Mapped[str] = mapped_column(String(36), ForeignKey("workflows.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="running")
    input: Mapped[dict] = mapped_column(json_type, default=dict)
    output: Mapped[dict | None] = mapped_column(json_type)
    checkpoint: Mapped[dict | None] = mapped_column(json_type)
    current_step_id: Mapped[str | None] = mapped_column(String(100))
    progress: Mapped[dict] = mapped_column(json_type, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WorkflowStepLog(Base):
    __tablename__ = "workflow_step_logs"
    __table_args__ = (
        Index("ix_workflow_step_logs_run", "run_id"),
        Index("ix_workflow_step_logs_run_step", "run_id", "step_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("workflow_runs.id", ondelete="CASCADE"))
    step_id: Mapped[str] = mapped_column(String(100))
    step_type: Mapped[str] = mapped_column(String(50))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    input: Mapped[dict | None] = mapped_column(json_type)
    output: Mapped[dict | None] = mapped_column(json_type)
    error: Mapped[str | None] = mapped_column(Text)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    events: Mapped[list] = mapped_column(json_type, default=list)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AgentTeam(Base, TimestampMixin):
    __tablename__ = "agent_teams"
    __table_args__ = (
        Index("agent_teams_user_id_idx", "user_id"), Index("agent_teams_status_idx", "status"),
        Index("agent_teams_updated_at_idx", "updated_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    definition: Mapped[dict] = mapped_column(json_type)
    tags: Mapped[list] = mapped_column(json_type, default=list)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    version: Mapped[int] = mapped_column(Integer, default=1)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AgentTeamRun(Base):
    __tablename__ = "agent_team_runs"
    __table_args__ = tuple(Index(f"agent_team_runs_{name}_idx", name) for name in (
        "team_id", "user_id", "status", "started_at",
    ))
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(String(36), ForeignKey("agent_teams.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    conversation_id: Mapped[str | None] = mapped_column(String(36))
    task: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="running")
    mode: Mapped[str] = mapped_column(String(20))
    messages: Mapped[list] = mapped_column(json_type, default=list)
    blackboard: Mapped[dict] = mapped_column(json_type, default=dict)
    checkpoint: Mapped[dict | None] = mapped_column(json_type)
    output: Mapped[dict | None] = mapped_column(json_type)
    error: Mapped[str | None] = mapped_column(Text)
    rounds_count: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
