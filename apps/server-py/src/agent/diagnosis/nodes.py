"""Diagnosis Nodes —— 诊断信息充分性检查纯函数。

对应 TS: apps/server/src/services/diagnosis/nodes.ts

纯函数，无外部依赖，用于：
- 意图分类（classify_intent_from_query）
- 实体提取（extract_entities_from_query）
- 缺失字段检查（get_missing_fields）
- 澄清内容构建（build_clarification_content）
"""

import re
from datetime import datetime, timezone

# ── 正则模式 ──────────────────────────────────────────────

ERROR_CODE_PATTERN = re.compile(r"\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b")
TRACE_PATTERN = re.compile(
    r"\b(?:traceId|trace_id|trace|链路|流水)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})",
    re.IGNORECASE,
)
ORDER_PATTERN = re.compile(
    r"\b(?:orderId|order_id|订单)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})",
    re.IGNORECASE,
)
MERCHANT_PATTERN = re.compile(
    r"(?:商户|merchant|merchantId|merchant_id)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})",
    re.IGNORECASE,
)
APP_PATTERN = re.compile(
    r"\b(?:appId|app_id|应用)\s*[:：=]?\s*([a-zA-Z0-9_-]{3,})",
    re.IGNORECASE,
)

# ── 意图分类 ──────────────────────────────────────────────

DiagnosisIntent = str
"""诊断意图类型：
- single_trace_diagnosis: 单笔交易失败
- merchant_rate_drop: 商户通过率下降
- error_code_explanation: 错误码含义查询
- integration_guidance: 接入配置问题
- unknown: 未知/需要更多信息
"""


def classify_intent_from_query(query: str) -> DiagnosisIntent:
    """根据用户查询文本判断诊断意图。"""
    normalized = query.strip()

    if TRACE_PATTERN.search(normalized) or ORDER_PATTERN.search(normalized):
        return "single_trace_diagnosis"

    if MERCHANT_PATTERN.search(normalized) and re.search(
        r"(通过率|成功率|下降|降低|异常|失败很多|失败率|波动)", normalized
    ):
        return "merchant_rate_drop"

    if ERROR_CODE_PATTERN.search(normalized):
        return "error_code_explanation"

    if re.search(
        r"(接入|配置|摄像头|权限|sdk|SDK|H5|小程序|初始化)", normalized
    ):
        return "integration_guidance"

    return "unknown"


# ── 实体提取 ──────────────────────────────────────────────


def extract_entities_from_query(query: str) -> dict:
    """从用户查询文本中提取结构化实体。"""
    entities: dict = {}

    error_code = ERROR_CODE_PATTERN.search(query)
    trace_id = TRACE_PATTERN.search(query)
    order_id = ORDER_PATTERN.search(query)
    merchant_id = MERCHANT_PATTERN.search(query)
    app_id = APP_PATTERN.search(query)

    if error_code:
        entities["errorCode"] = error_code.group(0)
    if trace_id:
        entities["traceId"] = trace_id.group(1)
    if order_id:
        entities["orderId"] = order_id.group(1)
    if merchant_id:
        entities["merchantId"] = merchant_id.group(1)
    if app_id:
        entities["appId"] = app_id.group(1)

    # 产品类型
    if re.search(r"活体|liveness", query, re.IGNORECASE):
        entities["product"] = "liveness"
    elif re.search(r"人脸|刷脸|face", query, re.IGNORECASE):
        entities["product"] = "face_verify"
    elif re.search(r"OCR|ocr|身份证|证件", query):
        entities["product"] = "ocr"
    elif re.search(r"实名|realname", query, re.IGNORECASE):
        entities["product"] = "realname"

    # 客户端类型
    if re.search(r"H5|h5", query):
        entities["clientType"] = "h5"
    elif re.search(r"小程序", query):
        entities["clientType"] = "mini_program"
    elif re.search(r"App|APP|app", query):
        entities["clientType"] = "app"
    elif re.search(r"Web|WEB|web", query):
        entities["clientType"] = "web"

    # 环境
    if re.search(r"测试环境|test", query, re.IGNORECASE):
        entities["environment"] = "test"
    elif re.search(r"生产|线上|prod", query, re.IGNORECASE):
        entities["environment"] = "prod"

    # 时间范围
    time_range = _extract_time_range(query)
    if time_range:
        entities["timeRange"] = time_range

    return entities


def _extract_time_range(query: str) -> dict | None:
    """从中文文本中提取时间范围。"""
    now = datetime.now(timezone.utc)
    yyyy_mm_dd = now.strftime("%Y-%m-%d")

    if re.search(r"今天上午", query):
        return {
            "raw": "今天上午",
            "start": f"{yyyy_mm_dd}T09:00:00+08:00",
            "end": f"{yyyy_mm_dd}T12:00:00+08:00",
        }

    if re.search(r"今天下午", query):
        return {
            "raw": "今天下午",
            "start": f"{yyyy_mm_dd}T13:00:00+08:00",
            "end": f"{yyyy_mm_dd}T18:00:00+08:00",
        }

    if re.search(r"今天|今日", query):
        return {
            "raw": "今天",
            "start": f"{yyyy_mm_dd}T00:00:00+08:00",
            "end": f"{yyyy_mm_dd}T23:59:59+08:00",
        }

    hour_range = re.search(
        r"(\d{1,2})[:：点时](?:\d{1,2}分?)?\s*(?:到|-|~|至)\s*(\d{1,2})[:：点时]",
        query,
    )
    if hour_range:
        start_hour = hour_range.group(1).zfill(2)
        end_hour = hour_range.group(2).zfill(2)
        return {
            "raw": hour_range.group(0),
            "start": f"{yyyy_mm_dd}T{start_hour}:00:00+08:00",
            "end": f"{yyyy_mm_dd}T{end_hour}:00:00+08:00",
        }

    return None


# ── 缺失字段检查 ──────────────────────────────────────────


def get_missing_fields(intent: DiagnosisIntent, entities: dict) -> list[str]:
    """根据意图返回缺失的必要字段列表。"""
    match intent:
        case "error_code_explanation":
            return [] if entities.get("errorCode") else ["errorCode"]
        case "single_trace_diagnosis":
            return (
                []
                if (entities.get("traceId") or entities.get("orderId"))
                else ["traceId 或 orderId"]
            )
        case "merchant_rate_drop":
            missing = []
            if not entities.get("merchantId"):
                missing.append("merchantId")
            if not entities.get("timeRange"):
                missing.append("timeRange")
            return missing
        case "integration_guidance":
            return (
                []
                if (entities.get("product") or entities.get("clientType"))
                else ["product 或 clientType"]
            )
        case _:
            return ["merchantId / traceId / orderId / errorCode", "timeRange"]


# ── 澄清内容构建 ──────────────────────────────────────────

INTENT_LABELS: dict[str, str] = {
    "single_trace_diagnosis": "单笔交易失败",
    "merchant_rate_drop": "商户通过率下降",
    "error_code_explanation": "错误码含义查询",
    "integration_guidance": "接入配置问题",
    "unknown": "故障排查",
}

FIELD_HINTS: dict[str, dict[str, str]] = {
    "traceId": {
        "label": "Trace ID",
        "hint": (
            "可在浏览器开发者工具（Network 面板）或服务端日志中查找，"
            "通常格式为 traceId: xxx-xxx-xxx"
        ),
    },
    "traceId 或 orderId": {
        "label": "Trace ID 或 订单号",
        "hint": "请提供其中任意一项。Trace ID 可在日志中查找，订单号可在业务系统中查看",
    },
    "orderId": {
        "label": "订单号",
        "hint": "可在业务系统的订单详情页或用户提供的截图中查看",
    },
    "errorCode": {
        "label": "错误码",
        "hint": (
            "通常是报错信息中的错误码，如 MIDDLEWARE_TIMEOUT、"
            "BIZ_CHECK_FAILED 等"
        ),
    },
    "merchantId": {
        "label": "商户号",
        "hint": "可在商户管理后台或业务系统中查看",
    },
    "timeRange": {
        "label": "失败时间范围",
        "hint": "例如：今天上午 10:00-11:00、昨天下午、最近 1 小时内",
    },
    "merchantId / traceId / orderId / errorCode": {
        "label": "可定位的标识信息",
        "hint": "请提供以下任意一项：商户号、Trace ID、订单号、错误码",
    },
    "product 或 clientType": {
        "label": "产品类型 或 客户端类型",
        "hint": "例如：活体检测/人脸识别/OCR、H5/小程序/App/Web",
    },
}

ENTITY_LABEL_MAP: dict[str, str] = {
    "traceId": "Trace ID",
    "orderId": "订单号",
    "errorCode": "错误码",
    "merchantId": "商户号",
    "appId": "应用 ID",
    "product": "产品",
    "clientType": "客户端类型",
    "environment": "环境",
}


def build_clarification_content(
    intent: str,
    missing_fields: list[str],
    entities: dict,
) -> tuple[str, list[str]]:
    """构建信息不足时的澄清提示。

    Returns:
        (prompt_message, hints): 提示文本和提示列表
    """
    intent_label = INTENT_LABELS.get(intent, INTENT_LABELS["unknown"])

    field_labels = "、".join(
        FIELD_HINTS.get(f, {}).get("label", f) for f in missing_fields
    )
    hints = [
        h
        for f in missing_fields
        if (h := FIELD_HINTS.get(f, {}).get("hint"))
    ]

    # 列出已识别的信息
    recognized_parts: list[str] = []
    for key, value in entities.items():
        if value and isinstance(value, str):
            label = ENTITY_LABEL_MAP.get(key, key)
            recognized_parts.append(f"- {label}: {value}")

    recognized_line = ""
    if recognized_parts:
        recognized_line = (
            "\n\n已识别到的信息：\n" + "\n".join(recognized_parts)
        )

    prompt_message = "\n".join(
        [
            f"我理解您遇到了{intent_label}相关的问题。"
            "为了帮您更准确地排查，还需要补充以下信息：",
            "",
            f"**需要补充**：{field_labels}",
            recognized_line,
            "",
            "请直接在聊天框中回复以上信息，我会立即开始帮您诊断。",
        ]
    ).strip()

    return prompt_message, hints
