"""API contracts for durable Agent evaluation suites and runs."""

from typing import Any

from pydantic import BaseModel, Field


class EvaluationSuiteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    version: str = Field(default="1", min_length=1, max_length=32)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvaluationCaseCreate(BaseModel):
    caseId: str = Field(min_length=1, max_length=255)
    question: str = Field(min_length=1, max_length=16000)
    model: str | None = Field(default=None, max_length=255)
    intent: str = Field(default="", max_length=100)
    expected: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvaluationRunCreate(BaseModel):
    caseIds: list[str] | None = None
    selector: str | None = Field(default=None, max_length=255)
    model: str | None = Field(default=None, max_length=255)
    judgeModel: str | None = Field(default=None, max_length=255)
    maxConcurrency: int = Field(default=1, ge=1, le=20)

