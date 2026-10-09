"""Tests for diagnosis mode pure functions — JSON parsing, output parsing,
escalation checking, fallback scoring, and resolution logic.
"""

import json

import pytest

from src.agent.diagnosis.mode import (
    BackendOutput,
    FrontendOutput,
    ScoringResult,
    build_fallback_scoring,
    check_rule_escalation,
    extract_json,
    parse_backend_output,
    parse_frontend_output,
    parse_scoring_output,
    resolve_diagnosis,
)


class TestExtractJson:
    """JSON extraction from LLM output."""

    def test_fenced_code_block(self):
        text = '```json\n{"key": "value"}\n```'
        result = extract_json(text)
        assert result == {"key": "value"}

    def test_fenced_no_lang(self):
        text = '```\n{"key": "value"}\n```'
        result = extract_json(text)
        assert result == {"key": "value"}

    def test_bare_json(self):
        text = 'some text {"key": "value"} more text'
        result = extract_json(text)
        assert result == {"key": "value"}

    def test_no_json(self):
        with pytest.raises(ValueError, match="No JSON"):
            extract_json("no json here")

    def test_nested_json(self):
        text = '{"outer": {"inner": [1, 2, 3]}}'
        result = extract_json(text)
        assert result == {"outer": {"inner": [1, 2, 3]}}


class TestCheckRuleEscalation:
    """Rule-based escalation check."""

    def test_face_timeout_triggers(self):
        assert check_rule_escalation("errorCode: FACE_TIMEOUT") is True

    def test_unknown_timeout_error_code_triggers(self):
        assert check_rule_escalation("errorCode: ACE_TIMEOUT") is True

    def test_server_error_triggers(self):
        assert check_rule_escalation("SERVER_ERROR occurred") is True

    def test_liveness_stage_pattern(self):
        assert check_rule_escalation("活体检测阶段失败") is True

    def test_backend_abnormal_pattern(self):
        assert check_rule_escalation(
            "请求到达后端返回异常"
        ) is True

    def test_normal_frontend_issue_no_escalation(self):
        assert check_rule_escalation(
            "摄像头权限被拒绝，用户未授权。建议检查浏览器设置。"
        ) is False

    def test_case_insensitive(self):
        assert check_rule_escalation("face_timeout error") is True


class TestParseFrontendOutput:
    """Frontend output parsing."""

    def test_valid_with_escalation(self):
        output = json.dumps({
            "conclusion": "摄像头权限被拒绝",
            "evidence": [{"type": "log", "detail": "getUserMedia denied"}],
            "need_escalation": False,
            "escalation_reason": None,
            "context_for_backend": {},
        })
        result = parse_frontend_output(output)
        assert result.conclusion == "摄像头权限被拒绝"
        assert len(result.evidence) == 1
        assert result.need_escalation is False
        assert result.escalation_reason is None

    def test_valid_no_escalation(self):
        output = json.dumps({
            "conclusion": "浏览器权限问题",
            "evidence": [],
            "need_escalation": False,
            "escalation_reason": None,
            "context_for_backend": {},
        })
        result = parse_frontend_output(output)
        assert result.need_escalation is False

    def test_fallback_on_invalid_json(self):
        result = parse_frontend_output("not json at all")
        assert result.conclusion == "not json at all"
        assert result.need_escalation is False
        assert result.evidence == []

    def test_fenced_json_output(self):
        output = '```json\n' + json.dumps({
            "conclusion": "test",
            "evidence": [],
            "need_escalation": True,
            "escalation_reason": "backend error",
            "context_for_backend": {"traceId": "abc"},
        }) + '\n```'
        result = parse_frontend_output(output)
        assert result.need_escalation is True
        assert result.escalation_reason == "backend error"
        assert result.context_for_backend == {"traceId": "abc"}

    def test_empty_conclusion_cannot_fast_track(self):
        result = parse_frontend_output(
            '{"conclusion": "", "evidence": [], "need_escalation": false}'
        )
        assert "未提供可验证结论" in result.conclusion
        assert result.need_escalation is True
        assert result.escalation_reason == "cannot_determine"


class TestParseBackendOutput:
    """Backend output parsing."""

    def test_valid(self):
        output = json.dumps({
            "conclusion": "算法节点负载过高导致超时",
            "evidence": [
                {"type": "trace", "detail": "P95延迟3200ms"}
            ],
        })
        result = parse_backend_output(output)
        assert result.conclusion == "算法节点负载过高导致超时"
        assert len(result.evidence) == 1

    def test_fallback(self):
        result = parse_backend_output("not json")
        assert result.conclusion == "not json"
        assert result.evidence == []

    def test_empty_conclusion_fallback(self):
        result = parse_backend_output('{"conclusion": "", "evidence": []}')
        assert "未提供可验证结论" in result.conclusion


class TestParseScoringOutput:
    """Leader scoring output parsing."""

    def test_valid(self):
        output = json.dumps({
            "frontend_score": 5,
            "backend_score": 7,
            "frontend_breakdown": {
                "evidence_quality": 2,
                "verifiability": 1,
                "coverage": 1,
                "domain_authority": 1,
            },
            "backend_breakdown": {
                "evidence_quality": 3,
                "verifiability": 2,
                "coverage": 2,
                "domain_authority": 0,
            },
            "reasoning": "后端有监控数据支撑",
            "synthesis": "算法超时是根因",
            "missing_fields": [],
            "message": "",
        })
        result = parse_scoring_output(output)
        assert result.frontend_score == 5
        assert result.backend_score == 7
        assert result.synthesis == "算法超时是根因"

    def test_fallback(self):
        result = parse_scoring_output("invalid")
        assert result.frontend_score == 0
        assert result.backend_score == 0
        assert result.message == "自动评分未产出有效结果，已转人工处理。"


class TestBuildFallbackScoring:
    """Fallback scoring generation."""

    def test_zero_score(self):
        frontend = FrontendOutput(
            conclusion="FE conclusion", evidence=[], need_escalation=True
        )
        backend = BackendOutput(conclusion="BE conclusion", evidence=[])
        result = build_fallback_scoring(frontend, backend, "reason text")
        assert result.frontend_score == 0
        assert result.backend_score == 0
        assert result.reasoning == "reason text"
        assert "FE conclusion" in result.synthesis
        assert "BE conclusion" in result.synthesis


class TestResolveDiagnosis:
    """Resolution logic tests."""

    def _make_frontend(self, conclusion="fe conclusion"):
        return FrontendOutput(
            conclusion=conclusion,
            evidence=[],
            need_escalation=True,
        )

    def _make_backend(self, conclusion="be conclusion"):
        return BackendOutput(
            conclusion=conclusion,
            evidence=[],
        )

    def test_needs_human_both_low(self):
        scoring = ScoringResult(
            frontend_score=2, backend_score=1,
            synthesis="info insufficient",
            missing_fields=["traceId"],
            message="需要更多信息",
        )
        result = resolve_diagnosis(
            self._make_frontend(), self._make_backend(), scoring
        )
        assert result.resolution == "needs_human"
        assert result.final_diagnosis["status"] == "needs_human"

    def test_adopt_frontend(self):
        scoring = ScoringResult(
            frontend_score=8, backend_score=4,
            synthesis="frontend conclusion is stronger",
        )
        result = resolve_diagnosis(
            self._make_frontend("fe wins"), self._make_backend("be loses"), scoring
        )
        assert result.resolution == "adopt_frontend"
        assert result.final_diagnosis["conclusion"] == "fe wins"

    def test_adopt_backend(self):
        scoring = ScoringResult(
            frontend_score=3, backend_score=7,
            synthesis="backend conclusion is stronger",
        )
        result = resolve_diagnosis(
            self._make_frontend("fe loses"), self._make_backend("be wins"), scoring
        )
        assert result.resolution == "adopt_backend"
        assert result.final_diagnosis["conclusion"] == "be wins"

    def test_divergent(self):
        scoring = ScoringResult(
            frontend_score=6, backend_score=5,
            synthesis="both have merit",
        )
        result = resolve_diagnosis(
            self._make_frontend(), self._make_backend(), scoring
        )
        assert result.resolution == "divergent"
        assert "frontend_view" in result.final_diagnosis
        assert "backend_view" in result.final_diagnosis

    def test_exact_boundary_diff_3(self):
        scoring = ScoringResult(
            frontend_score=7, backend_score=4,
            synthesis="borderline case",
        )
        result = resolve_diagnosis(
            self._make_frontend(), self._make_backend(), scoring
        )
        assert result.resolution == "adopt_frontend"

    def test_exact_boundary_max_3(self):
        scoring = ScoringResult(
            frontend_score=3, backend_score=3,
            synthesis="borderline",
        )
        result = resolve_diagnosis(
            self._make_frontend(), self._make_backend(), scoring
        )
        # max_score=3 >= 3, diff=0 < 3 → divergent
        assert result.resolution == "divergent"

    def test_needs_human_max_below_3(self):
        scoring = ScoringResult(
            frontend_score=2, backend_score=2,
            synthesis="nothing helpful",
            missing_fields=["traceId"],
            message="信息不足",
        )
        result = resolve_diagnosis(
            self._make_frontend(), self._make_backend(), scoring
        )
        assert result.resolution == "needs_human"
