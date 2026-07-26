"""可观测性模块 —— Trace / Generation 抽象层。

对应 TS: apps/server/src/observability/provider.ts

设计要点：
- Runtime 只依赖此抽象，不感知具体后端（Langfuse / OTel）
- NoopProvider：可观测性禁用时的空实现
- Provider Protocol：所有观测后端必须实现的接口

Python 新概念：
- Protocol + Noop 模式：类似 TS 的 interface + noop class
"""

from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Protocol


# ═══════════════════════════════════════════════════════════
# 参数类型
# ═══════════════════════════════════════════════════════════


@dataclass(slots=True)
class TraceParams:
    """Trace 创建参数。"""
    name: str
    input: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class GenerationParams:
    """Generation（LLM 调用）创建参数。"""
    name: str
    model: str
    input: Any = None
    output: Any = None
    usage: dict[str, int] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════
# 协议
# ═══════════════════════════════════════════════════════════


class ObservabilityGeneration(Protocol):
    """单次 LLM 调用记录。"""

    def update(self, output: Any = None, usage: dict[str, int] | None = None) -> None:
        """更新 Generation 元数据。"""
        ...

    def end(self, output: Any = None, usage: dict[str, int] | None = None) -> None:
        """结束 Generation。幂等。"""
        ...


class ObservabilityTrace(Protocol):
    """单次请求的完整 Trace。"""

    def generation(self, params: GenerationParams) -> Any:
        """创建子 Generation（LLM 调用记录）。"""
        ...

    def update(self, output: Any = None, metadata: dict[str, Any] | None = None) -> None:
        """更新 Trace 级别元数据。"""
        ...

    def end(self) -> None:
        """结束 Trace。幂等。"""
        ...


class ObservabilityProvider(Protocol):
    """可观测性 Provider 协议。"""

    @property
    def name(self) -> str:
        """Provider 名称（langfuse / noop / otel）。"""
        ...

    def create_trace(self, params: TraceParams) -> ObservabilityTrace:
        """创建 Trace。启用时返回真实 Trace，禁用时返回 NoopTrace。"""
        ...

    def shutdown(self) -> Awaitable[None]:
        """优雅关闭，flush 待发送数据。"""
        ...


# ═══════════════════════════════════════════════════════════
# Noop 实现 —— 可观测性禁用时使用
# ═══════════════════════════════════════════════════════════


class NoopGeneration:
    """空 Generation：什么都不记录。"""

    def update(self, output: Any = None, usage: dict[str, int] | None = None) -> None:
        pass

    def end(self, output: Any = None, usage: dict[str, int] | None = None) -> None:
        pass


class NoopTrace:
    """空 Trace：什么都不记录。"""

    def generation(self, params: GenerationParams) -> NoopGeneration:
        return NoopGeneration()

    def update(self, output: Any = None, metadata: dict[str, Any] | None = None) -> None:
        pass

    def end(self) -> None:
        pass


class NoopObservabilityProvider:
    """空可观测性 Provider —— 禁用时使用。"""

    name = "noop"

    def create_trace(self, params: TraceParams) -> NoopTrace:
        return NoopTrace()

    async def shutdown(self) -> None:
        pass


# 模块级默认实例
noop_provider = NoopObservabilityProvider()
