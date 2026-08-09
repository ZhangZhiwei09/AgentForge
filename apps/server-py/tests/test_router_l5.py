"""L5 正则兜底测试 —— 移植 TS routing/__tests__/l5-fallback.test.ts。"""

import pytest

from src.agent.router.l5_fallback import INTENT_TO_ROUTE, fallback_classify
from src.agent.types import RouteName

VALID_ROUTES = {r.value for r in RouteName}


class TestIntentToRoute:
    """INTENT_TO_ROUTE 映射常量校验。"""

    def test_all_values_are_valid_routes(self):
        for intent, route in INTENT_TO_ROUTE.items():
            assert route.value in VALID_ROUTES, f"{intent} → {route} 非法"

    def test_mapping_expected(self):
        assert INTENT_TO_ROUTE["退货退款"] == RouteName.TASK
        assert INTENT_TO_ROUTE["物流查询"] == RouteName.TASK
        assert INTENT_TO_ROUTE["售后联系"] == RouteName.HUMAN
        assert INTENT_TO_ROUTE["账户会员"] == RouteName.TASK
        assert INTENT_TO_ROUTE["支付订单"] == RouteName.TASK
        assert INTENT_TO_ROUTE["其他咨询"] == RouteName.TASK

    def test_only_human_maps_to_human(self):
        for intent, route in INTENT_TO_ROUTE.items():
            if intent == "售后联系":
                assert route == RouteName.HUMAN
            else:
                assert route == RouteName.TASK


class TestFallbackClassify:
    """fallback_classify 分类逻辑。"""

    def test_return_fields(self):
        result = fallback_classify("测试消息")
        assert result.route in VALID_ROUTES
        assert isinstance(result.confidence, float)
        assert isinstance(result.reasoning, str)

    def test_return_valid_route_for_all_inputs(self):
        inputs = [
            "退货退款", "查物流", "投诉", "转人工", "订单",
            "会员", "今天天气怎么样", "", "hello world", "12345",
        ]
        for msg in inputs:
            result = fallback_classify(msg)
            assert result.route.value in VALID_ROUTES, f"{msg} → {result.route}"

    # ── 各意图 → 路由 ──

    @pytest.mark.parametrize(
        ("message", "expected_route", "intent"),
        [
            ("退换货", RouteName.TASK, "退货退款"),
            ("我要退货", RouteName.TASK, "退货退款"),
            ("订单查询", RouteName.TASK, "支付订单"),
            ("怎么支付", RouteName.TASK, "支付订单"),
            ("查物流", RouteName.TASK, "物流查询"),
            ("会员积分怎么查", RouteName.TASK, "账户会员"),
            ("投诉", RouteName.HUMAN, "售后联系"),
            ("转接人工", RouteName.HUMAN, "售后联系"),
            ("我要找客服", RouteName.HUMAN, "售后联系"),
            ("你们客服电话多少", RouteName.HUMAN, "售后联系"),
        ],
    )
    def test_route_correctness(self, message, expected_route, intent):
        result = fallback_classify(message)
        assert result.route == expected_route
        assert result.confidence > 0
        assert intent in result.reasoning

    # ── 未知 / 兜底 → TASK ──

    @pytest.mark.parametrize(
        "message", ["今天天气怎么样", "abcdefg", ""]
    )
    def test_unknown_falls_to_task(self, message):
        result = fallback_classify(message)
        assert result.route == RouteName.TASK
        assert result.confidence == 0
        assert "其他咨询" in result.reasoning

    # ── confidence 数值（复刻 JS 无 g flag 语义：命中恒 0.7）──

    def test_single_keyword_confidence_0_7(self):
        assert fallback_classify("退货").confidence == 0.7

    def test_multi_keyword_still_0_7(self):
        """退货退款 命中多个关键词，但 JS match() 无 g flag 恒返回首个 → 仍 0.7。"""
        assert fallback_classify("退货退款").confidence == 0.7

    def test_no_match_confidence_0(self):
        assert fallback_classify("今天天气怎么样").confidence == 0

    # ── reasoning 格式 ──

    def test_reasoning_prefix(self):
        result = fallback_classify("我要退货")
        assert result.reasoning.startswith("IntentDetector fallback: ")

    def test_reasoning_contains_two_decimal_confidence(self):
        result = fallback_classify("退货退款")
        prefix = f"(confidence: {result.confidence:.2f})"
        assert prefix in result.reasoning

    # ── 参数化：每个意图可被正确路由 ──

    @pytest.mark.parametrize(
        ("message", "expected_route"),
        [
            ("我要退货", RouteName.TASK),
            ("查物流", RouteName.TASK),
            ("我要投诉", RouteName.HUMAN),
            ("查会员积分", RouteName.TASK),
            ("订单支付问题", RouteName.TASK),
            ("今天天气怎么样", RouteName.TASK),
        ],
    )
    def test_parameterized_routing(self, message, expected_route):
        result = fallback_classify(message)
        assert result.route == expected_route
