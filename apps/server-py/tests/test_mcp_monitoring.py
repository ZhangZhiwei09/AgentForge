"""模拟监控系统 MCP 数据源与工具处理函数测试。"""

import json

import pytest
from pydantic import ValidationError

from src.mcp.monitoring.repository import (
    DEFAULT_TRACE,
    MOCK_TRACE_DATASET,
    is_known_trace,
    lookup_trace,
)
from src.mcp.monitoring.schemas import SCHEMA_VERSION, TraceLog
from src.mcp.monitoring.tools import handle_query_trace_log


# ═══════════════════════════════════════════════════════════
# repository：lookup_trace
# ═══════════════════════════════════════════════════════════


def test_dataset_covers_all_scenarios():
    """数据集覆盖 6 个失败/正常场景 + 未命中默认值，且 abc123 为算法超时别名。"""
    expected_keys = {
        "abc123",
        "trace_algo_timeout",
        "trace_camera_denied",
        "trace_sdk_init_fail",
        "trace_normal_pass",
        "trace_network_timeout",
        "trace_liveness_fail",
    }
    assert expected_keys <= set(MOCK_TRACE_DATASET)
    assert MOCK_TRACE_DATASET["abc123"] is MOCK_TRACE_DATASET["trace_algo_timeout"]


@pytest.mark.parametrize(
    ("trace_id", "error_code", "stage"),
    [
        ("abc123", "FACE_TIMEOUT", "face_capture"),
        ("trace_algo_timeout", "FACE_TIMEOUT", "face_capture"),
        ("trace_camera_denied", "CAMERA_PERMISSION_DENIED", "camera_permission"),
        ("trace_sdk_init_fail", "SDK_INIT_FAIL", "sdk_init"),
        ("trace_normal_pass", None, None),
        ("trace_network_timeout", "NETWORK_TIMEOUT", "upload_phase"),
        ("trace_liveness_fail", "LIVENESS_FAIL", "liveness_detect"),
    ],
)
def test_lookup_trace_known(trace_id, error_code, stage):
    trace = lookup_trace(trace_id)
    assert isinstance(trace, TraceLog)
    assert trace.traceId == trace_id  # traceId 被替换为查询值
    assert trace.errorCode == error_code
    assert trace.errorStage == stage
    assert len(trace.spans) > 0


def test_lookup_trace_unknown_returns_default():
    trace = lookup_trace("does_not_exist")
    assert trace.traceId == "does_not_exist"
    assert trace.errorCode == "UNKNOWN_VERIFY_FAIL"
    assert is_known_trace("does_not_exist") is False


def test_algo_timeout_trace_has_multi_span():
    trace = lookup_trace("abc123")
    assert len(trace.spans) == 5
    timeout_span = next(s for s in trace.spans if s.status == "timeout")
    assert timeout_span.serviceName == "face-algorithm"
    assert timeout_span.tags.get("cpuUsage") == "87%"


# ═══════════════════════════════════════════════════════════
# schemas：Pydantic 校验
# ═══════════════════════════════════════════════════════════


def test_trace_log_schema_validates():
    TraceLog.model_validate(lookup_trace("abc123").model_dump())


def test_trace_log_schema_rejects_invalid_status():
    data = lookup_trace("abc123").model_dump()
    data["overallStatus"] = "nonsense"
    with pytest.raises(ValidationError):
        TraceLog.model_validate(data)


# ═══════════════════════════════════════════════════════════
# tools：handle_query_trace_log
# ═══════════════════════════════════════════════════════════


def test_handle_query_trace_log_returns_envelope():
    out = handle_query_trace_log("abc123")
    envelope = json.loads(out)
    assert envelope["schemaVersion"] == SCHEMA_VERSION
    data = envelope["data"]
    assert data["traceId"] == "abc123"
    assert data["errorCode"] == "FACE_TIMEOUT"
    assert len(data["spans"]) == 5
    assert isinstance(data["conclusion"], str)


def test_handle_query_trace_log_default_for_unknown():
    envelope = json.loads(handle_query_trace_log("unknown_trace_xyz"))
    assert envelope["data"]["errorCode"] == "UNKNOWN_VERIFY_FAIL"
    assert envelope["data"]["traceId"] == "unknown_trace_xyz"


def test_handle_query_trace_log_rejects_empty():
    with pytest.raises(ValueError):
        handle_query_trace_log("")
    with pytest.raises(ValueError):
        handle_query_trace_log("   ")


def test_default_trace_has_conclusion():
    assert isinstance(DEFAULT_TRACE.conclusion, str)
    assert len(DEFAULT_TRACE.conclusion) > 0
