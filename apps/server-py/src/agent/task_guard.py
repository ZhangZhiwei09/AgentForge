"""Task guard policy shared by initial execution and durable resumption."""

import json
import re

from pydantic import BaseModel, Field

from src.agent.router.entry_decision import safety_route_scan
from src.rag.splitter import estimate_tokens


class TaskGuardConfig(BaseModel):
    max_tokens: int = Field(default=50000, ge=1000)
    max_cost_cents: float = Field(default=200, ge=1, allow_inf_nan=False)
    allowed_tools: list[str] = Field(default_factory=list)
    denied_tools: list[str] = Field(default_factory=list)
    pii_detection_enabled: bool = True
    content_safety_enabled: bool = True


_RATES = {
    "deepseek-v3": (0.027, 0.11), "deepseek-r1": (0.055, 0.22),
    "deepseek-v4-flash": (0.014, 0.055), "deepseek-chat": (0.027, 0.11),
    "gpt-4o-mini": (0.015, 0.06), "gpt-4o": (0.25, 1),
    "gpt-4-turbo": (1, 3), "claude-sonnet-4-20250514": (0.3, 1.5),
    "claude-fable-5": (0.3, 1.5),
}
_PII = [
    r"\b\d{17}[\dXx]\b", r"\b1[3-9]\d{9}\b", r"\b0\d{2,3}[-\s]?\d{7,8}\b",
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    r"\b\d{16,19}\b", r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    r"\b(?:sk-|key-)[a-zA-Z0-9]{20,}",
    r"""api[_-]?key[=:]\s*['"]?\w{10,}""",
    r"""(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?\S+['"]?""",
    r"(?:省|市|区|县|街道|路|号|栋|单元|室).{3,30}(?:省|市|区|县)",
    r"\b[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼宁][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]\b",
]


def model_rates(model: str) -> tuple[float, float]:
    return next((rate for name, rate in _RATES.items() if model.startswith(name)), (0.1, 0.5))


def model_rate_source(model: str) -> str:
    return "configured_estimate" if any(model.startswith(name) for name in _RATES) else "fallback_estimate"


def sanitize_response(content: str, config: TaskGuardConfig) -> tuple[str, bool]:
    candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
    if candidate.startswith("{") and candidate.endswith("}"):
        try:
            decision = json.loads(candidate)
        except ValueError:
            decision = None  # Non-JSON prose still passes through the normal guards.
        if isinstance(decision, dict) and (
            {"observation", "analysis", "plan"}.issubset(decision)
            or decision.get("action") in ("tool_call", "ask_user", "respond")
        ):
            if decision.get("action") == "respond" and isinstance(decision.get("content"), str):
                content = decision["content"]
            else:
                return "暂时无法处理此请求，请补充信息或联系人工客服。", True
    blocked = config.content_safety_enabled and safety_route_scan(content) is not None
    if blocked:
        return "[内容已被安全过滤器拦截]", True
    if config.pii_detection_enabled:
        for pattern in _PII:
            content = re.sub(
                pattern, lambda match: match[0][:2] + "***" + match[0][-2:] if len(match[0]) > 4 else "***",
                content, flags=re.IGNORECASE,
            )
    return content, False


def count_tokens(content: str) -> int:
    return max(1, estimate_tokens(content))
