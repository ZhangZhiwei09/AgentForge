"""集成测试：真实 Redis（可选，需运行中的 Redis）。

默认连 redis://localhost:6379（可用环境变量 REDIS_TEST_URL 覆盖）。
无真实 Redis 时整个模块自动 skip，不影响 CI / 无 Redis 的本地环境。

覆盖 fakeredis 无法验证的真实行为（设计文档 §9 集成场景 19–23 中不依赖真实 PG 的部分）：
    - 跨实例共享状态：两个 RedisMemoryStore 实例读写同一 key（fakeredis 每个 FakeRedis 互相隔离）
    - 真实 TTL：到期自动删除、append 刷新 TTL
    - 真实数据结构：messages 为 List、summary 为 String、EXISTS / TYPE / LLEN
    - pipeline MULTI 原子性（并发 append 不丢）
    - TTL 过期 → 自愈重建完整窗口（杜绝 1 元素残窗）
    - SummaryCompressor 首次压缩 → 摘要镜像到真实 Redis（covered_until 与 PG 锚点一致）
    - ContextBuilder 集成：verify=off 零 PG 访问；摘要命中 Redis 但窗口过期 → 混合降级
    - 真实连接错误（不可达端口）→ 零影响 + 结构化日志
"""

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
import redis
import redis.asyncio

from src.agent.context_builder import ContextBuilder
from src.agent.redis_memory import RedisMemoryStore, StoredMessage, mirror_message
from src.agent.summary_compressor import SummaryCompressor
from src.models.chat import Message

from tests.test_context_builder import _noop, _pg_msg_list
from tests.test_redis_memory import _FakeDbForRecent, _ScalarsResult

REDIS_TEST_URL = os.getenv("REDIS_TEST_URL", "redis://localhost:6379")


def _real_redis_available() -> bool:
    try:
        probe = redis.Redis.from_url(REDIS_TEST_URL, socket_connect_timeout=1, socket_timeout=1)
        probe.ping()
        probe.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _real_redis_available(),
    reason=f"真实 Redis 不可达 {REDIS_TEST_URL}（启动 infra redis 或设置 REDIS_TEST_URL）",
)


def _cid() -> str:
    return f"it-{uuid.uuid4().hex[:12]}"


def _msg(id_: str, content: str, *, role: str = "user", ts: str = "2026-08-02T10:00:00+00:00") -> StoredMessage:
    return StoredMessage(version=1, id=id_, role=role, type="text", content=content, created_at=ts)


def _messages_key(cid: str) -> str:
    return f"agentforge:conv:{cid}:messages"


def _summary_key(cid: str) -> str:
    return f"agentforge:conv:{cid}:summary"


@pytest_asyncio.fixture
async def store_factory():
    """产出真实 Redis 的 RedisMemoryStore；测试结束后清理 it-* key 并关闭连接。"""

    clients: list[redis.asyncio.Redis] = []

    async def _factory(window_size: int = 20, *, message_ttl: int = 3600, summary_ttl: int = 3600):
        client = redis.asyncio.from_url(REDIS_TEST_URL, socket_connect_timeout=1, socket_timeout=1)
        clients.append(client)
        return RedisMemoryStore(
            client, message_ttl=message_ttl, summary_ttl=summary_ttl, window_size=window_size
        )

    yield _factory

    try:
        if clients:
            keys = await clients[0].keys("agentforge:conv:it-*")
            if keys:
                await clients[0].delete(*keys)
    except Exception:
        pass
    for client in clients:
        try:
            await client.aclose()
        except Exception:
            pass


class TestSharedState:
    """跨实例共享状态 —— fakeredis 无法覆盖（每个 FakeRedis 实例内存隔离）。"""

    async def test_window_shared_across_instances(self, store_factory):
        cid = _cid()
        s1 = await store_factory()
        await s1.append_message(cid, _msg("m1", "hello"))

        s2 = await store_factory()  # 全新客户端 + 全新 store 实例
        win = await s2.get_window(cid)
        assert win is not None
        assert [m.id for m in win] == ["m1"]
        assert await s2._client.exists(_messages_key(cid)) == 1  # 共享服务端状态

    async def test_summary_shared_across_instances(self, store_factory):
        cid = _cid()
        s1 = await store_factory()
        await s1.set_summary(cid, "摘要", "m1", 5)

        s2 = await store_factory()
        got = await s2.get_summary(cid)
        assert got is not None
        assert got.summary == "摘要"
        assert got.covered_until_message_id == "m1"


class TestRealTTL:
    """真实 TTL：到期自动删除、append 刷新。"""

    async def test_ttl_expires_key_on_server(self, store_factory):
        cid = _cid()
        s = await store_factory(message_ttl=1, summary_ttl=1)
        await s.append_message(cid, _msg("m1", "a"))
        await s.set_summary(cid, "s", "m1", 1)

        await asyncio.sleep(1.5)  # 等服务端真实过期
        assert await s.get_window(cid) is None
        assert await s.get_summary(cid) is None
        assert await s._client.exists(_messages_key(cid)) == 0
        assert await s._client.exists(_summary_key(cid)) == 0

    async def test_append_refreshes_ttl(self, store_factory):
        cid = _cid()
        s = await store_factory(message_ttl=30)
        await s.append_message(cid, _msg("m1", "a"))
        await asyncio.sleep(1.5)

        before = await s._client.ttl(_messages_key(cid))
        assert 0 < before < 30  # 已从 30 递减

        await s.append_message(cid, _msg("m2", "b"))
        after = await s._client.ttl(_messages_key(cid))
        assert after > before  # 刷新回到接近 30
        assert after > 25

    async def test_summary_ttl_set(self, store_factory):
        cid = _cid()
        s = await store_factory(summary_ttl=60)
        await s.set_summary(cid, "s", "m1", 1)
        ttl = await s._client.ttl(_summary_key(cid))
        assert 0 < ttl <= 60


class TestRealDataStructure:
    """真实数据结构：messages=List、summary=String、滑动窗口真实裁剪。"""

    async def test_message_key_is_list(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s.append_message(cid, _msg("m1", "a"))
        t = await s._client.type(_messages_key(cid))
        assert t in (b"list", "list")

    async def test_summary_key_is_string(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s.set_summary(cid, "s", "m1", 1)
        t = await s._client.type(_summary_key(cid))
        assert t in (b"string", "string")

    async def test_sliding_window_real_ltrim(self, store_factory):
        cid = _cid()
        s = await store_factory(window_size=3)
        for i in range(6):
            await s.append_message(cid, _msg(f"m{i}", str(i)))
        win = await s.get_window(cid)
        assert win is not None
        assert [m.id for m in win] == ["m3", "m4", "m5"]
        assert await s._client.llen(_messages_key(cid)) == 3  # 服务端真实裁剪


class TestConcurrency:
    """并发 append 不丢（真实 pipeline MULTI 原子性）。"""

    async def test_concurrent_append_no_loss(self, store_factory):
        cid = _cid()
        s = await store_factory(window_size=50)
        await asyncio.gather(
            s.append_message(cid, _msg("m1", "a")),
            s.append_message(cid, _msg("m2", "b")),
            s.append_message(cid, _msg("m3", "c")),
        )
        win = await s.get_window(cid)
        assert win is not None
        assert {m.id for m in win} == {"m1", "m2", "m3"}


class TestRebuild:
    """TTL 过期后自愈重建完整窗口（杜绝 1 元素残窗）。"""

    async def test_ttl_expiry_self_heal_rebuild(self, store_factory):
        cid = _cid()
        s = await store_factory(window_size=20, message_ttl=1, summary_ttl=3600)
        await s.append_message(cid, _msg("m1", "旧消息"))
        await asyncio.sleep(1.5)  # 窗口 key 真实过期
        assert await s.get_window(cid) is None

        now = datetime.now(timezone.utc)
        rows = [  # DESC（newest first），_load_recent_for_rebuild 会 reverse 为 ASC
            Message(id="m2", conversation_id=cid, role="user", type="text", content="当前", created_at=now),
            Message(id="m1", conversation_id=cid, role="assistant", type="text", content="旧消息", created_at=now),
        ]
        db = _FakeDbForRecent(rows)
        await mirror_message(
            db, cid,
            Message(id="m2", conversation_id=cid, role="user", type="text", content="当前"),
            store=s,
        )
        win = await s.get_window(cid)
        assert win is not None
        assert [m.id for m in win] == ["m1", "m2"]  # 完整重建，而非只有新消息的残窗


class TestCorruptAndVersion:
    """损坏 JSON / 版本不匹配 → 整体 miss（在真实 Redis 上直写脏数据）。"""

    async def test_version_mismatch_miss(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s._client.rpush(
            _messages_key(cid),
            json.dumps({"version": 999, "id": "x", "role": "user", "content": "y", "created_at": "t"}),
        )
        assert await s.get_window(cid) is None

    async def test_corrupt_element_miss(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s._client.rpush(_messages_key(cid), "{not valid json")
        assert await s.get_window(cid) is None


class TestCompressorIntegration:
    """SummaryCompressor 首次压缩 → 摘要镜像到真实 Redis（§19 场景）。"""

    class _MsgOnlyDB:
        """execute 返回旧消息列表；add/commit 记录。count/memory/llm 由 monkeypatch 接管。"""

        def __init__(self, messages):
            self._messages = messages
            self.commits = 0

        async def execute(self, stmt):  # noqa: ANN001
            return _ScalarsResult(self._messages)

        def add(self, obj):  # noqa: ANN001
            self._added = obj

        async def commit(self):
            self.commits += 1

    async def test_initial_compress_mirrors_summary_to_real_redis(self, store_factory, monkeypatch):
        cid = _cid()
        s = await store_factory()
        old_msgs = [
            Message(id=f"m{i}", conversation_id=cid, role="user", type="text", content=f"消息{i}")
            for i in range(15)  # 15 = 25 总消息 - RAW_WINDOW(10)
        ]
        db = self._MsgOnlyDB(old_msgs)
        compressor = SummaryCompressor(db, memory_store=s)

        async def fake_count(_):  # noqa: ANN001
            return 25  # 超过 COMPRESSION_THRESHOLD(20) → 触发压缩

        async def fake_memory(_):  # noqa: ANN001
            return None  # 首次压缩

        async def fake_llm(prompt):  # noqa: ANN001
            return "压缩后的摘要内容"

        monkeypatch.setattr(compressor, "_count_messages", fake_count)
        monkeypatch.setattr(compressor, "_get_memory", fake_memory)
        monkeypatch.setattr(compressor, "_call_llm", fake_llm)

        await compressor.compress(cid)

        got = await s.get_summary(cid)
        assert got is not None
        assert got.summary == "压缩后的摘要内容"
        assert got.covered_until_message_id == "m14"  # 被压缩旧消息的最后一条，与 PG 锚点一致
        assert got.token_count == len("压缩后的摘要内容") // 2
        assert db.commits == 1  # PG 写入正常完成

        s2 = await store_factory()
        assert (await s2.get_summary(cid)).covered_until_message_id == "m14"  # 跨实例可见


class TestContextBuilderIntegration:
    """ContextBuilder + 真实 Redis：verify=off 零 PG；摘要存活但窗口过期 → 混合降级（§20、§23）。"""

    async def test_redis_only_no_pg(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s.append_message(cid, _msg("m1", "你好", role="user"))
        await s.append_message(cid, _msg("m2", "你好，有什么可以帮你？", role="assistant"))
        await s.set_summary(cid, "用户咨询核身问题", "m1", 5)

        builder = ContextBuilder(db=None, memory_store=s, verify_latest_id=False)
        result = await builder.build(cid, "还有问题吗")

        assert result.has_summary
        assert result.history_count == 2
        roles = [m.type for m in result.messages]
        assert roles == ["system", "human", "ai", "human"]
        assert result.messages[-1].content == "还有问题吗"

    async def test_verify_on_fresh_window_uses_redis(self, store_factory):
        cid = _cid()
        s = await store_factory()
        await s.append_message(cid, _msg("m1", "redis 消息"))
        builder = ContextBuilder(db=None, memory_store=s, verify_latest_id=True)
        builder._load_memory = _noop

        async def latest(_):  # noqa: ANN001
            return "m1"

        builder._latest_message_id = latest
        result = await builder.build(cid, "hi")
        assert result.messages[1].content == "redis 消息"
        assert result.history_count == 1

    async def test_summary_hits_redis_window_falls_back_pg(self, store_factory):
        cid = _cid()
        s = await store_factory(message_ttl=1, summary_ttl=3600)
        await s.append_message(cid, _msg("m1", "redis 消息"))
        await s.set_summary(cid, "摘要仍有效", "m1", 4)
        await asyncio.sleep(1.5)  # 消息窗口过期，摘要仍存活（§23）

        builder = ContextBuilder(db=None, memory_store=s, verify_latest_id=False)
        builder._load_recent_messages = _pg_msg_list
        builder._load_memory = _noop
        result = await builder.build(cid, "hi")

        # 摘要命中 Redis
        assert any("摘要仍有效" in m.content for m in result.messages if getattr(m, "type", "") == "system")
        # 窗口 miss → 回退 PG 最近消息
        assert result.messages[1].content == "来自 PG"


class TestRealConnectionError:
    """真实连接错误（不可达端口）→ 零影响 + 结构化日志，不抛异常。"""

    async def test_unreachable_redis_zero_impact(self, caplog):
        bad = redis.asyncio.from_url("redis://localhost:1", socket_connect_timeout=0.5, socket_timeout=0.5)
        try:
            store = RedisMemoryStore(bad, message_ttl=3600, summary_ttl=3600, window_size=20)
            assert await store.append_message("c1", _msg("m", "c")) is False
            assert await store.get_window("c1") is None
            assert await store.get_summary("c1") is None
            assert "redis_memory_failed" in caplog.text
        finally:
            await bad.aclose()
