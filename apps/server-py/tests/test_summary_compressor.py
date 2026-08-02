"""测试：SummaryCompressor 摘要镜像到 Redis。

- _upsert_memory 后摘要写入 Redis（含 covered_until_message_id，与 PG 一致）
- 镜像失败只记日志，PG 写入与压缩流程不受影响
"""

import fakeredis.aioredis
import pytest
import redis

from src.agent.redis_memory import RedisMemoryStore
from src.agent.summary_compressor import SummaryCompressor
from src.models.chat import ConversationMemory


def make_store() -> RedisMemoryStore:
    return RedisMemoryStore(
        fakeredis.aioredis.FakeRedis(),
        message_ttl=604800,
        summary_ttl=2592000,
        window_size=20,
    )


class _FakeResult:
    def __init__(self, rows):
        self._rows = [rows] if rows is not None else []

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _FakeDB:
    """假 DB：execute 返回内存记录；add/commit 仅记录。"""

    def __init__(self, memory=None):
        self._memory = memory
        self.commits = 0

    async def execute(self, stmt):  # noqa: ANN001
        return _FakeResult(self._memory)

    def add(self, obj):  # noqa: ANN001
        self._added = obj

    async def commit(self):
        self.commits += 1


class _BoomClient:
    """所有 Redis 命令都抛连接错误的假客户端。"""

    async def _raise(self, *args, **kwargs):  # noqa: ANN002
        raise redis.exceptions.ConnectionError("simulated redis down")

    setex = _raise

    def pipeline(self):
        raise redis.exceptions.ConnectionError("simulated redis down")


class TestSummaryMirror:
    @pytest.mark.asyncio
    async def test_upsert_mirrors_summary_to_redis(self):
        store = make_store()
        db = _FakeDB(memory=None)
        compressor = SummaryCompressor(db, memory_store=store)

        await compressor._upsert_memory("c1", "新摘要内容", "msg10")

        got = await store.get_summary("c1")
        assert got is not None
        assert got.summary == "新摘要内容"
        assert got.covered_until_message_id == "msg10"
        assert got.token_count == len("新摘要内容") // 2
        assert db.commits == 1

    @pytest.mark.asyncio
    async def test_upsert_update_preserves_covered_until(self):
        store = make_store()
        existing = ConversationMemory(
            id="mem1", conversation_id="c1", summary="旧摘要",
            covered_until_message_id="msg5", token_count=3, memory_type="summary",
        )
        db = _FakeDB(memory=existing)
        compressor = SummaryCompressor(db, memory_store=store)

        await compressor._upsert_memory("c1", "合并后摘要", "msg12")

        got = await store.get_summary("c1")
        assert got is not None
        assert got.summary == "合并后摘要"
        assert got.covered_until_message_id == "msg12"

    @pytest.mark.asyncio
    async def test_mirror_failure_does_not_break_upsert(self, caplog):
        store = RedisMemoryStore(
            _BoomClient(), message_ttl=100, summary_ttl=100, window_size=20
        )
        db = _FakeDB(memory=None)
        compressor = SummaryCompressor(db, memory_store=store)

        await compressor._upsert_memory("c1", "摘要", "msg1")  # 不抛异常

        assert db.commits == 1  # PG 写入正常完成
        assert "redis_memory_failed" in caplog.text
