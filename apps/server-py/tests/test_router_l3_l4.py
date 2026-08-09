"""L3/L4 LLM 路由测试 —— 移植 TS routing/__tests__/l3-llm-router.test.ts。

覆盖：
- parse_router_decision（markdown 围栏 / 多对象 / 非法字段）
- build_few_shot_prompt（top-3 / >0.4 过滤 / DIAGNOSIS 注意）
- few_shot_classify / llm_classify（fake provider 驱动 + DIAGNOSIS 高门槛）
"""

import pytest

from src.agent.router.l2_semantic import SemanticMatch
from src.agent.router.l3_fewshot_llm import (
    ROUTE_LABELS,
    ROUTER_SYSTEM_PROMPT,
    build_few_shot_prompt,
    few_shot_classify,
    parse_router_decision,
)
from src.agent.router.l4_raw_llm import llm_classify
from src.agent.types import RouteName
from src.schemas.chat import ChatMessage, ChatSyncResult


def _m(route: str, similarity: float, text: str, sample_id: str = "s") -> SemanticMatch:
    return SemanticMatch(
        sample_id=sample_id,
        route=RouteName(route),
        text=text,
        similarity=similarity,
    )


class FakeProvider:
    def __init__(self, content: str):
        self._content = content
        self.last_messages: list = []
        self.last_system_prompt: str = ""

    async def chat_sync(
        self, messages, model, system_prompt, temperature, max_tokens, json_mode,
        tools=None,
    ) -> ChatSyncResult:
        self.last_messages = list(messages)
        self.last_system_prompt = system_prompt
        return ChatSyncResult(content=self._content, usage={})


def _patch_provider(monkeypatch, content: str):
    fake = FakeProvider(content)
    monkeypatch.setattr(
        "src.providers.registry.get_provider", lambda name: fake
    )
    monkeypatch.setattr(
        "src.providers.registry.resolve_model",
        lambda mid: {"provider_name": "openai", "model_id": "gpt-4o-mini"},
    )
    return fake


# ═══════════════════════════════════════════════════════════
# Prompt 常量
# ═══════════════════════════════════════════════════════════


class TestPromptConstants:
    def test_router_system_prompt_contains_five_routes(self):
        for route in ["SAFETY", "CHAT", "HUMAN", "TASK", "DIAGNOSIS"]:
            assert f'route: "{route}"' in ROUTER_SYSTEM_PROMPT

    def test_route_labels_chinese_and_five(self):
        assert set(ROUTE_LABELS.keys()) == {
            "SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS",
        }
        # 全中文
        for label in ROUTE_LABELS.values():
            assert any("一" <= ch <= "鿿" for ch in label)


# ═══════════════════════════════════════════════════════════
# parse_router_decision
# ═══════════════════════════════════════════════════════════


class TestParseRouterDecision:
    def test_valid_json(self):
        result = parse_router_decision(
            '{"route":"TASK","confidence":0.9,"reasoning":"用户询问订单状态"}'
        )
        assert result is not None
        assert result.route == RouteName.TASK
        assert result.confidence == 0.9
        assert result.reasoning == "用户询问订单状态"

    def test_markdown_fence(self):
        raw = '```json\n{"route":"CHAT","confidence":0.8,"reasoning":"寒暄"}\n```'
        result = parse_router_decision(raw)
        assert result is not None
        assert result.route == RouteName.CHAT

    def test_greedy_multi_object_returns_none(self):
        raw = (
            '{"route":"TASK","confidence":0.9,"reasoning":"a"} trailing '
            '{"route":"SAFETY","confidence":1.0,"reasoning":"b"}'
        )
        assert parse_router_decision(raw) is None

    @pytest.mark.parametrize(
        "raw",
        [
            '{"route":"UNKNOWN","confidence":0.9,"reasoning":"x"}',   # 非法 route
            '{"route":"TASK","confidence":1.5,"reasoning":"x"}',      # confidence 超上限
            '{"route":"TASK","confidence":"high","reasoning":"x"}',   # confidence 类型错
            '{"route":"TASK","confidence":0.9}',                      # 缺 reasoning
            "hello",                                                  # 非 JSON
            "",                                                       # 空
        ],
    )
    def test_invalid_returns_none(self, raw: str):
        assert parse_router_decision(raw) is None

    def test_reasoning_too_long_returns_none(self):
        raw = '{"route":"TASK","confidence":0.9,"reasoning":"%s"}' % ("a" * 201)
        assert parse_router_decision(raw) is None


# ═══════════════════════════════════════════════════════════
# build_few_shot_prompt
# ═══════════════════════════════════════════════════════════


class TestBuildFewShotPrompt:
    def test_no_matches_returns_bare_prompt(self):
        assert build_few_shot_prompt([]) == ROUTER_SYSTEM_PROMPT

    def test_filters_below_0_4(self):
        matches = [
            _m("TASK", 0.3, "低相似度样本"),
            _m("TASK", 0.5, "中相似度样本"),
            _m("DIAGNOSIS", 0.9, "高相似度样本"),
        ]
        prompt = build_few_shot_prompt(matches)
        assert "低相似度样本" not in prompt
        assert "中相似度样本" in prompt
        assert "高相似度样本" in prompt

    def test_caps_at_three(self):
        matches = [
            _m("TASK", 0.9, f"样本{i}", sample_id=f"s{i}") for i in range(6)
        ]
        prompt = build_few_shot_prompt(matches)
        for i in range(3):
            assert f"样本{i}" in prompt
        assert "样本5" not in prompt

    def test_contains_diagnosis_caution(self):
        prompt = build_few_shot_prompt([_m("TASK", 0.8, "怎么接入")])
        assert "DIAGNOSIS 路由要求用户提供了具体的故障信息" in prompt

    def test_contains_label_and_route(self):
        prompt = build_few_shot_prompt([_m("TASK", 0.8, "怎么接入")])
        assert '用户："怎么接入"' in prompt
        assert "任务执行" in prompt  # ROUTE_LABELS 中文
        assert 'route: "TASK"' in prompt


# ═══════════════════════════════════════════════════════════
# few_shot_classify
# ═══════════════════════════════════════════════════════════


class TestFewShotClassify:
    @pytest.mark.asyncio
    async def test_valid_returns_with_prefix(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"TASK","confidence":0.9,"reasoning":"业务问题"}',
        )
        result = await few_shot_classify("怎么接入", [], [], None)
        assert result is not None
        assert result.route == RouteName.TASK
        assert result.reasoning.startswith("L3少样本增强: ")

    @pytest.mark.asyncio
    async def test_diagnosis_high_threshold_low_conf_falls_through(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"DIAGNOSIS","confidence":0.6,"reasoning":"疑似故障"}',
        )
        result = await few_shot_classify("人脸识别失败", [], [], None)
        assert result is None

    @pytest.mark.asyncio
    async def test_diagnosis_high_threshold_passes(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"DIAGNOSIS","confidence":0.8,"reasoning":"明确故障现象"}',
        )
        result = await few_shot_classify("报错 FACE_TIMEOUT", [], [], None)
        assert result is not None
        assert result.route == RouteName.DIAGNOSIS

    @pytest.mark.asyncio
    async def test_low_confidence_falls_through(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"TASK","confidence":0.4,"reasoning":"低置信"}',
        )
        result = await few_shot_classify("test", [], [], None)
        assert result is None

    @pytest.mark.asyncio
    async def test_provider_error_falls_through(self, monkeypatch):
        class BoomProvider:
            async def chat_sync(self, *args, **kwargs):
                raise RuntimeError("provider down")

        monkeypatch.setattr(
            "src.providers.registry.get_provider", lambda name: BoomProvider()
        )
        monkeypatch.setattr(
            "src.providers.registry.resolve_model",
            lambda mid: {"provider_name": "openai", "model_id": "gpt-4o-mini"},
        )
        result = await few_shot_classify("test", [], [], None)
        assert result is None


# ═══════════════════════════════════════════════════════════
# llm_classify
# ═══════════════════════════════════════════════════════════


class TestLLMClassify:
    @pytest.mark.asyncio
    async def test_valid_returns(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"HUMAN","confidence":0.95,"reasoning":"用户要求转人工"}',
        )
        result = await llm_classify("我要投诉", [], None)
        assert result is not None
        assert result.route == RouteName.HUMAN

    @pytest.mark.asyncio
    async def test_diagnosis_low_conf_falls_back(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"DIAGNOSIS","confidence":0.6,"reasoning":"模糊故障"}',
        )
        result = await llm_classify("test", [], None)
        assert result is None

    @pytest.mark.asyncio
    async def test_low_conf_falls_back(self, monkeypatch):
        _patch_provider(
            monkeypatch,
            '{"route":"TASK","confidence":0.3,"reasoning":"低"}',
        )
        result = await llm_classify("test", [], None)
        assert result is None

    @pytest.mark.asyncio
    async def test_history_sliced_to_last_four(self, monkeypatch):
        fake = _patch_provider(
            monkeypatch,
            '{"route":"TASK","confidence":0.9,"reasoning":"ok"}',
        )
        history = [
            ChatMessage(role="user", content=f"msg{i}") for i in range(8)
        ]
        await llm_classify("current", history, None)
        # chat_sync 收到的 context = 最近 4 条 + 当前 user 消息
        last_call_msgs = fake.last_messages
        assert len(last_call_msgs) == 5
        assert last_call_msgs[-1].content == "current"
        assert last_call_msgs[0].content == "msg4"  # 8-4 = 第 4 条起
