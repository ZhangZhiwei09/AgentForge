"""Server-owned execution limits, shared by HTTP, resumes and tool dispatch."""

from dataclasses import dataclass, replace

from pydantic import BaseModel, ConfigDict

from src.agent.task_guard import TaskGuardConfig
from src.config import settings

# These adapters lack scoped credentials / an approved isolation boundary.
# Configuration alone must not reopen them, including for administrators.
DISABLED_TOOLS = frozenset({
    "web_search", "web_fetch", "http_request", "file_read", "file_write",
    "file_search", "db_query", "create_support_ticket",
})


def platform_tool_names() -> frozenset[str]:
    names = set(settings.agent_allowed_tools) - DISABLED_TOOLS - {"query_trace_log"}
    if settings.monitoring_mode == "mock" and settings.app_env != "production":
        names.add("query_trace_log")
    return frozenset(names)


class EffectiveExecutionPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    version: int = 1
    tools: tuple[str, ...]
    max_tokens: int
    max_cost_cents: float
    max_iterations: int

    def guard_config(self) -> TaskGuardConfig:
        return TaskGuardConfig(
            max_tokens=self.max_tokens, max_cost_cents=self.max_cost_cents,
            allowed_tools=list(self.tools), pii_detection_enabled=True, content_safety_enabled=True,
        )

    def intersect(self, other: "EffectiveExecutionPolicy") -> "EffectiveExecutionPolicy":
        return EffectiveExecutionPolicy(
            tools=tuple(sorted(set(self.tools) & set(other.tools))),
            max_tokens=min(self.max_tokens, other.max_tokens),
            max_cost_cents=min(self.max_cost_cents, other.max_cost_cents),
            max_iterations=min(self.max_iterations, other.max_iterations),
        )


def build_execution_policy(
    requested_guard: TaskGuardConfig | None = None,
    requested_tools: list[str] | None = None,
    requested_iterations: int | None = None,
) -> EffectiveExecutionPolicy:
    guard = requested_guard or TaskGuardConfig()
    names = platform_tool_names()
    if requested_tools is not None:
        names &= set(requested_tools)
    if guard.allowed_tools:
        names &= set(guard.allowed_tools)
    names -= set(guard.denied_tools)
    return EffectiveExecutionPolicy(
        tools=tuple(sorted(names)),
        max_tokens=min(settings.agent_max_tokens, guard.max_tokens),
        max_cost_cents=min(settings.agent_max_cost_cents, guard.max_cost_cents),
        max_iterations=min(settings.agent_max_iterations, requested_iterations or 10),
    )


@dataclass(frozen=True, slots=True)
class ToolExecutionContext:
    actor_id: str
    conversation_id: str
    run_id: str
    policy: EffectiveExecutionPolicy

    def __post_init__(self):
        if not self.actor_id or not self.conversation_id or not self.run_id:
            raise ValueError("Tool execution requires a server-owned identity and run")

    def restrict(self, policy: EffectiveExecutionPolicy) -> "ToolExecutionContext":
        return replace(self, policy=self.policy.intersect(policy))
