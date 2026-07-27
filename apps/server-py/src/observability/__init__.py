"""可观测性模块 —— Langfuse + Noop。

Phase C: 添加 LangfuseProvider + 生命周期管理。
"""

from src.observability.langfuse_provider import (
    LangfuseProvider,
    ObservabilitySpan,
    ObservabilityTrace,
    get_observability,
    init_observability,
    shutdown_observability,
)
from src.observability.provider import (
    GenerationParams,
    NoopGeneration,
    NoopObservabilityProvider,
    NoopTrace,
    ObservabilityGeneration,
    ObservabilityProvider,
    ObservabilityTrace as ObservabilityTraceProtocol,
    TraceParams,
    noop_provider,
)

__all__ = [
    # legacy protocols
    "TraceParams",
    "GenerationParams",
    "ObservabilityTraceProtocol",
    "ObservabilityGeneration",
    "ObservabilityProvider",
    "NoopTrace",
    "NoopGeneration",
    "NoopObservabilityProvider",
    "noop_provider",
    # Phase C: Langfuse
    "LangfuseProvider",
    "ObservabilityTrace",
    "ObservabilitySpan",
    "init_observability",
    "get_observability",
    "shutdown_observability",
]
