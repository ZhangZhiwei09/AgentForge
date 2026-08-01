"""Diagnosis Monitoring Tools —— 诊断监控 Mock 工具。

对应 TS: apps/server/src/tools/business/diagnosis-tools.ts

提供 3 个 Mock 监控工具，供 DiagnosisMode 中的 Agent 调用：
- query_trace_log: 查询单笔 trace 链路日志
- query_merchant_metrics: 查询商户维度的通过率/错误分布
- query_error_code_distribution: 查询全局错误码分布

返回确定性 mock 数据，无需连接真实监控平台。
"""

from src.agent.tools.base import RegisteredTool, RiskLevel, ToolDefinition, ToolFunction


# ═══════════════════════════════════════════════════════════
# Mock Data（从 TS mock-monitoring-data.ts 翻译）
# ═══════════════════════════════════════════════════════════

DEFAULT_TRACE_LOG: dict = {
    "product": "face_verify",
    "clientType": "H5",
    "errorCode": "FACE_TIMEOUT",
    "stage": "活体检测",
    "latencyMs": 3200,
    "sdkVersion": "2.3.1",
    "conclusion": (
        "该笔请求在活体检测阶段超时（3200ms），超过基线 P95 延迟（2500ms）。"
        "可能原因：1) 算法处理耗时过长；2) 网络传输延迟；"
        "3) 客户端性能导致帧数据发送过慢。建议检查该时段算法节点负载和网络指标。"
    ),
}

MOCK_TRACE_LOGS: dict[str, dict] = {
    "abc123": {
        "product": "liveness",
        "clientType": "H5",
        "errorCode": "FACE_TIMEOUT",
        "stage": "活体检测-算法处理",
        "latencyMs": 5200,
        "sdkVersion": "2.4.0",
        "conclusion": (
            "traceId=abc123：该笔请求在活体算法处理阶段耗时 5200ms，"
            "超过超时阈值（5000ms），触发 FACE_TIMEOUT。"
            "该时段算法节点 CPU 使用率 87%，推理队列积压 120 条。"
            "根因：算法节点负载过高，单帧推理延迟从基线 200ms 飙升至 800ms。"
        ),
    },
    "trace_camera_denied": {
        "product": "face_verify",
        "clientType": "H5",
        "errorCode": "CAMERA_PERMISSION_DENIED",
        "stage": "摄像头授权",
        "latencyMs": 150,
        "sdkVersion": "2.4.0",
        "conclusion": (
            "traceId=trace_camera_denied：该用户请求在摄像头授权阶段中断。"
            "错误码 CAMERA_PERMISSION_DENIED 表明浏览器拒绝了摄像头权限请求。"
            "常见原因：1) 用户点击了'拒绝'；2) 浏览器设置中全局禁用了摄像头；"
            "3) HTTP 环境下不支持 getUserMedia（需要 HTTPS）。"
            "建议：引导用户在浏览器设置中允许摄像头权限，并确认页面使用 HTTPS。"
        ),
    },
}

DEFAULT_MERCHANT_METRICS: dict = {
    "product": "face_verify",
    "successRate": 0.87,
    "baselineSuccessRate": 0.92,
    "requestCount": 15000,
    "affectedCount": 1950,
    "p95LatencyMs": 2800,
    "topErrors": [
        {"code": "FACE_TIMEOUT", "count": 850, "rate": 0.44},
        {"code": "LIVENESS_FAIL", "count": 520, "rate": 0.27},
        {"code": "CAMERA_PERMISSION_DENIED", "count": 280, "rate": 0.14},
        {"code": "NETWORK_TIMEOUT", "count": 180, "rate": 0.09},
        {"code": "OTHER", "count": 120, "rate": 0.06},
    ],
    "conclusion": (
        "商户通过率从基线 92% 下降至 87%（降幅 5pp），"
        "受影响请求约 1950 笔。主要错误为 FACE_TIMEOUT（44%）和 "
        "LIVENESS_FAIL（27%）。P95 延迟 2800ms 高于基线 2500ms。"
        "建议：1) 检查算法节点负载和扩容情况；"
        "2) 按端类型/SDK 版本拆分分析；3) 确认是否有版本发布或配置变更。"
    ),
}

MOCK_MERCHANT_METRICS: dict[str, dict] = {
    "10086": {
        "product": "liveness",
        "successRate": 0.79,
        "baselineSuccessRate": 0.91,
        "requestCount": 8500,
        "affectedCount": 1020,
        "p95LatencyMs": 4200,
        "topErrors": [
            {"code": "FACE_TIMEOUT", "count": 520, "rate": 0.51},
            {"code": "LIVENESS_FAIL", "count": 240, "rate": 0.24},
            {"code": "SDK_INIT_FAIL", "count": 130, "rate": 0.13},
            {"code": "NETWORK_TIMEOUT", "count": 80, "rate": 0.08},
            {"code": "OTHER", "count": 50, "rate": 0.05},
        ],
        "conclusion": (
            "商户 10086 活体检测通过率从基线 91% 暴跌至 79%（降幅 12pp），"
            "P95 延迟飙升至 4200ms（基线 2500ms，+68%）。"
            "主要错误是 FACE_TIMEOUT（51%），且 SDK_INIT_FAIL 占比异常（13%）。"
            "高优建议：1) 紧急检查算法服务节点健康度和扩容；"
            "2) 确认是否有近期的 SDK 版本升级导致兼容性问题；"
            "3) 对比该商户与其他商户的指标差异。"
        ),
    },
}

ERROR_DISTRIBUTION: list[dict] = [
    {
        "code": "FACE_TIMEOUT",
        "count": 224,
        "rate": 0.42,
        "change": "+12%",
        "description": (
            "活体检测/人脸比对超时，通常由算法处理耗时过长"
            "或网络传输延迟引起。"
        ),
    },
    {
        "code": "LIVENESS_FAIL",
        "count": 149,
        "rate": 0.28,
        "change": "+5%",
        "description": (
            "活体检测未通过，可能是光线不足、面部遮挡、或翻拍攻击。"
        ),
    },
    {
        "code": "NETWORK_TIMEOUT",
        "count": 85,
        "rate": 0.16,
        "change": "-3%",
        "description": "网络连接超时，客户端到服务端的网络链路不稳定。",
    },
    {
        "code": "CAMERA_PERMISSION_DENIED",
        "count": 42,
        "rate": 0.08,
        "change": "+2%",
        "description": "摄像头权限被拒绝，用户未授权或浏览器不支持。",
    },
    {
        "code": "SDK_INIT_FAIL",
        "count": 18,
        "rate": 0.03,
        "change": "-1%",
        "description": (
            "SDK 初始化失败，可能是 appId/secret 配置错误或版本不兼容。"
        ),
    },
    {
        "code": "OTHER",
        "count": 14,
        "rate": 0.03,
        "change": "-15%",
        "description": "其他未分类错误，需进一步分析。",
    },
]


# ═══════════════════════════════════════════════════════════
# Tool Executors
# ═══════════════════════════════════════════════════════════


async def _query_trace_log(args: dict, run_id: str) -> dict:
    """查询单笔核身请求的完整链路日志。

    Args:
        args: {"traceId": "abc123"} 或 {"orderId": "xxx"}
        run_id: 当前运行 ID（未使用）
    """
    lookup_key = str(args.get("traceId") or args.get("orderId") or "")

    if not lookup_key.strip():
        return {
            "status": "failed",
            "error": "请提供 traceId 或 orderId 以查询链路日志。",
        }

    data = MOCK_TRACE_LOGS.get(lookup_key)
    if data is None:
        data = {**DEFAULT_TRACE_LOG, "traceId": lookup_key}

    note = (
        None
        if lookup_key in MOCK_TRACE_LOGS
        else f'未命中 mock 数据（traceId="{lookup_key}"），返回默认通用结果。'
    )

    result = {
        "traceId": lookup_key,
        "product": data["product"],
        "clientType": data["clientType"],
        "errorCode": data["errorCode"],
        "stage": data["stage"],
        "latencyMs": data["latencyMs"],
        "sdkVersion": data["sdkVersion"],
        "conclusion": data["conclusion"],
    }
    if note:
        result["_note"] = note

    return {"status": "success", "output": result}


async def _query_merchant_metrics(args: dict, run_id: str) -> dict:
    """查询指定商户的核身通过率、基线、请求量和错误分布。

    Args:
        args: {"merchantId": "10086", "product"?: "liveness", "timeRange"?: "今天上午"}
        run_id: 当前运行 ID（未使用）
    """
    merchant_id = str(args.get("merchantId") or "")

    if not merchant_id.strip():
        return {
            "status": "failed",
            "error": "请提供 merchantId 以查询商户指标。",
        }

    data = MOCK_MERCHANT_METRICS.get(merchant_id)
    if data is None:
        data = {**DEFAULT_MERCHANT_METRICS, "merchantId": merchant_id}

    note = (
        None
        if merchant_id in MOCK_MERCHANT_METRICS
        else (
            f'未命中 mock 数据（merchantId="{merchant_id}"），'
            "返回默认基线结果。"
        )
    )

    result = {
        "merchantId": merchant_id,
        "product": data["product"],
        "successRate": data["successRate"],
        "baselineSuccessRate": data["baselineSuccessRate"],
        "requestCount": data["requestCount"],
        "affectedCount": data["affectedCount"],
        "p95LatencyMs": data["p95LatencyMs"],
        "topErrors": data["topErrors"],
        "conclusion": data["conclusion"],
    }
    if note:
        result["_note"] = note

    return {"status": "success", "output": result}


async def _query_error_code_distribution(args: dict, run_id: str) -> dict:
    """查询全局或指定维度的错误码分布和趋势。

    Args:
        args: {"product"?: "liveness", "clientType"?: "H5", "timeRange"?: "今天上午"}
        run_id: 当前运行 ID（未使用）
    """
    product = str(args.get("product") or "全部")
    client_type = str(args.get("clientType") or "全部")

    summary_prefix = (
        f"按 product={product}, clientType={client_type} 过滤后的错误码分布。"
        if (product != "全部" or client_type != "全部")
        else "全局错误码分布。"
    )
    # 对应 TS: 全局时才包含趋势信息
    trend_suffix = (
        "FACE_TIMEOUT 是最主要的错误类型（42%），且呈上升趋势（+12%）。"
        if (product == "全部" and client_type == "全部")
        else "FACE_TIMEOUT 是最主要的错误类型（42%）。"
    )

    return {
        "status": "success",
        "output": {
            "filters": {"product": product, "clientType": client_type},
            "totalErrors": 532,
            "distribution": ERROR_DISTRIBUTION,
            "summary": f"{summary_prefix}{trend_suffix}",
        },
    }


# ═══════════════════════════════════════════════════════════
# RegisteredTool 实例
# ═══════════════════════════════════════════════════════════

query_trace_log_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="query_trace_log",
            description=(
                "查询单笔核身请求的完整链路日志。传入 traceId 或 orderId，"
                "返回该笔请求经过的业务阶段、错误码、耗时、SDK版本和诊断结论。"
                "用于定位单用户刷脸失败的具体原因。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "traceId": {
                        "type": "string",
                        "description": "链路追踪 ID，格式如 abc123。与 orderId 二选一。",
                    },
                    "orderId": {
                        "type": "string",
                        "description": "业务订单 ID。与 traceId 二选一。",
                    },
                },
                "required": [],
            },
        ),
    ),
    execute=_query_trace_log,
    risk_level=RiskLevel.READ_ONLY,
    timeout=10_000,
    require_approval=False,
    category="diagnosis",
    parallelizable=True,
)

query_merchant_metrics_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="query_merchant_metrics",
            description=(
                "查询指定商户的核身通过率、基线、请求量、P95 延迟和 Top 错误码分布。"
                "传入 merchantId 和可选 product、timeRange。"
                "用于排查商户维度通过率下降或异常波动。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "merchantId": {
                        "type": "string",
                        "description": "商户 ID，如 '10086'。",
                    },
                    "product": {
                        "type": "string",
                        "description": (
                            "产品类型：liveness / face_verify / ocr / realname。可选。"
                        ),
                    },
                    "timeRange": {
                        "type": "string",
                        "description": (
                            "时间范围描述，如 '今天上午'、'最近1小时'。可选。"
                        ),
                    },
                },
                "required": ["merchantId"],
            },
        ),
    ),
    execute=_query_merchant_metrics,
    risk_level=RiskLevel.READ_ONLY,
    timeout=10_000,
    require_approval=False,
    category="diagnosis",
    parallelizable=True,
)

query_error_code_distribution_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="query_error_code_distribution",
            description=(
                "查询全局或指定维度的错误码分布和趋势。"
                "支持按 product、clientType、timeRange 过滤。"
                "返回各错误码的出现次数、占比和环比变化。"
                "用于判断某个错误码是否为共性问题。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "product": {
                        "type": "string",
                        "description": (
                            "产品类型过滤：liveness / face_verify / ocr / realname。可选。"
                        ),
                    },
                    "clientType": {
                        "type": "string",
                        "description": (
                            "客户端类型过滤：H5 / 小程序 / App / Web。可选。"
                        ),
                    },
                    "timeRange": {
                        "type": "string",
                        "description": (
                            "时间范围描述，如 '今天上午'、'最近7天'。可选。"
                        ),
                    },
                },
                "required": [],
            },
        ),
    ),
    execute=_query_error_code_distribution,
    risk_level=RiskLevel.READ_ONLY,
    timeout=10_000,
    require_approval=False,
    category="diagnosis",
    parallelizable=True,
)

DIAGNOSIS_TOOLS: list[RegisteredTool] = [
    query_trace_log_tool,
    query_merchant_metrics_tool,
    query_error_code_distribution_tool,
]


def register_diagnosis_tools(registry) -> None:
    """便捷函数：将 3 个诊断工具注册到 ToolRegistry。"""
    for tool in DIAGNOSIS_TOOLS:
        registry.register(tool)
