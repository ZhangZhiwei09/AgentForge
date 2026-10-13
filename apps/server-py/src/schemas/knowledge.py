"""Knowledge management validation, including merged persisted settings."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from src.config import settings


class ChunkSettings(BaseModel):
    chunk_size_tokens: int | None = Field(default=None, ge=50, le=4000)
    chunk_overlap_tokens: int | None = Field(default=None, ge=0)
    separator_mode: Literal["auto", "custom"] | None = None
    custom_separator: str | None = Field(default=None, min_length=1, max_length=100)
    chunk_structure: Literal["paragraph", "hierarchical"] | None = None
    child_chunk_size_tokens: int | None = Field(default=None, ge=50, le=2000)
    child_chunk_overlap_tokens: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_budgets(self):
        size = self.chunk_size_tokens if self.chunk_size_tokens is not None else settings.chunk_size_tokens
        overlap = self.chunk_overlap_tokens if self.chunk_overlap_tokens is not None else settings.chunk_overlap_tokens
        if overlap >= size * 0.5:
            raise ValueError("chunk_overlap_tokens must be less than chunk_size_tokens * 0.5")
        if self.separator_mode == "custom" and not self.custom_separator:
            raise ValueError("custom_separator is required when separator_mode is custom")
        if self.chunk_structure == "hierarchical":
            child_size = self.child_chunk_size_tokens if self.child_chunk_size_tokens is not None else 400
            child_overlap = self.child_chunk_overlap_tokens if self.child_chunk_overlap_tokens is not None else 60
            if child_overlap >= child_size * 0.5:
                raise ValueError("child_chunk_overlap_tokens must be less than child_chunk_size_tokens * 0.5")
        return self


class KnowledgeBaseCreate(ChunkSettings):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    remove_extra_spaces: bool = True
    remove_urls_emails: bool = False


class KnowledgeBaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    enabled: bool | None = None
    chunk_size_tokens: int | None = Field(default=None, ge=50, le=4000)
    chunk_overlap_tokens: int | None = Field(default=None, ge=0)
    separator_mode: Literal["auto", "custom"] | None = None
    custom_separator: str | None = Field(default=None, min_length=1, max_length=100)
    chunk_structure: Literal["paragraph", "hierarchical"] | None = None
    child_chunk_size_tokens: int | None = Field(default=None, ge=50, le=2000)
    child_chunk_overlap_tokens: int | None = Field(default=None, ge=0)
    remove_extra_spaces: bool | None = None
    remove_urls_emails: bool | None = None

    @model_validator(mode="after")
    def reject_null_required_fields(self):
        required = {
            "name", "enabled", "remove_extra_spaces", "remove_urls_emails",
        }
        if any(getattr(self, field) is None for field in required & self.model_fields_set):
            raise ValueError("Required fields cannot be null")
        return self


class ChunkPreview(ChunkSettings):
    text: str = Field(min_length=1, max_length=100000)


class ChunkUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=100000)

    @model_validator(mode="after")
    def trim_content(self):
        self.content = self.content.strip()
        if not self.content:
            raise ValueError("content cannot be blank")
        return self
