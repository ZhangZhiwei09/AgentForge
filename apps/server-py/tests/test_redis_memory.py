"""测试：Redis 短期记忆存储层（RedisMemoryStore / mirror_message）。

不依赖真实 Redis，使用 fakeredis 伪 Redis + 构造的假 DB。
验证：滑动窗口裁剪、TTL、自愈重建、版本校验、Redis 故障零影响、结构化日志。
"""

import asyncio
import json
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest
import redis

import src.agent.redis_memory as rm
from src.agent.redis_memory import (
    RedisMemoryStore,
    StoredMessage,
    mirror_message,
)
from src.models.chat import Message

MESSAGE_KEY = "agentforge:conv:c1:messages"


def make_store(window_size: int = 20) -> RedisMemoryStore:
    return RedisMemoryStore(
        fakeredis.aioredis.FakeRedis(),
        message_ttl=604800,
        summary_ttl=2592000,
        window_size=window_size,
    )


def _msg(id_: str, content: str, *, role: str = "user", ts: str = "2026-08-02T10:00:00+00:00") -> StoredMessage:
    return StoredMessage(
        version=1, id=id_, role=role, type="text", content=content, created_at=ts
    )


class _BoomClient:
    """所有 Redis 命令都抛连接错误的假客户端，用于验证故障零影响。"""

    async def _raise(self, *args, **kwargs):  # noqa: ANN002
        raise redis.exceptions.ConnectionError("simulated redis down")

    exists = _raise
    get = _raise
    setex = _raise
    lrange = _raise
    delete = _raise

    def pipeline(self):
        raise redis.exceptions.ConnectionError("simulated redis down")


class _ScalarsResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        class _Scalars:
            def __init__(self, rows):
                self._rows = rows

            def all(self):
                return self._rows

        return _Scalars(self._rows)


class _FakeDbForRecent:
    """假 DB：execute 返回最近消息行（调用方内部会 reverse）。"""

    def __init__(self, rows):
        self._rows = rows

    async def execute(self, stmt):  # noqa: ANN001
        return _ScalarsResult(self._rows)


class TestMessageWindow:
    """消息窗口：滑动裁剪 / TTL / 读写往返。"""

    @pytest.mark.asyncio
    async def test_window_slides_keep_recent_n(self):
        store = make_store(window_size=3)
        for i in range(6):
            await store.append_message("c1", _msg(f"m{i}", str(i), ts=f"t{i}"))
        window = await store.get_window("c1")
        assert window is not None
        assert [m.id for m in window] == ["m3", "m4", "m5"]

    @pytest.mark.asyncio
    async def test_append_refreshes_ttl(self):
        store = RedisMemoryStore(
            fakeredis.aioredis.FakeRedis(), message_ttl=100, summary_ttl=100, window_size=20
        )
        await store.append_message("c1", _msg("m1", "a"))
        ttl = await store._client.ttl(MESSAGE_KEY)
        assert 0 < ttl <= 100

    @pytest.mark.asyncio
    async def test_window_roundtrip(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "hello", role="user"))
        await store.append_message("c1", _msg("m2", "hi", role="assistant"))
        window = await store.get_window("c1")
        assert window is not None
        assert len(window) == 2
        assert window[0].id == "m1" and window[0].role == "user"
        assert window[1].id == "m2" and window[1].role == "assistant"
        assert window[0].version == 1

    @pytest.mark.asyncio
    async def test_rebuild_window(self):
        store = make_store(window_size=3)
        msgs = [_msg(f"m{i}", str(i)) for i in range(3)]
        await store.rebuild_window("c1", msgs)
        window = await store.get_window("c1")
        assert window is not None
        assert [m.id for m in window] == ["m0", "m1", "m2"]

    @pytest.mark.asyncio
    async def test_corrupt_element_returns_none(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "ok"))
        await store._client.rpush(MESSAGE_KEY, "{not valid json")
        assert await store.get_window("c1") is None

    @pytest.mark.asyncio
    async def test_version_mismatch_returns_none(self):
        store = make_store()
        await store._client.rpush(
            MESSAGE_KEY,
            json.dumps({"version": 999, "id": "x", "role": "user", "content": "y", "created_at": "t"}),
        )
        assert await store.get_window("c1") is None


class TestSummary:
    """摘要：读写往返 / 幂等 / covered_until 保留。"""

    @pytest.mark.asyncio
    async def test_summary_roundtrip_and_idempotent(self):
        store = make_store()
        await store.set_summary("c1", "第一次", "msg5", 10)
        await store.set_summary("c1", "第二次", "msg8", 15)
        got = await store.get_summary("c1")
        assert got is not None
        assert got.summary == "第二次"
        assert got.covered_until_message_id == "msg8"
        assert got.token_count == 15
        assert got.version == 1
        assert got.updated_at

    @pytest.mark.asyncio
    async def test_summary_miss_returns_none(self):
        store = make_store()
        assert await store.get_summary("c1") is None


class TestDelete:
    """会话清理。"""

    @pytest.mark.asyncio
    async def test_delete_conversation(self):
        store = make_store()
        await store.append_message("c1", _msg("m1", "a"))
        await store.set_summary("c1", "s", "m1", 1)
        await store.delete_conversation("c1")
        assert await store.get_window("c1") is None
        assert await store.get_summary("c1") is None


class TestRedisFailure:
    """Redis 故障零影响：catch + 结构化日志 + 降级信号，不抛异常。"""

    @pytest.mark.asyncio
    async def test_redis_error_zero_impact(self, caplog):
        store = RedisMemoryStore(
            _BoomClient(), message_ttl=100, summary_ttl=100, window_size=20
        )
        assert await store.append_message("c1", _msg("m", "c")) is False
        assert await store.set_summary("c1", "s", "m", 1) is False
        assert await store.get_window("c1") is None
        assert await store.get_summary("c1") is None
        assert "redis_memory_failed" in caplog.text

    @pytest.mark.asyncio
    async def test_mirror_message_failure_zero_impact(self, caplog):
        store = RedisMemoryStore(
            _BoomClient(), message_ttl=100, summary_ttl=100, window_size=20
        )
        msg = Message(id="m1", conversation_id="c1", role="user", type="text", content="x")
        # 不抛异常即通过；window_exists 失败 → 走重建路径 → 重建失败，均只记日志
        await mirror_message(None, "c1", msg, store=store)
        assert "redis_memory_failed" in caplog.text


class TestConcurrent:
    """并发 append：pipeline 原子性，两条都不丢。"""

    @pytest.mark.asyncio
    async def test_concurrent_append_no_loss(self):
        store = make_store(window_size=20)
        await asyncio.gather(
            store.append_message("c1", _msg("m1", "a")),
            store.append_message("c1", _msg("m2", "b")),
        )
        window = await store.get_window("c1")
        assert window is not None
        assert {m.id for m in window} == {"m1", "m2"}


class TestMirrorMessage:
    """消息镜像：key 存在 → 追加；key 缺失 → 基于 PG 重建（自愈）。"""

    @pytest.mark.asyncio
    async def test_mirror_append_path(self):
        store = make_store()
        await store.append_message("c1", _msg("prev", "previous"))
        msg = Message(id="cur", conversation_id="c1", role="user", type="text", content="current")
        await mirror_message(None, "c1", msg, store=store)
        window = await store.get_window("c1")
        assert window is not None
        assert [m.id for m in window] == ["prev", "cur"]

    @pytest.mark.asyncio
    async def test_mirror_rebuild_path(self):
        store = make_store(window_size=20)  # 空窗口 → key 缺失 → 重建
        now = datetime.now(timezone.utc)
        rows = [  # DESC（newest first），调用方 reverse 为 ASC
            Message(id="cur", conversation_id="c1", role="user", type="text", content="current", created_at=now),
            Message(id="old", conversation_id="c1", role="assistant", type="text", content="old", created_at=now),
        ]
        db = _FakeDbForRecent(rows)
        msg = Message(id="cur", conversation_id="c1", role="user", type="text", content="current")
        await mirror_message(db, "c1", msg, store=store)
        window = await store.get_window("c1")
        assert window is not None
        assert [m.id for m in window] == ["old", "cur"]


class TestSingleton:
    """get_memory_store 懒加载单例：启用返回存储，禁用返回 None。"""

    def _reset(self, monkeypatch, enabled: bool):
        monkeypatch.setattr(rm.settings, "redis_memory_enabled", enabled)
        monkeypatch.setattr(rm, "_store", None)
        monkeypatch.setattr(rm, "_store_initialized", False)

    def test_get_memory_store_enabled(self, monkeypatch):
        self._reset(monkeypatch, enabled=True)
        store = rm.get_memory_store()
        assert store is not None
        assert store.window_size == rm.settings.redis_memory_window_size

    def test_get_memory_store_disabled(self, monkeypatch):
        self._reset(monkeypatch, enabled=False)
        assert rm.get_memory_store() is None
