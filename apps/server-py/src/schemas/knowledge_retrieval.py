"""Public knowledge search and regression request contracts."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

SearchMethod = Literal["hybrid", "semantic", "keyword"]
Nonempty = Annotated[str, Field(min_length=1)]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    kb_ids: list[str] | None = None
    top_k: int = Field(default=3, ge=1, le=20)


class HitTestingRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=10, ge=1, le=20)
    search_method: SearchMethod = "hybrid"
    reranking_enable: bool = True
    score_threshold: float = Field(default=0, ge=0, le=1)


class RetrievalConfig(BaseModel):
    searchMethod: SearchMethod = "hybrid"
    topK: int = Field(default=10, ge=1, le=20)
    rerankingEnable: bool = True
    scoreThreshold: float = Field(default=0, ge=0, le=1)


class TestSetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)


class RegressionCaseInput(BaseModel):
    testSetId: str | None = Field(default=None, min_length=1)
    name: str = Field(min_length=1, max_length=255)
    query: str = Field(min_length=1, max_length=1000)
    expectedDocTitles: list[Nonempty] = Field(default_factory=list)
    expectedDocIds: list[Nonempty] = Field(default_factory=list)
    requiredText: list[Nonempty] = Field(default_factory=list)
    forbiddenText: list[Nonempty] = Field(default_factory=list)
    expectedTopK: int = Field(default=5, ge=1, le=20)
    minScore: float | None = Field(default=None, ge=0, le=1)
    retrievalConfig: RetrievalConfig = Field(default_factory=RetrievalConfig)
    promptRequiredContextText: list[Nonempty] = Field(default_factory=list)


class RegressionRunInput(BaseModel):
    testSetId: str | None = Field(default=None, min_length=1)
