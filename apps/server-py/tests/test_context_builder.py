"""测试：ContextBuilder 短期记忆 Redis-first 读取 + PG 降级。

- Redis 命中：摘要 + 窗口来自 Redis，verify 关闭时零 PG 访问
- Redis miss / stale / 异常 / 禁用：回退 PG，行为与纯 PG 一致
- 返回结构（ContextResult）不变
"""

import fakeredis.aioredis
import pytest

import src.agent.redis_memory as rm
from src.agent.context_builder import ContextBuilder
from src.agent.redis_memory import RedisMemoryStore, StoredMessage
from src.models.chat import ConversationMemory, Message


def make_store(window_size: int = 20) -> RedisMemoryStore:
    return RedisMemoryStore(
        fakeredis.aioredis.FakeRedis(),
        message_ttl=604800,
        summary_ttl=2592000,
        window_size=window_size,
    )


def _msg(id_: str, content: str, *, role: str = "user") -> StoredMessage:
    return StoredMessage(
        version=1, id=id_, role=role, type="text", content=content,
        created_at="2026-08-02T10:00:00+00:00",
    )


def _pg_msg(id_: str, content: str, *, role: str = "user") -> Message:
    return Message(id=id_, conversation_id="c1", role=role, type="text", content=content)


async def _noop(*args, **kwargs):  # noqa: ANN002
    return None


class TestRedisHappyPath:
    """verify=off：窗口 + 摘要全部来自 Redis，零 PG 访问。"""

    @pytest.mark.asyncio
    async def test_redis_only_no_pg(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "你好", role="user"))
        await store.append_message("c1", _msg("m2", "你好，有什么可以帮你？", role="assistant"))
        await store.set_summary("c1", "用户咨询核身问题", covered_until_message_id="m1", token_count=5)

        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=False)
        result = await builder.build("c1", "还有问题吗")

        assert result.has_summary  # 既有行为：has_summary 为摘要字符串（truthy）
        assert result.history_count == 2
        # 摘要注入 SystemMessage
        system_contents = [
            m.content for m in result.messages
            if getattr(m, "type", "") == "system"
        ]
        assert any("历史对话摘要" in c and "用户咨询核身问题" in c for c in system_contents)
        # 组装顺序：system → m1(用户) → m2(AI) → 当前用户消息
        roles = [m.type for m in result.messages]
        assert roles == ["system", "human", "ai", "human"]
        assert result.messages[-1].content == "还有问题吗"
        # verify=off：db 从不被访问（传 None 也能跑通即证明）
        assert result.estimated_tokens > 0

    @pytest.mark.asyncio
    async def test_verify_on_fresh_window_uses_redis(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "redis 消息"))
        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=True)
        builder._load_memory = _noop  # 本测试聚焦窗口，摘要不注入

        async def latest(cid):  # noqa: ANN001
            return "m1"

        builder._latest_message_id = latest
        result = await builder.build("c1", "hi")
        assert result.messages[1].content == "redis 消息"
        assert result.history_count == 1

    @pytest.mark.asyncio
    async def test_internal_diagnosis_output_is_excluded_from_history(self):
        store = make_store()
        marker = "Blackboard（共享上下文）"
        await store.append_message("c1", _msg("m1", marker))
        await store.append_message("c1", _msg("m2", marker, role="assistant"))
        await store.append_message("c1", _msg("m3", "建议检查摄像头权限", role="assistant"))

        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=False)
        builder._load_memory = _noop
        result = await builder.build("c1", "还有哪些原因")

        assert [m.type for m in result.messages] == ["system", "human", "ai", "human"]
        assert result.messages[1].content == marker
        assert result.messages[2].content == "建议检查摄像头权限"
        assert result.history_count == 2


class TestFallback:
    """Redis miss / stale / 异常 → 回退 PG。"""

    @pytest.mark.asyncio
    async def test_window_miss_fallback_pg(self):
        store = make_store()  # 空窗口
        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=False)
        builder._load_recent_messages = _pg_msg_list  # type: ignore[method-assign]
        builder._load_memory = _noop
        result = await builder.build("c1", "hi")
        assert result.messages[1].content == "来自 PG"
        assert result.history_count == 1

    @pytest.mark.asyncio
    async def test_summary_miss_fallback_pg(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "redis 消息"))
        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=False)
        builder._load_recent_messages = _redis_messages  # type: ignore[method-assign]
        async def mem(cid):  # noqa: ANN001
            return ConversationMemory(
                id="mem1", conversation_id=cid, summary="PG 摘要", memory_type="summary",
                covered_until_message_id="m0", token_count=3,
            )
        builder._load_memory = mem
        result = await builder.build("c1", "hi")
        assert result.has_summary  # 既有行为：has_summary 为摘要字符串（truthy）
        assert any("PG 摘要" in m.content for m in result.messages if getattr(m, "type", "") == "system")

    @pytest.mark.asyncio
    async def test_verify_on_stale_window_fallback_pg(self):
        store = make_store()
        await store.append_message("c1", _msg("old", "过时窗口"))
        builder = ContextBuilder(db=None, memory_store=store, verify_latest_id=True)
        async def latest(cid):  # noqa: ANN001
            return "newer-id"  # PG 最新 != 窗口最后 → stale
        builder._latest_message_id = latest
        builder._load_recent_messages = _pg_msg_list  # type: ignore[method-assign]
        builder._load_memory = _noop
        result = await builder.build("c1", "hi")
        assert result.messages[1].content == "来自 PG"

    @pytest.mark.asyncio
    async def test_redis_error_fallback_pg(self):
        from tests.test_redis_memory import _BoomClient

        store = RedisMemoryStore(_BoomClient(), message_ttl=100, summary_ttl=100, window_size=20)
        builder = ContextBuilder(db=None, memory_store=store)
        builder._load_recent_messages = _pg_msg_list  # type: ignore[method-assign]
        builder._load_memory = _noop
        result = await builder.build("c1", "hi")  # 不抛异常
        assert result.messages[1].content == "来自 PG"


class TestNoRedis:
    """无存储（未启用/显式 None）→ 纯 PG 行为不变。"""

    @pytest.mark.asyncio
    async def test_disabled_uses_pg(self, monkeypatch):
        monkeypatch.setattr(rm.settings, "redis_memory_enabled", False)
        monkeypatch.setattr(rm, "_store", None)
        monkeypatch.setattr(rm, "_store_initialized", False)
        builder = ContextBuilder(db=None)  # get_memory_store() → None
        builder._load_recent_messages = _pg_msg_list  # type: ignore[method-assign]
        builder._load_memory = _noop
        result = await builder.build("c1", "hi")
        assert result.messages[1].content == "来自 PG"

    @pytest.mark.asyncio
    async def test_memory_store_none_returns_pg_shaped_result(self, monkeypatch):
        monkeypatch.setattr(rm.settings, "redis_memory_enabled", False)
        monkeypatch.setattr(rm, "_store", None)
        monkeypatch.setattr(rm, "_store_initialized", False)
        builder = ContextBuilder(db=None)  # get_memory_store() → None → 纯 PG
        builder._load_recent_messages = _pg_msg_list  # type: ignore[method-assign]
        builder._load_memory = _noop
        result = await builder.build("c1", "hi")
        assert isinstance(result.messages, list)
        assert result.messages[-1].content == "hi"
        assert result.history_count == 1
        # ContextResult 字段齐全
        assert result.has_summary is False
        assert result.estimated_tokens > 0


# ── 测试用的 loader 桩（接收 conversation_id）──────────────


async def _pg_msg_list(cid):  # noqa: ANN001
    return [_pg_msg("pg1", "来自 PG")]


async def _redis_messages(cid):  # noqa: ANN001
    return [Message(id="m1", conversation_id=cid, role="user", type="text", content="redis 消息")]
