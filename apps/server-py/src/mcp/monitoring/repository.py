"""模拟监控数据源。

本模块是唯一一份 mock 监控数据（单一数据源），TS 侧旧 mock 与
server-py 诊断图均以本模块为准，消除多份拷贝漂移。

未来接入真实监控平台时，保持 lookup_trace 的查询契约不变，新增真实数据源
实现（如 alibaba_repository），由 server.py / tools.py 依赖切换即可。

traceId 键约定：
- abc123 / trace_algo_timeout: 算法超时场景（abc123 为兼容历史测试的别名）
- trace_camera_denied / trace_sdk_init_fail / trace_network_timeout /
  trace_liveness_fail: 各失败场景
- trace_normal_pass: 正常通过对比参考
- 未命中返回 DEFAULT_TRACE（traceId 会被替换为查询值）
"""

from __future__ import annotations

from .schemas import TraceLog


def _spans(items: list[dict]) -> list[dict]:
    """构造 spans 列表的便捷函数（仅用于压缩字面量）。"""
    return items


ALGO_TIMEOUT_TRACE = TraceLog(
    traceId="trace_algo_timeout",
    orderId="order_20260804_0001",
    product="liveness",
    clientType="h5",
    sdkVersion="3.1.8",
    overallDurationMs=6550,
    overallStatus="failed",
    errorCode="FACE_TIMEOUT",
    errorStage="face_capture",
    spans=_spans(
        [
            {
                "spanId": "span-001",
                "serviceName": "gateway",
                "operationName": "request_forward",
                "startTime": "2026-08-04T10:00:00.000Z",
                "endTime": "2026-08-04T10:00:00.050Z",
                "durationMs": 50,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-002",
                "serviceName": "face-algorithm",
                "operationName": "liveness_detect",
                "startTime": "2026-08-04T10:00:00.050Z",
                "endTime": "2026-08-04T10:00:05.250Z",
                "durationMs": 5200,
                "status": "timeout",
                "errorCode": "FACE_TIMEOUT",
                "errorMessage": "推理超时，处理时间超过 5000ms 阈值",
                "tags": {"cpuUsage": "87%", "queueDepth": "120"},
            },
            {
                "spanId": "span-003",
                "serviceName": "liveness-check",
                "operationName": "liveness_verify",
                "startTime": "2026-08-04T10:00:00.050Z",
                "endTime": "2026-08-04T10:00:00.350Z",
                "durationMs": 300,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-004",
                "serviceName": "camera-service",
                "operationName": "frame_capture",
                "startTime": "2026-08-04T10:00:00.050Z",
                "endTime": "2026-08-04T10:00:00.850Z",
                "durationMs": 800,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-005",
                "serviceName": "sdk-bridge",
                "operationName": "sdk_communicate",
                "startTime": "2026-08-04T10:00:00.350Z",
                "endTime": "2026-08-04T10:00:00.550Z",
                "durationMs": 200,
                "status": "ok",
                "tags": {"sdkVersion": "3.1.8", "clientType": "h5"},
            },
        ]
    ),
    conclusion=(
        "该笔请求在活体算法处理阶段耗时 5200ms，超过超时阈值（5000ms），触发 FACE_TIMEOUT。"
        "该时段算法节点 CPU 使用率 87%，推理队列积压 120 条。"
        "根因：算法节点负载过高，单帧推理延迟从基线 200ms 飙升至 800ms。"
        "建议：紧急检查算法服务节点健康度和扩容情况。"
    ),
)

CAMERA_DENIED_TRACE = TraceLog(
    traceId="trace_camera_denied",
    orderId="order_20260804_0002",
    product="face_verify",
    clientType="h5",
    sdkVersion="3.3.0",
    overallDurationMs=150,
    overallStatus="failed",
    errorCode="CAMERA_PERMISSION_DENIED",
    errorStage="camera_permission",
    spans=_spans(
        [
            {
                "spanId": "span-101",
                "serviceName": "sdk-bridge",
                "operationName": "camera_authorize",
                "startTime": "2026-08-04T11:20:00.000Z",
                "endTime": "2026-08-04T11:20:00.150Z",
                "durationMs": 150,
                "status": "error",
                "errorCode": "CAMERA_PERMISSION_DENIED",
                "errorMessage": "浏览器未授予摄像头权限（NotAllowedError）",
                "tags": {"clientType": "h5"},
            }
        ]
    ),
    conclusion=(
        "该用户请求在摄像头授权阶段中断，错误码 CAMERA_PERMISSION_DENIED 表明浏览器拒绝了摄像头权限。"
        "常见原因：1) 用户点击了拒绝；2) 浏览器设置中全局禁用摄像头；3) HTTP 环境下 getUserMedia 不可用（需 HTTPS）。"
        "建议：引导用户在浏览器设置中允许摄像头权限，并确认页面使用 HTTPS 后重试。"
    ),
)

SDK_INIT_FAIL_TRACE = TraceLog(
    traceId="trace_sdk_init_fail",
    orderId="order_20260804_0003",
    product="face_verify",
    clientType="app",
    sdkVersion="2.1.0",
    overallDurationMs=80,
    overallStatus="failed",
    errorCode="SDK_INIT_FAIL",
    errorStage="sdk_init",
    spans=_spans(
        [
            {
                "spanId": "span-201",
                "serviceName": "sdk-bridge",
                "operationName": "sdk_initialize",
                "startTime": "2026-08-04T09:05:00.000Z",
                "endTime": "2026-08-04T09:05:00.080Z",
                "durationMs": 80,
                "status": "error",
                "errorCode": "SDK_INIT_FAIL",
                "errorMessage": "appId/secret 校验失败",
                "tags": {"sdkVersion": "2.1.0"},
            }
        ]
    ),
    conclusion=(
        "SDK 初始化失败，通常由 appId/secret 配置错误或 SDK 版本不兼容引起。"
        "当前 SDK 版本 2.1.0 与后端 3.x 协议存在兼容性问题，建议升级至 3.x 最新版本并核对 appId/secret 配置。"
    ),
)

NORMAL_PASS_TRACE = TraceLog(
    traceId="trace_normal_pass",
    orderId="order_20260804_0004",
    product="liveness",
    clientType="web",
    sdkVersion="3.2.0",
    overallDurationMs=2960,
    overallStatus="success",
    spans=_spans(
        [
            {
                "spanId": "span-301",
                "serviceName": "gateway",
                "operationName": "request_forward",
                "startTime": "2026-08-04T14:00:00.000Z",
                "endTime": "2026-08-04T14:00:00.040Z",
                "durationMs": 40,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-302",
                "serviceName": "face-algorithm",
                "operationName": "liveness_detect",
                "startTime": "2026-08-04T14:00:00.040Z",
                "endTime": "2026-08-04T14:00:01.840Z",
                "durationMs": 1800,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-303",
                "serviceName": "liveness-check",
                "operationName": "liveness_verify",
                "startTime": "2026-08-04T14:00:01.840Z",
                "endTime": "2026-08-04T14:00:02.240Z",
                "durationMs": 400,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-304",
                "serviceName": "camera-service",
                "operationName": "frame_capture",
                "startTime": "2026-08-04T14:00:00.040Z",
                "endTime": "2026-08-04T14:00:00.640Z",
                "durationMs": 600,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-305",
                "serviceName": "sdk-bridge",
                "operationName": "sdk_communicate",
                "startTime": "2026-08-04T14:00:02.240Z",
                "endTime": "2026-08-04T14:00:02.360Z",
                "durationMs": 120,
                "status": "ok",
                "tags": {"sdkVersion": "3.2.0"},
            },
        ]
    ),
    conclusion=(
        "该笔核身请求正常通过，各阶段耗时均在基线范围内（算法处理 1800ms、整体 2960ms）。"
        "无异常指标，可作为对比参考。"
    ),
)

NETWORK_TIMEOUT_TRACE = TraceLog(
    traceId="trace_network_timeout",
    orderId="order_20260804_0005",
    product="liveness",
    clientType="mini_program",
    sdkVersion="3.1.0",
    overallDurationMs=12100,
    overallStatus="timeout",
    errorCode="NETWORK_TIMEOUT",
    errorStage="upload_phase",
    spans=_spans(
        [
            {
                "spanId": "span-401",
                "serviceName": "gateway",
                "operationName": "request_forward",
                "startTime": "2026-08-04T16:40:00.000Z",
                "endTime": "2026-08-04T16:40:00.100Z",
                "durationMs": 100,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-402",
                "serviceName": "sdk-bridge",
                "operationName": "upload_frames",
                "startTime": "2026-08-04T16:40:00.100Z",
                "endTime": "2026-08-04T16:40:12.100Z",
                "durationMs": 12000,
                "status": "timeout",
                "errorCode": "NETWORK_TIMEOUT",
                "errorMessage": "上行帧数据阶段网络断开",
                "tags": {"clientType": "mini_program"},
            },
        ]
    ),
    conclusion=(
        "该笔请求在 SDK 上行帧数据阶段超时（12000ms），错误码 NETWORK_TIMEOUT 表明客户端到服务端的网络链路中断。"
        "常见原因：弱网环境、WebSocket 连接断开、请求体过大。"
        "建议：检查客户端网络状态与连接重试策略，必要时缩小单帧数据体积。"
    ),
)

LIVENESS_FAIL_TRACE = TraceLog(
    traceId="trace_liveness_fail",
    orderId="order_20260804_0006",
    product="face_verify",
    clientType="web",
    sdkVersion="3.2.5",
    overallDurationMs=3395,
    overallStatus="failed",
    errorCode="LIVENESS_FAIL",
    errorStage="liveness_detect",
    spans=_spans(
        [
            {
                "spanId": "span-501",
                "serviceName": "gateway",
                "operationName": "request_forward",
                "startTime": "2026-08-04T08:30:00.000Z",
                "endTime": "2026-08-04T08:30:00.045Z",
                "durationMs": 45,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-502",
                "serviceName": "camera-service",
                "operationName": "frame_capture",
                "startTime": "2026-08-04T08:30:00.045Z",
                "endTime": "2026-08-04T08:30:00.745Z",
                "durationMs": 700,
                "status": "ok",
                "tags": {},
            },
            {
                "spanId": "span-503",
                "serviceName": "liveness-check",
                "operationName": "liveness_verify",
                "startTime": "2026-08-04T08:30:00.745Z",
                "endTime": "2026-08-04T08:30:03.245Z",
                "durationMs": 2500,
                "status": "error",
                "errorCode": "LIVENESS_FAIL",
                "errorMessage": "活体检测未通过（疑似翻拍/遮挡）",
                "tags": {},
            },
            {
                "spanId": "span-504",
                "serviceName": "sdk-bridge",
                "operationName": "sdk_communicate",
                "startTime": "2026-08-04T08:30:03.245Z",
                "endTime": "2026-08-04T08:30:03.395Z",
                "durationMs": 150,
                "status": "ok",
                "tags": {"clientType": "web"},
            },
        ]
    ),
    conclusion=(
        "活体检测未通过（LIVENESS_FAIL），算法返回疑似翻拍/遮挡。"
        "常见原因：光线不足、面部遮挡、翻拍攻击。"
        "建议：引导用户调整光线和拍摄角度后重试，若仍失败可结合人工审核通道复核。"
    ),
)

DEFAULT_TRACE = TraceLog(
    traceId="unknown",
    orderId="unknown",
    product="face_verify",
    clientType="h5",
    sdkVersion="unknown",
    overallDurationMs=0,
    overallStatus="failed",
    errorCode="UNKNOWN_VERIFY_FAIL",
    errorStage="unknown",
    spans=_spans(
        [
            {
                "spanId": "span-default",
                "serviceName": "gateway",
                "operationName": "request_forward",
                "startTime": "2026-08-04T00:00:00.000Z",
                "endTime": "2026-08-04T00:00:00.000Z",
                "durationMs": 0,
                "status": "error",
                "errorMessage": "未命中模拟 trace 数据",
                "tags": {},
            }
        ]
    ),
    conclusion="未命中模拟 trace 数据，仅能给出通用核身失败排查建议：请先确认失败阶段和错误码，再结合端类型、SDK 版本与网络状态定位。",
)

# 数据源：traceId -> TraceLog。abc123 为 trace_algo_timeout 的兼容别名。
MOCK_TRACE_DATASET: dict[str, TraceLog] = {
    "abc123": ALGO_TIMEOUT_TRACE,
    "trace_algo_timeout": ALGO_TIMEOUT_TRACE,
    "trace_camera_denied": CAMERA_DENIED_TRACE,
    "trace_sdk_init_fail": SDK_INIT_FAIL_TRACE,
    "trace_normal_pass": NORMAL_PASS_TRACE,
    "trace_network_timeout": NETWORK_TIMEOUT_TRACE,
    "trace_liveness_fail": LIVENESS_FAIL_TRACE,
}


def is_known_trace(trace_id: str) -> bool:
    """判断 traceId 是否命中模拟数据集（未命中时 lookup_trace 返回默认值）。"""
    return trace_id in MOCK_TRACE_DATASET


def lookup_trace(trace_id: str) -> TraceLog:
    """按 traceId 查询一笔链路日志。

    未命中时返回 DEFAULT_TRACE（traceId 替换为查询值），保证结果结构完整，
    由上层结合 is_known_trace 判定是否命中。
    """
    trace = MOCK_TRACE_DATASET.get(trace_id)
    if trace is None:
        return DEFAULT_TRACE.model_copy(update={"traceId": trace_id})
    return trace.model_copy(update={"traceId": trace_id})
