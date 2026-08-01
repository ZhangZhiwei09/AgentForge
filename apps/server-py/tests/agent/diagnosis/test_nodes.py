"""Tests for diagnosis nodes — pure functions for intent classification,
entity extraction, missing fields check, and clarification content.
"""

import pytest

from src.agent.diagnosis.nodes import (
    build_clarification_content,
    classify_intent_from_query,
    extract_entities_from_query,
    get_missing_fields,
)


class TestClassifyIntent:
    """Intent classification tests."""

    def test_single_trace_with_trace_id(self):
        result = classify_intent_from_query("traceId abc123 刷脸失败")
        assert result == "single_trace_diagnosis"

    def test_single_trace_with_order_id(self):
        result = classify_intent_from_query("orderId=ORD456 支付失败")
        assert result == "single_trace_diagnosis"

    def test_single_trace_chinese_trace(self):
        result = classify_intent_from_query("链路：xyz789 查询失败原因")
        assert result == "single_trace_diagnosis"

    def test_merchant_rate_drop(self):
        result = classify_intent_from_query(
            "商户 10086 的通过率下降了，帮我查一下"
        )
        assert result == "merchant_rate_drop"

    def test_merchant_rate_drop_anomaly(self):
        result = classify_intent_from_query(
            "merchant 10086 成功率异常波动，最近失败率很高"
        )
        assert result == "merchant_rate_drop"

    def test_error_code_explanation(self):
        result = classify_intent_from_query("错误码 FACE_TIMEOUT 是什么")
        assert result == "error_code_explanation"

    def test_error_code_pattern(self):
        result = classify_intent_from_query("遇到 MIDDLEWARE_TIMEOUT 报错")
        assert result == "error_code_explanation"

    def test_integration_guidance_sdk(self):
        result = classify_intent_from_query("SDK 初始化失败怎么处理")
        assert result == "integration_guidance"

    def test_integration_guidance_camera(self):
        result = classify_intent_from_query("摄像头权限配置问题")
        assert result == "integration_guidance"

    def test_integration_guidance_h5(self):
        result = classify_intent_from_query("H5 接入配置"
        )
        assert result == "integration_guidance"

    def test_unknown_empty(self):
        result = classify_intent_from_query("不知道什么原因")
        assert result == "unknown"

    def test_unknown_vague(self):
        result = classify_intent_from_query("有个问题想咨询一下")
        assert result == "unknown"


class TestExtractEntities:
    """Entity extraction tests."""

    def test_extract_trace_id(self):
        entities = extract_entities_from_query("traceId abc123 刷脸失败")
        assert entities.get("traceId") == "abc123"

    def test_extract_order_id(self):
        entities = extract_entities_from_query("orderId=ORD456")
        assert entities.get("orderId") == "ORD456"

    def test_extract_error_code(self):
        entities = extract_entities_from_query(
            "遇到错误码 FACE_TIMEOUT 请问怎么办"
        )
        assert entities.get("errorCode") == "FACE_TIMEOUT"

    def test_extract_merchant_id(self):
        entities = extract_entities_from_query("商户 10086")
        assert entities.get("merchantId") == "10086"

    def test_extract_product_liveness(self):
        entities = extract_entities_from_query("活体检测失败了")
        assert entities.get("product") == "liveness"

    def test_extract_product_face_verify(self):
        entities = extract_entities_from_query("刷脸验证超时")
        assert entities.get("product") == "face_verify"

    def test_extract_client_type_h5(self):
        entities = extract_entities_from_query("H5 页面打不开")
        assert entities.get("clientType") == "h5"

    def test_extract_client_type_mini_program(self):
        entities = extract_entities_from_query("小程序里刷脸失败")
        assert entities.get("clientType") == "mini_program"

    def test_extract_environment_test(self):
        entities = extract_entities_from_query(
            "测试环境 traceId abc 超时"
        )
        assert entities.get("environment") == "test"

    def test_extract_timerange_today_morning(self):
        entities = extract_entities_from_query("今天上午通过率下降")
        tr = entities.get("timeRange")
        assert tr is not None
        assert tr["raw"] == "今天上午"

    def test_extract_multiple_entities(self):
        entities = extract_entities_from_query(
            "商户 10086 活体检测 FACE_TIMEOUT 错误，"
            "traceId abc123，H5 页面，今天下午出现"
        )
        assert entities.get("merchantId") == "10086"
        assert entities.get("product") == "liveness"
        assert entities.get("errorCode") == "FACE_TIMEOUT"
        assert entities.get("traceId") == "abc123"
        assert entities.get("clientType") == "h5"


class TestGetMissingFields:
    """Missing fields check tests."""

    def test_error_code_sufficient(self):
        missing = get_missing_fields(
            "error_code_explanation", {"errorCode": "FACE_TIMEOUT"}
        )
        assert missing == []

    def test_error_code_insufficient(self):
        missing = get_missing_fields("error_code_explanation", {})
        assert "errorCode" in missing

    def test_single_trace_sufficient_trace_id(self):
        missing = get_missing_fields(
            "single_trace_diagnosis", {"traceId": "abc123"}
        )
        assert missing == []

    def test_single_trace_sufficient_order_id(self):
        missing = get_missing_fields(
            "single_trace_diagnosis", {"orderId": "ORD456"}
        )
        assert missing == []

    def test_single_trace_insufficient(self):
        missing = get_missing_fields("single_trace_diagnosis", {})
        assert len(missing) > 0

    def test_merchant_rate_sufficient(self):
        entities = {
            "merchantId": "10086",
            "timeRange": {"raw": "今天上午"},
        }
        missing = get_missing_fields("merchant_rate_drop", entities)
        assert missing == []

    def test_merchant_rate_missing_time(self):
        entities = {"merchantId": "10086"}
        missing = get_missing_fields("merchant_rate_drop", entities)
        assert "timeRange" in missing
        assert "merchantId" not in missing

    def test_integration_sufficient(self):
        missing = get_missing_fields(
            "integration_guidance", {"product": "liveness"}
        )
        assert missing == []

    def test_integration_insufficient(self):
        missing = get_missing_fields("integration_guidance", {})
        assert len(missing) > 0

    def test_unknown_always_missing(self):
        missing = get_missing_fields("unknown", {})
        assert len(missing) >= 2


class TestBuildClarificationContent:
    """Clarification content building tests."""

    def test_build_with_recognized(self):
        prompt, hints = build_clarification_content(
            "single_trace_diagnosis",
            ["traceId 或 orderId"],
            {"errorCode": "FACE_TIMEOUT"},
        )
        assert "单笔交易失败" in prompt
        assert "Trace ID 或 订单号" in prompt
        assert "FACE_TIMEOUT" in prompt
        assert len(hints) > 0

    def test_build_without_recognized(self):
        prompt, hints = build_clarification_content(
            "unknown",
            ["merchantId / traceId / orderId / errorCode", "timeRange"],
            {},
        )
        assert "故障排查" in prompt
        assert len(hints) > 0
