"""Mappings for existing knowledge evaluation and query audit tables."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base

JSON_TYPE = JSON().with_variant(JSONB, "postgresql")


class EvaluationRecord(Base):
    __abstract__ = True
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class KnowledgeQueryLog(EvaluationRecord):
    __tablename__ = "knowledge_query_logs"
    kb_id: Mapped[str] = mapped_column(String(36))
    query: Mapped[str] = mapped_column(String(1000))
    method: Mapped[str] = mapped_column(String(20), default="hybrid")
    results: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(20), default="hit_testing")
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)


class KnowledgeRegressionTestSet(EvaluationRecord):
    __tablename__ = "knowledge_regression_test_sets"
    kb_id: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class KnowledgeRegressionCase(EvaluationRecord):
    __tablename__ = "knowledge_regression_cases"
    test_set_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("knowledge_regression_test_sets.id", ondelete="CASCADE"),
    )
    kb_id: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(255))
    query: Mapped[str] = mapped_column(String(1000))
    expected_top_k: Mapped[int] = mapped_column(Integer, default=5)
    min_score: Mapped[float | None] = mapped_column(Float)
    search_method: Mapped[str] = mapped_column(String(20), default="hybrid")
    top_k: Mapped[int] = mapped_column(Integer, default=10)
    reranking_enable: Mapped[bool] = mapped_column(Boolean, default=True)
    score_threshold: Mapped[float] = mapped_column(Float, default=0)
    expected_doc_titles: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    expected_doc_ids: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    required_text: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    forbidden_text: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    prompt_required_context_text: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class KnowledgeRegressionRun(EvaluationRecord):
    __tablename__ = "knowledge_regression_runs"
    test_set_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("knowledge_regression_test_sets.id", ondelete="CASCADE"),
    )
    kb_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(20), default="running")
    total_cases: Mapped[int] = mapped_column(Integer, default=0)
    passed_cases: Mapped[int] = mapped_column(Integer, default=0)
    failed_cases: Mapped[int] = mapped_column(Integer, default=0)
    hit_rate: Mapped[float] = mapped_column(Float, default=0)
    average_rank: Mapped[float | None] = mapped_column(Float)
    average_elapsed_ms: Mapped[float | None] = mapped_column(Float)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KnowledgeRegressionRunItem(EvaluationRecord):
    __tablename__ = "knowledge_regression_run_items"
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_regression_runs.id", ondelete="CASCADE"))
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_regression_cases.id", ondelete="CASCADE"))
    passed: Mapped[bool] = mapped_column(Boolean)
    rank: Mapped[int | None] = mapped_column(Integer)
    score: Mapped[float | None] = mapped_column(Float)
    matched_doc_id: Mapped[str | None] = mapped_column(String(36))
    failure_reason: Mapped[str | None] = mapped_column(String(2000))
    results_snapshot: Mapped[list] = mapped_column(JSON_TYPE, default=list)
    prompt_snapshot: Mapped[str | None] = mapped_column(Text)
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
