"""L2 语义分类器测试。

TS 无独立 L2 单测，此文件覆盖：
- _weighted_vote 纯函数分支（空/单路由/多路由/歧义惩罚/低相似过滤）
- classify 在 embedding provider 缺失时降级返回 None
- _search_similar 用 fake session_factory 喂行
"""

import asyncio

import pytest

from src.agent.router.l2_semantic import (
    AMBIGUITY_PENALTY,
    SemanticClassifier,
    SemanticMatch,
)
from src.agent.types import RouteName


def _match(
    route: str, similarity: float, sample_id: str = "s1", text: str = "样本"
) -> SemanticMatch:
    return SemanticMatch(
        sample_id=sample_id,
        route=RouteName(route),
        text=text,
        similarity=similarity,
    )


# ── Fake 基础设施 ───────────────────────────────────────────


class FakeRow:
    def __init__(self, id, route, text, similarity):
        self.id = id
        self.route = route
        self.text = text
        self.similarity = similarity


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class FakeSession:
    def __init__(self, rows):
        self._rows = rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def execute(self, sql, params=None):
        return FakeResult(self._rows)

    async def commit(self):
        pass


class FakeFactory:
    def __init__(self, rows):
        self._rows = rows

    def __call__(self):
        return FakeSession(self._rows)


class FakeProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3] for _ in texts]


# ═══════════════════════════════════════════════════════════
# _weighted_vote 纯函数
# ═══════════════════════════════════════════════════════════


class TestWeightedVote:
    def test_empty_matches_returns_task_zero(self):
        route, conf = SemanticClassifier()._weighted_vote([])
        assert route == RouteName.TASK
        assert conf == 0.0

    def test_all_below_min_similarity(self):
        matches = [_match("TASK", 0.3), _match("CHAT", 0.2)]
        route, conf = SemanticClassifier()._weighted_vote(matches)
        assert route == RouteName.TASK
        assert conf == 0.0

    def test_single_route_normalizes_to_one(self):
        matches = [_match("TASK", 0.8), _match("TASK", 0.6)]
        route, conf = SemanticClassifier()._weighted_vote(matches)
        assert route == RouteName.TASK
        assert conf == pytest.approx(1.0)

    def test_clear_winner_no_penalty(self):
        # gap = (0.9-0.55)/1.45 ≈ 0.241 >= 0.15 → 无惩罚
        matches = [_match("DIAGNOSIS", 0.9), _match("TASK", 0.55)]
        route, conf = SemanticClassifier()._weighted_vote(matches)
        assert route == RouteName.DIAGNOSIS
        assert conf == pytest.approx(0.9 / 1.45)

    def test_ambiguous_penalty_applied(self):
        # gap = (0.8-0.7)/1.5 ≈ 0.0667 < 0.15 → ×0.8
        matches = [_match("DIAGNOSIS", 0.8), _match("TASK", 0.7)]
        route, conf = SemanticClassifier()._weighted_vote(matches)
        assert route == RouteName.DIAGNOSIS
        expected = (0.8 / 1.5) * AMBIGUITY_PENALTY
        assert conf == pytest.approx(expected)

    def test_three_routes_winner_second(self):
        matches = [
            _match("TASK", 0.9, sample_id="a"),
            _match("CHAT", 0.4, sample_id="b"),
            _match("HUMAN", 0.2, sample_id="c"),
        ]
        route, _conf = SemanticClassifier()._weighted_vote(matches)
        assert route == RouteName.TASK


# ═══════════════════════════════════════════════════════════
# classify 降级路径
# ═══════════════════════════════════════════════════════════


class TestClassifyDegrade:
    @pytest.mark.asyncio
    async def test_no_embedding_provider_returns_none(self, monkeypatch):
        classifier = SemanticClassifier(session_factory=FakeFactory([]))
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: None
        )
        result = await classifier.classify("hello")
        assert result is None

    @pytest.mark.asyncio
    async def test_no_matches_returns_none(self, monkeypatch):
        classifier = SemanticClassifier(session_factory=FakeFactory([]))
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: FakeProvider()
        )
        result = await classifier.classify("hello")
        assert result is None

    @pytest.mark.asyncio
    async def test_sql_exception_returns_none(self, monkeypatch):
        class BoomSession(FakeSession):
            async def execute(self, sql, params=None):
                raise RuntimeError("db down")

        class BoomFactory:
            def __call__(self):
                return BoomSession([])

        classifier = SemanticClassifier(session_factory=BoomFactory())
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: FakeProvider()
        )
        result = await classifier.classify("hello")
        assert result is None


# ═══════════════════════════════════════════════════════════
# classify 正常路径（fake provider + fake session 喂行）
# ═══════════════════════════════════════════════════════════


class TestClassifyHappyPath:
    @pytest.mark.asyncio
    async def test_returns_semantic_result(self, monkeypatch):
        rows = [
            FakeRow("is-a", "DIAGNOSIS", "刷脸失败", 0.9),
            FakeRow("is-b", "TASK", "怎么接入", 0.55),
        ]
        classifier = SemanticClassifier(session_factory=FakeFactory(rows))
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: FakeProvider()
        )

        result = await classifier.classify("人脸识别一直失败")
        assert result is not None
        assert result.route == RouteName.DIAGNOSIS
        assert result.confidence == pytest.approx(0.9 / 1.45)
        assert "L2语义匹配" in result.reasoning
        assert len(result.matches) == 2
        # matches 路由已校验为 RouteName 枚举
        assert all(isinstance(m.route, RouteName) for m in result.matches)

        # 让 _record_usage 后台任务跑完，避免 pending task 告警
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_invalid_route_row_skipped(self, monkeypatch):
        rows = [
            FakeRow("is-bad", "NOT_A_ROUTE", "非法路由", 0.9),
            FakeRow("is-good", "TASK", "怎么接入", 0.6),
        ]
        classifier = SemanticClassifier(session_factory=FakeFactory(rows))
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: FakeProvider()
        )

        result = await classifier.classify("hello")
        assert result is not None
        assert result.route == RouteName.TASK
        assert len(result.matches) == 1
        assert result.matches[0].sample_id == "is-good"

        await asyncio.sleep(0)


# ═══════════════════════════════════════════════════════════
# is_available
# ═══════════════════════════════════════════════════════════


class TestIsAvailable:
    @pytest.mark.asyncio
    async def test_no_provider_false(self, monkeypatch):
        classifier = SemanticClassifier(session_factory=FakeFactory([]))
        monkeypatch.setattr(
            "src.rag.embeddings.get_embedding_provider", lambda: None
        )
        assert await classifier.is_available() is False
