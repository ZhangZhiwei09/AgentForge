"""RedisMemoryStore —— 会话短期记忆存储层。

在 PG（事实源）之上镜像「最近消息滑动窗口 + 摘要」，带 TTL。

设计原则:
    - Redis 永远不是事实源：消息/摘要仍先写 PG，再尽力镜像到 Redis
    - Redis failure 零影响：所有方法 catch + 结构化日志，返回降级信号（False/None），不抛异常
    - 自愈重建：消息 key 缺失（首写/TTL 过期/外部清理）时基于 PG 重建完整窗口再追加，
      杜绝「过期后 RPUSH 只生成 1 元素残窗」导致 Agent 突然失忆的脏数据
    - 版本字段：结构演进时递增 version，读取端版本缺失/不匹配 → 视作 miss → 回退 PG 并自愈重建

Redis key:
    agentforge:conv:{conversation_id}:messages   Redis List，滑动窗口（最近 N 条）
    agentforge:conv:{conversation_id}:summary    Redis String(JSON)，摘要

仅被 ContextBuilder / chat 写入路径 / SummaryCompressor 使用，Agent 执行层无感知。
"""

import json
import logging
import time
from collections.abc import Sequence
from datetime import datetime, timezone

import redis.asyncio
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.models.chat import Message

logger = logging.getLogger(__name__)

# ── 版本常量（结构演进位）─────────────────────────────────
CURRENT_MESSAGE_VERSION = 1
CURRENT_SUMMARY_VERSION = 1

# Redis key 前缀
KEY_PREFIX = "agentforge:conv"


# ── 类型模型（Redis 外部数据先校验再获得类型）─────────────


class StoredMessage(BaseModel):
    """消息窗口元素 —— 镜像 PG messages 的最近 N 条。

    version 是结构演进位：未来扩展 tool_call / function_call / agent /
    trace_id / token_usage 时递增；读取端版本不匹配 → miss → 自愈重建。
    """

    version: int
    id: str
    role: str
    type: str = "text"
    content: str
    model: str | None = None
    created_at: str  # ISO8601


class StoredSummary(BaseModel):
    """摘要 —— 镜像 PG conversation_memory。

    covered_until_message_id 与 PG 一一对应（幂等锚点），必须保留。
    """

    version: int
    summary: str
    covered_until_message_id: str | None = None
    token_count: int = 0
    updated_at: str  # ISO8601


# ── key 构造 ──────────────────────────────────────────────


def _messages_key(conversation_id: str) -> str:
    return f"{KEY_PREFIX}:{conversation_id}:messages"


def _summary_key(conversation_id: str) -> str:
    return f"{KEY_PREFIX}:{conversation_id}:summary"


# ── 结构化日志（所有 Redis 异常统一出口，线上可按 op + conversation_id 定位）──


def _log_failure(operation: str, conversation_id: str, exc: BaseException, duration_ms: float) -> None:
    logger.warning(
        "redis_memory_failed op=%s conversation_id=%s error=%s duration_ms=%.1f",
        operation, conversation_id, exc, duration_ms,
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_message(raw: str | bytes) -> StoredMessage | None:
    """解析单个窗口元素；JSON 损坏或版本不匹配 → None（触发整体 miss）。"""
    try:
        data = json.loads(raw)
        parsed = StoredMessage.model_validate(data)
        if parsed.version != CURRENT_MESSAGE_VERSION:
            return None
        return parsed
    except Exception:
        return None


def _parse_summary(raw: str | bytes) -> StoredSummary | None:
    """解析摘要；JSON 损坏或版本不匹配 → None。"""
    try:
        data = json.loads(raw)
        parsed = StoredSummary.model_validate(data)
        if parsed.version != CURRENT_SUMMARY_VERSION:
            return None
        return parsed
    except Exception:
        return None


# ── 存储实现 ──────────────────────────────────────────────


class RedisMemoryStore:
    """Redis 短期记忆存储。所有方法尽力而为：异常 catch + 结构化日志，返回降级信号。"""

    def __init__(
        self,
        client: redis.asyncio.Redis,
        *,
        message_ttl: int,
        summary_ttl: int,
        window_size: int,
    ) -> None:
        self._client = client
        self._message_ttl = message_ttl
        self._summary_ttl = summary_ttl
        self.window_size = window_size

    # ── 写：消息窗口 ──────────────────────────────────────

    async def window_exists(self, conversation_id: str) -> bool:
        """窗口 key 是否存在。失败时返回 False（调用方走自愈重建路径，本身亦失败则零影响）。"""
        start = time.perf_counter()
        try:
            return bool(await self._client.exists(_messages_key(conversation_id)))
        except Exception as exc:
            _log_failure("window_exists", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return False

    async def append_message(self, conversation_id: str, message: StoredMessage) -> bool:
        """追加单条消息到窗口尾部，滑动裁剪 + 刷新 TTL。"""
        start = time.perf_counter()
        key = _messages_key(conversation_id)
        try:
            async with self._client.pipeline() as pipe:
                pipe.rpush(key, message.model_dump_json())
                pipe.ltrim(key, -self.window_size, -1)
                pipe.expire(key, self._message_ttl)
                await pipe.execute()
            return True
        except Exception as exc:
            _log_failure("append_message", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return False

    async def rebuild_window(
        self, conversation_id: str, messages: Sequence[StoredMessage]
    ) -> bool:
        """基于 PG 重建完整窗口（自愈）。messages 为最近 N 条（含刚提交消息）。"""
        start = time.perf_counter()
        key = _messages_key(conversation_id)
        try:
            if not messages:
                return True  # 无消息可重建，跳过（保持 key 缺失状态，下次写入再处理）
            async with self._client.pipeline() as pipe:
                pipe.rpush(key, *[m.model_dump_json() for m in messages])
                pipe.ltrim(key, -self.window_size, -1)
                pipe.expire(key, self._message_ttl)
                await pipe.execute()
            return True
        except Exception as exc:
            _log_failure("rebuild_window", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return False

    # ── 写：摘要 ──────────────────────────────────────────

    async def set_summary(
        self,
        conversation_id: str,
        summary: str,
        covered_until_message_id: str | None,
        token_count: int,
    ) -> bool:
        """镜像摘要到 Redis（带 TTL）。"""
        start = time.perf_counter()
        key = _summary_key(conversation_id)
        payload = StoredSummary(
            version=CURRENT_SUMMARY_VERSION,
            summary=summary,
            covered_until_message_id=covered_until_message_id,
            token_count=token_count,
            updated_at=_now_iso(),
        ).model_dump_json()
        try:
            await self._client.set(key, payload, ex=self._summary_ttl)
            return True
        except Exception as exc:
            _log_failure("set_summary", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return False

    # ── 读 ────────────────────────────────────────────────

    async def get_window(self, conversation_id: str) -> list[StoredMessage] | None:
        """读取最近窗口。miss / 异常 / 版本不匹配 / 元素损坏 → None（调用方回退 PG）。"""
        start = time.perf_counter()
        key = _messages_key(conversation_id)
        try:
            raw_items = await self._client.lrange(key, 0, -1)
        except Exception as exc:
            _log_failure("get_window", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return None
        if not raw_items:
            # key 缺失/空 → 视作 miss → 回退 PG（PG 可能仍有历史，空窗口不能掩盖）
            return None
        window: list[StoredMessage] = []
        for idx, raw in enumerate(raw_items):
            parsed = _parse_message(raw)
            if parsed is None:
                logger.warning(
                    "redis_memory_failed op=get_window conversation_id=%s error=invalid_or_version_mismatch index=%d",
                    conversation_id, idx,
                )
                return None  # 损坏元素 → 整体 miss → 回退 PG，下次写自愈重建
            window.append(parsed)
        return window

    async def get_summary(self, conversation_id: str) -> StoredSummary | None:
        """读取摘要。miss / 异常 / 版本不匹配 → None（调用方回退 PG）。"""
        start = time.perf_counter()
        key = _summary_key(conversation_id)
        try:
            raw = await self._client.get(key)
        except Exception as exc:
            _log_failure("get_summary", conversation_id, exc, (time.perf_counter() - start) * 1000)
            return None
        if raw is None:
            return None
        parsed = _parse_summary(raw)
        if parsed is None:
            logger.warning(
                "redis_memory_failed op=get_summary conversation_id=%s error=invalid_or_version_mismatch",
                conversation_id,
            )
        return parsed

    # ── 维护 ──────────────────────────────────────────────

    async def delete_conversation(self, conversation_id: str) -> None:
        """清理会话在 Redis 的记忆（窗口 + 摘要）。"""
        start = time.perf_counter()
        try:
            await self._client.delete(
                _messages_key(conversation_id), _summary_key(conversation_id)
            )
        except Exception as exc:
            _log_failure("delete_conversation", conversation_id, exc, (time.perf_counter() - start) * 1000)


# ── 共享单例 ──────────────────────────────────────────────

_store: RedisMemoryStore | None = None
_store_initialized = False


def get_memory_store() -> RedisMemoryStore | None:
    """懒加载共享短期记忆存储。未启用时返回 None（调用方走纯 PG 路径）。

    懒连接：不触发真实连接，Redis 不可用时应用仍可正常启动。
    """
    global _store, _store_initialized
    if _store_initialized:
        return _store
    _store_initialized = True
    if not settings.redis_memory_enabled:
        return None
    client = redis.asyncio.Redis.from_url(
        settings.redis_url,
        socket_connect_timeout=0.5,
        socket_timeout=0.5,
    )
    _store = RedisMemoryStore(
        client,
        message_ttl=settings.redis_memory_message_ttl_seconds,
        summary_ttl=settings.redis_memory_summary_ttl_seconds,
        window_size=settings.redis_memory_window_size,
    )
    return _store


# ── 镜像编排（chat 写入路径调用）─────────────────────────


def _to_stored(msg: Message, *, created_at: str | None = None) -> StoredMessage:
    """把已提交的 Message 转为存储元素。

    created_at 缺省时用镜像时刻的 now()：列表顺序（RPUSH）才是排序依据，
    created_at 仅作元数据。刚 commit 的 ORM 对象该字段可能未加载（server_default），
    不可访问，故不依赖它。
    """
    return StoredMessage(
        version=CURRENT_MESSAGE_VERSION,
        id=msg.id,
        role=msg.role,
        type=msg.type or "text",
        content=msg.content,
        model=msg.model,
        created_at=created_at or _now_iso(),
    )


async def _load_recent_for_rebuild(db: AsyncSession, conversation_id: str, limit: int) -> list[Message]:
    """加载最近 N 条消息用于窗口重建（时间升序）。"""
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    rows = result.scalars().all()
    return list(reversed(rows))


async def mirror_message(
    db: AsyncSession,
    conversation_id: str,
    message: Message,
    *,
    store: RedisMemoryStore | None = None,
) -> None:
    """尽力镜像单条已提交消息到 Redis 窗口。Redis 失败零影响（仅结构化日志）。

    - key 存在 → 直接追加
    - key 缺失（首写/TTL 过期/外部清理）→ 先基于 PG 重建完整窗口（自愈）
    """
    store = store if store is not None else get_memory_store()
    if store is None:
        return
    start = time.perf_counter()
    try:
        if await store.window_exists(conversation_id):
            await store.append_message(conversation_id, _to_stored(message))
        else:
            recent = await _load_recent_for_rebuild(db, conversation_id, store.window_size)
            stored = [
                _to_stored(m, created_at=m.created_at.isoformat()) for m in recent
            ]
            await store.rebuild_window(conversation_id, stored)
    except Exception as exc:
        # 兜底：任何未预期异常（含 PG 重建查询失败）都不影响主流程
        _log_failure("mirror_message", conversation_id, exc, (time.perf_counter() - start) * 1000)
