"""Typed contracts for Agent evaluation cases, snapshots, and reports."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from src.agent.types import RouteName


class RetrievalHitSnapshot(BaseModel):
    document_id: str = ""
    document_title: str = ""
    heading: str | None = None
    score: float = 0
    excerpt: str = ""


class ExpectedOutcome(BaseModel):
    """Assertions that can be checked against one Agent run."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    route: RouteName | str | None = None
    allowed_tools: list[str] | None = Field(default=None, alias="allowedTools")
    required_tools: list[str] = Field(default_factory=list, alias="requiredTools")
    forbidden_tools: list[str] = Field(default_factory=list, alias="forbiddenTools")
    required_text: list[str] = Field(default_factory=list, alias="requiredText")
    forbidden_text: list[str] = Field(default_factory=list, alias="forbiddenText")
    answer_required: bool | None = Field(default=True, alias="answerRequired")
    fallback_used: bool | None = Field(default=None, alias="fallbackUsed")
    intent: str | None = None
    require_retrieve: bool | None = Field(default=None, alias="requireRetrieve")
    require_web: bool | None = Field(default=None, alias="requireWeb")
    forbid_retrieve: bool | None = Field(default=None, alias="forbidRetrieve")
    forbid_graph: bool | None = Field(default=None, alias="forbidGraph")
    forbid_web: bool | None = Field(default=None, alias="forbidWeb")
    expect_rewrite: bool | None = Field(default=None, alias="expectRewrite")
    expect_refusal: bool | None = Field(default=None, alias="expectRefusal")
    relevant_doc_titles: list[str] = Field(default_factory=list, alias="relevantDocTitles")
    relevant_doc_ids: list[str] = Field(default_factory=list, alias="relevantDocIds")
    expected_top_k: int = Field(default=5, ge=1, le=20, alias="expectedTopK")
    min_score: float | None = Field(default=None, ge=0, le=1, alias="minScore")
    key_points: list[str] = Field(default_factory=list, alias="keyPoints")
    must_not_contain: list[str] = Field(default_factory=list, alias="mustNotContain")
    judge_groundedness: bool | None = Field(default=None, alias="judgeGroundedness")
    judge_dimensions: list[str] = Field(default_factory=list, alias="judgeDimensions")
    judge_min_score: float = Field(default=0.7, ge=0, le=1, alias="judgeMinScore")


class EvalCase(BaseModel):
    """Versioned golden case consumed by the evaluation harness."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    question: str = Field(min_length=1)
    suite: str = "default"
    version: str = "1"
    model: str | None = None
    intent: str = ""
    expected: ExpectedOutcome = Field(default_factory=ExpectedOutcome)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ToolCallSnapshot(BaseModel):
    """A best-effort record of a tool invocation observed during a run."""

    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    result: Any = None
    status: str | None = None
    duration_ms: float | None = None
    source: Literal["event", "observer"] = "event"


class RuntimeSnapshot(BaseModel):
    """Serializable facts captured from one Agent execution."""

    case_id: str
    question: str
    answer: str = ""
    route: str | None = None
    intent: str = ""
    tools: list[ToolCallSnapshot] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)
    retrieve_count: int = 0
    graph_queries: list[str] = Field(default_factory=list)
    graph_used: bool = False
    web_used: bool = False
    rewritten: bool = False
    retry_query: str | None = None
    retrieve_query: str | None = None
    raw_hits: list[RetrievalHitSnapshot] = Field(default_factory=list)
    graded_hits: list[RetrievalHitSnapshot] = Field(default_factory=list)
    web_snippet: str = ""
    trace_steps: list[dict[str, Any]] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    fallback_used: bool | None = None
    latency_ms: float = 0
    status: Literal["completed", "error"] = "completed"
    metadata: dict[str, Any] = Field(default_factory=dict)


class MetricResult(BaseModel):
    """One deterministic or semantic evaluation result."""

    name: str
    status: Literal["pass", "fail", "skipped", "error"]
    score: float | None = Field(default=None, ge=0, le=1)
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)


class EvalCaseReport(BaseModel):
    case_id: str
    snapshot: RuntimeSnapshot
    metrics: list[MetricResult] = Field(default_factory=list)
    passed: bool
    score: float | None = Field(default=None, ge=0, le=1)


class EvalRunReport(BaseModel):
    """JSON report for a complete evaluation run."""

    schema_version: str = "1"
    judge_model: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    cases: list[EvalCaseReport] = Field(default_factory=list)
    total_cases: int = 0
    passed_cases: int = 0
    failed_cases: int = 0
    error_cases: int = 0

    @classmethod
    def from_cases(
        cls,
        reports: list[EvalCaseReport],
        *,
        judge_model: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "EvalRunReport":
        return cls(
            judge_model=judge_model,
            metadata=metadata or {},
            cases=reports,
            total_cases=len(reports),
            passed_cases=sum(report.passed for report in reports),
            failed_cases=sum(not report.passed for report in reports),
            error_cases=sum(
                any(metric.status == "error" for metric in report.metrics)
                for report in reports
            ),
        )
