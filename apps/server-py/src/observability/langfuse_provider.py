"""LangfuseProvider —— Langfuse 4.x 可观测性 Provider。

Phase C V1 埋点（共 4 处）:
    - chat.py:           Trace "chat-request"
    - AgentExecutor:     Generation "agent-reAct-{N}"
    - ToolRegistry:      Generation "tool-{name}"
    - DiagnosisMode:     Generation "diag-{agent_name}"

安全模式:
    - langfuse_enabled=false → NoopLangfuseProvider（默认）
    - Langfuse SDK 抛异常 → catch，不传播
    - Langfuse SDK 未安装 → try/except ImportError，降级到 Noop
"""

import logging
from contextlib import contextmanager
from typing import Any

from src.config import settings

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# Trace Context 类型
# ═══════════════════════════════════════════════════════════


class ObservabilitySpan:
    """单个观测 Span（Generation / Tool / Span 的抽象）。

    封装 Langfuse 4.x 的 observation 对象。
    """

    def __init__(self, observation: Any) -> None:
        self._obs = observation
        self._ended = False

    @property
    def trace_id(self) -> str | None:
        """当前 trace ID。"""
        try:
            return self._obs.trace_id
        except Exception:
            return None

    def end(
        self,
        output: Any = None,
        usage: dict[str, int] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """结束此 Span。幂等。"""
        if self._ended:
            return
        self._ended = True
        try:
            kwargs: dict[str, Any] = {}
            if output is not None:
                kwargs["output"] = output
            if usage:
                kwargs["usage_details"] = {
                    "input": usage.get("prompt_tokens", 0),
                    "output": usage.get("completion_tokens", 0),
                    "total": usage.get("total_tokens", 0),
                }
            if metadata:
                kwargs["metadata"] = metadata
            self._obs.end(**kwargs)
        except Exception as exc:
            logger.debug("Langfuse end() failed: %s", exc)


class ObservabilityTrace:
    """顶层 Trace 封装（Langfuse 4.x 的 context manager observation）。"""

    def __init__(self, ctx_manager: Any, observation: Any) -> None:
        self._ctx = ctx_manager
        self._obs = observation
        self._entered = False

    @property
    def trace_id(self) -> str | None:
        try:
            return self._obs.trace_id
        except Exception:
            return None

    def __enter__(self) -> "ObservabilityTrace":
        self._ctx.__enter__()
        self._entered = True
        return self

    def __exit__(self, *args: Any) -> None:
        if self._entered:
            try:
                self._ctx.__exit__(*args)
            except Exception as exc:
                logger.debug("Langfuse trace exit failed: %s", exc)
            self._entered = False

    async def __aenter__(self) -> "ObservabilityTrace":
        self.__enter__()
        return self

    async def __aexit__(self, *args: Any) -> None:
        self.__exit__(*args)

    def end(self, output: Any = None, metadata: dict[str, Any] | None = None) -> None:
        """手动结束 Trace（如果没用 context manager）。"""
        if not self._entered:
            return
        try:
            kwargs: dict[str, Any] = {}
            if output is not None:
                kwargs["output"] = output
            if metadata:
                kwargs["metadata"] = metadata
            self._obs.end(**kwargs)
        except Exception as exc:
            logger.debug("Langfuse trace end() failed: %s", exc)
        self._entered = False


# ═══════════════════════════════════════════════════════════
# LangfuseProvider
# ═══════════════════════════════════════════════════════════


class LangfuseProvider:
    """Langfuse 4.x 可观测性 Provider。

    所有 Langfuse 调用由 try/catch 保护，绝不 crash 主流程。
    """

    def __init__(self) -> None:
        self._client = None
        self._init_client()

    def _init_client(self) -> None:
        """惰性初始化 Langfuse 客户端（try/catch 保护）。"""
        if not settings.langfuse_enabled:
            logger.debug("Langfuse disabled by config")
            return

        if not settings.langfuse_public_key or not settings.langfuse_secret_key:
            logger.warning(
                "Langfuse enabled but keys not configured. "
                "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env"
            )
            return

        try:
            from langfuse import Langfuse  # noqa: PLC0415

            self._client = Langfuse(
                public_key=settings.langfuse_public_key,
                secret_key=settings.langfuse_secret_key,
                base_url=settings.langfuse_base_url,
            )
            logger.info(
                "Langfuse initialized: %s", settings.langfuse_base_url
            )
        except ImportError:
            logger.warning(
                "Langfuse SDK not installed. Observability disabled."
            )
        except Exception as exc:
            logger.error("Langfuse init failed: %s", exc)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    # ── Trace ─────────────────────────────────────────────

    def create_trace(
        self,
        name: str,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> ObservabilityTrace:
        """创建顶层 Trace（context manager）。

        用法:
            with provider.create_trace("chat-request", input=msg) as trace:
                # ... nested observations ...
        """
        if not self._client:
            return _noop_trace()

        try:
            kwargs: dict[str, Any] = {"name": name}
            if input is not None:
                kwargs["input"] = input
            if metadata:
                kwargs["metadata"] = metadata

            # Langfuse 4.x: start_as_current_observation 返回 context manager
            ctx = self._client.start_as_current_observation(**kwargs)
            obs = ctx.__enter__()
            return ObservabilityTrace(ctx, obs)
        except Exception as exc:
            logger.warning("Langfuse create_trace failed: %s", exc)
            return _noop_trace()

    # ── Generation（LLM 调用）────────────────────────────

    def create_generation(
        self,
        name: str,
        model: str = "",
        input: Any = None,
        output: Any = None,
        usage: dict[str, int] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ObservabilitySpan:
        """创建 Generation（LLM 调用记录）。

        Args:
            name: 名称，如 "agent-reAct-1"
            model: 模型名，如 "gpt-4o-mini"
            input: 输入（prompt/messages）
            output: 输出（completion）
            usage: token 统计 {"prompt_tokens": N, "completion_tokens": N, "total_tokens": N}
            metadata: 额外元数据

        Returns:
            ObservabilitySpan，需调用 .end() 或自动在 context manager 中结束
        """
        if not self._client:
            return _noop_span()

        try:
            kwargs: dict[str, Any] = {
                "name": name,
                "as_type": "generation",
            }
            if model:
                kwargs["model"] = model
            if input is not None:
                kwargs["input"] = input
            if output is not None:
                kwargs["output"] = output
            if usage:
                kwargs["usage_details"] = {
                    "input": usage.get("prompt_tokens", 0),
                    "output": usage.get("completion_tokens", 0),
                    "total": usage.get("total_tokens", 0),
                }
            if metadata:
                kwargs["metadata"] = metadata

            obs = self._client.start_observation(**kwargs)
            return ObservabilitySpan(obs)
        except Exception as exc:
            logger.debug("Langfuse create_generation failed: %s", exc)
            return _noop_span()

    # ── Tool Span ─────────────────────────────────────────

    def create_tool_span(
        self,
        name: str,
        input: Any = None,
        output: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> ObservabilitySpan:
        """创建 Tool 执行 Span。

        Args:
            name: 工具名，如 "search_knowledge_base"
            input: 工具参数
            output: 工具返回值
            metadata: 额外元数据
        """
        if not self._client:
            return _noop_span()

        try:
            kwargs: dict[str, Any] = {
                "name": name,
                "as_type": "tool",
            }
            if input is not None:
                kwargs["input"] = input
            if output is not None:
                kwargs["output"] = output
            if metadata:
                kwargs["metadata"] = metadata

            obs = self._client.start_observation(**kwargs)
            return ObservabilitySpan(obs)
        except Exception as exc:
            logger.debug("Langfuse create_tool_span failed: %s", exc)
            return _noop_span()

    # ── Lifecycle ─────────────────────────────────────────

    def flush(self) -> None:
        """刷新待发送数据。"""
        if not self._client:
            return
        try:
            self._client.flush()
        except Exception as exc:
            logger.debug("Langfuse flush failed: %s", exc)

    async def shutdown(self) -> None:
        """优雅关闭，确保数据不丢失。"""
        if not self._client:
            return
        try:
            self._client.flush()
            self._client.shutdown()
            logger.info("Langfuse shutdown complete")
        except Exception as exc:
            logger.debug("Langfuse shutdown failed: %s", exc)


# ═══════════════════════════════════════════════════════════
# Noop 实现 —— Langfuse 禁用/异常时使用
# ═══════════════════════════════════════════════════════════


class _NoopSpan:
    """空 Span：什么都不记录。"""

    trace_id: str | None = None

    def end(self, **kwargs: Any) -> None:
        pass


class _NoopTraceContext:
    """空 Trace Context Manager。"""

    trace_id: str | None = None

    def __enter__(self) -> "_NoopTraceContext":
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    async def __aenter__(self) -> "_NoopTraceContext":
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass

    def end(self, **kwargs: Any) -> None:
        pass


def _noop_span() -> ObservabilitySpan:
    return ObservabilitySpan(_NoopSpan())


def _noop_trace() -> ObservabilityTrace:
    noop = _NoopTraceContext()
    return ObservabilityTrace(noop, noop)


# ═══════════════════════════════════════════════════════════
# 模块级单例 + 生命周期
# ═══════════════════════════════════════════════════════════

_provider: LangfuseProvider | None = None


def init_observability() -> LangfuseProvider:
    """初始化可观测性 Provider（幂等）。

    main.py startup 时调用。
    """
    global _provider
    if _provider is not None:
        return _provider

    _provider = LangfuseProvider()
    if _provider.enabled:
        logger.info("Observability: Langfuse enabled")
    else:
        logger.info("Observability: Noop (disabled or unconfigured)")
    return _provider


def get_observability() -> LangfuseProvider:
    """获取可观测性 Provider。

    如果未初始化，自动创建（可能为 Noop）。
    """
    global _provider
    if _provider is None:
        _provider = LangfuseProvider()
    return _provider


async def shutdown_observability() -> None:
    """关闭可观测性 Provider。

    main.py shutdown 时调用。
    """
    global _provider
    if _provider is not None:
        await _provider.shutdown()
        _provider = None
