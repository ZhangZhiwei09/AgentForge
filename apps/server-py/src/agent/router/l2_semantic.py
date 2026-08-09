"""L2 语义意图分类器 —— Embedding + pgvector k-NN。

对应 TS: apps/server/src/services/agent-runtime/routing/l2-semantic.ts

流程：
    1. 调用 Embedding Provider 将用户消息向量化
    2. 在 pgvector intent_samples 表中检索 Top-K 最相似样本
    3. k-NN 加权投票：按 route 分组累加 cosine similarity
    4. 返回最高置信度的 route 及匹配详情

降级策略：Embedding Provider 不可用 / pgvector 查询失败 / 匹配度过低 → 返回 None，
上游 Router 无缝降级到 L3/L4/L5。
"""

import asyncio
import logging
import math
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.types import RouteName
from src.config import settings

logger = logging.getLogger(__name__)

# 常量（默认值与 config 一致；实例构造可覆盖便于测试）
DEFAULT_TOP_K = 5
MIN_SIMILARITY_FOR_VOTE = 0.5
AMBIGUITY_GAP = 0.15
AMBIGUITY_PENALTY = 0.8


@dataclass(slots=True)
class SemanticMatch:
    """单个命中样本（外部数据校验后的结果）。"""

    sample_id: str
    route: RouteName
    text: str
    similarity: float


@dataclass(slots=True)
class SemanticResult:
    """L2 分类结果。"""

    route: RouteName
    confidence: float
    reasoning: str
    matches: list[SemanticMatch] = field(default_factory=list)


class SemanticClassifier:
    """L2 语义分类器。

    用法:
        classifier = SemanticClassifier()  # 默认 session_factory = async_session
        result = await classifier.classify(message)  # SemanticResult | None
    """

    def __init__(
        self,
        session_factory=None,
        top_k: int | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._top_k = top_k or settings.router_semantic_top_k
        self._provider = None  # 惰性解析 Embedding Provider

    # ── 属性 ──────────────────────────────────────────

    @property
    def embedding_provider(self):
        """惰性获取 Embedding Provider（可被测试 monkeypatch）。"""
        if self._provider is None:
            from src.rag.embeddings import get_embedding_provider

            self._provider = get_embedding_provider()
        return self._provider

    def _session(self) -> AsyncSession:
        """获取数据库会话。默认使用全局 async_session。"""
        if self._session_factory is None:
            from src.db import async_session

            self._session_factory = async_session
        return self._session_factory()

    # ── 主流程 ────────────────────────────────────────

    async def classify(self, message: str) -> SemanticResult | None:
        """对用户消息进行语义分类。

        Returns:
            SemanticResult，或 None（需要降级到 LLM Router）
        """
        provider = self.embedding_provider
        if provider is None:
            logger.info("L2: no embedding provider available, skipping")
            return None

        try:
            # 1. 向量化查询
            embeddings = await provider.embed([message])
            if not embeddings:
                return None
            query_vec = embeddings[0]

            # 2. pgvector k-NN 检索
            rows = await self._search_similar(query_vec, self._top_k)
            if not rows:
                logger.info("L2: no intent samples matched")
                return None

            # 3. k-NN 加权投票
            route, confidence = self._weighted_vote(rows)

            # 非阻塞更新样本使用计数（失败零影响）
            asyncio.create_task(self._record_usage([r.sample_id for r in rows]))

            return SemanticResult(
                route=route,
                confidence=confidence,
                reasoning=(
                    f"L2语义匹配: k-NN投票 (topK={len(rows)}, "
                    f"maxSimilarity={int(rows[0].similarity * 100)}%)"
                ),
                matches=rows[:5],
            )
        except Exception as exc:
            logger.warning(
                "L2 classify failed, falling back to LLM router: %s", exc
            )
            return None

    # ── pgvector 检索 ─────────────────────────────────

    async def _search_similar(
        self, query_embedding: list[float], k: int
    ) -> list[SemanticMatch]:
        """在 intent_samples 中检索与查询向量最相似的 Top-K 样本。"""
        # asyncpg 要求 vector 传字符串字面量；查询向量是 float 列表，
        # 转成 '[0.1,...]' 内联进 SQL（无注入风险，对齐 TS ${vecStr}::vector 做法）。
        vec_str = "[" + ",".join(repr(x) for x in query_embedding) + "]"
        sql = text(
            f"""
            SELECT id, route, text,
                   1 - (embedding <=> '{vec_str}'::vector) AS similarity
            FROM intent_samples
            WHERE active = TRUE AND embedding IS NOT NULL
            ORDER BY embedding <=> '{vec_str}'::vector
            LIMIT :top_k
            """
        )

        matches: list[SemanticMatch] = []
        async with self._session() as session:
            result = await session.execute(sql, {"top_k": k})
            for row in result.fetchall():
                # 外部数据先校验再获得类型
                similarity = float(row.similarity)
                if math.isnan(similarity):
                    continue
                try:
                    route = RouteName(row.route)
                except ValueError:
                    logger.warning(
                        "L2: invalid route in intent_samples: %s", row.route
                    )
                    continue
                matches.append(
                    SemanticMatch(
                        sample_id=str(row.id),
                        route=route,
                        text=str(row.text),
                        similarity=similarity,
                    )
                )
        return matches

    # ── 加权投票 ──────────────────────────────────────

    def _weighted_vote(self, matches: list[SemanticMatch]) -> tuple[RouteName, float]:
        """k-NN 加权投票：按 route 分组累加 similarity。

        - 只计入 similarity >= MIN_SIMILARITY_FOR_VOTE 的样本
        - confidence = 最佳组得分 / 总分（归一化）
        - 歧义惩罚：top-1 与 top-2 差距 < AMBIGUITY_GAP → confidence *= 0.8
        """
        scores: dict[RouteName, float] = {}
        total_score = 0.0

        for m in matches:
            if m.similarity < MIN_SIMILARITY_FOR_VOTE:
                continue
            scores[m.route] = scores.get(m.route, 0.0) + m.similarity
            total_score += m.similarity

        if not scores:
            return RouteName.TASK, 0.0

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        best_route, best_score = ranked[0]
        second_score = ranked[1][1] if len(ranked) > 1 else 0.0

        confidence = best_score / total_score if total_score > 0 else 0.0

        # 歧义惩罚：top-1 / top-2 差距过小 → 降低置信度
        if len(ranked) > 1 and second_score > 0:
            gap = (best_score - second_score) / total_score
            if gap < AMBIGUITY_GAP:
                confidence *= AMBIGUITY_PENALTY

        return best_route, min(confidence, 1.0)

    # ── 使用计数（非关键路径）──────────────────────────

    async def _record_usage(self, sample_ids: list[str]) -> None:
        """更新命中样本的 usage_count / last_used_at。失败仅结构化日志。"""
        if not sample_ids:
            return
        try:
            async with self._session() as session:
                await session.execute(
                    text(
                        "UPDATE intent_samples "
                        "SET usage_count = usage_count + 1, last_used_at = NOW() "
                        "WHERE id = ANY(CAST(:ids AS text[]))"
                    ),
                    {"ids": sample_ids},
                )
                await session.commit()
        except Exception as exc:
            logger.warning("L2 record_usage failed: %s", exc)

    # ── 可用性检查 ────────────────────────────────────

    async def is_available(self) -> bool:
        """L2 是否可用：Embedding Provider 已配置 且 intent_samples 有数据。"""
        try:
            if self.embedding_provider is None:
                return False
            async with self._session() as session:
                result = await session.execute(
                    text("SELECT COUNT(*) FROM intent_samples WHERE active = TRUE")
                )
                return result.scalar_one() > 0
        except Exception:
            return False
