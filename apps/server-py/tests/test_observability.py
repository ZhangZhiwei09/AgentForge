"""测试：Langfuse 可观测性。

Phase C: 验证 LangfuseProvider / Noop 降级 / try/catch 安全性。
"""

import pytest

from src.config import settings


class TestLangfuseProviderInit:
    """LangfuseProvider 初始化测试。"""

    def test_noop_when_disabled(self):
        """langfuse_enabled=False 时应返回 Noop Provider。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()
        # 默认 disabled + 无 keys → enabled=False
        assert provider.enabled is False

    def test_noop_when_no_keys(self, monkeypatch):
        """无 API Keys 时即使 enabled=True 也应降级到 Noop。"""
        monkeypatch.setattr(settings, "langfuse_enabled", True)
        monkeypatch.setattr(settings, "langfuse_public_key", "")
        monkeypatch.setattr(settings, "langfuse_secret_key", "")

        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()
        assert provider.enabled is False

    def test_noop_trace_does_not_crash(self):
        """Noop Trace 的 context manager 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()

        with provider.create_trace("test", input="hello") as trace:
            assert trace.trace_id is None

    @pytest.mark.asyncio
    async def test_noop_trace_async_context(self):
        """Noop Trace 的 async context manager 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()

        async with provider.create_trace("test-async", input="hello") as trace:
            assert trace.trace_id is None

    def test_noop_generation_does_not_crash(self):
        """Noop Generation 的 end() 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()

        gen = provider.create_generation("test-gen", model="gpt-4o")
        gen.end(output="test output", usage={"prompt_tokens": 10, "completion_tokens": 5})
        # 不应抛异常
        gen.end()  # 幂等

    def test_noop_tool_span_does_not_crash(self):
        """Noop Tool Span 的 end() 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()

        span = provider.create_tool_span("test-tool", input={"q": "test"})
        span.end(output={"result": "ok"})
        span.end()  # 幂等

    def test_noop_flush_shutdown_does_not_crash(self):
        """Noop flush/shutdown 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()
        provider.flush()
        # shutdown is async

    @pytest.mark.asyncio
    async def test_noop_shutdown_does_not_crash(self):
        """Noop shutdown 不应抛异常。"""
        from src.observability.langfuse_provider import LangfuseProvider
        provider = LangfuseProvider()
        await provider.shutdown()


class TestObservabilityLifecycle:
    """可观测性生命周期测试。"""

    def test_init_observability_returns_provider(self):
        """init_observability 应返回 Provider。"""
        from src.observability.langfuse_provider import LangfuseProvider, init_observability
        # 重置
        import src.observability.langfuse_provider as mod
        mod._provider = None

        provider = init_observability()
        assert isinstance(provider, LangfuseProvider)

    def test_get_observability_returns_same_instance(self):
        """get_observability 应返回相同实例。"""
        from src.observability.langfuse_provider import get_observability, init_observability
        import src.observability.langfuse_provider as mod
        mod._provider = None

        p1 = init_observability()
        p2 = get_observability()
        assert p1 is p2

    @pytest.mark.asyncio
    async def test_shutdown_clears_provider(self):
        """shutdown 应清除单例。"""
        from src.observability.langfuse_provider import (
            get_observability,
            init_observability,
            shutdown_observability,
        )
        import src.observability.langfuse_provider as mod
        mod._provider = None

        init_observability()
        await shutdown_observability()
        assert mod._provider is None
