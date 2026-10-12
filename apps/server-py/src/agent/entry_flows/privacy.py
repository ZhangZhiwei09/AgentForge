import re


def redact_entry_text(value: str) -> str:
    value = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b", "[REDACTED]", value)
    value = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED]", value)
    value = re.sub(r"((?:api[_ -]?key|password|密码|secret|authorization|access[_ -]?token)\s*[:=]\s*)[^\s,;，；]+",
                   r"\1[REDACTED]", value, flags=re.IGNORECASE)
    value = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[EMAIL]", value, flags=re.IGNORECASE)
    return re.sub(r"\b1[3-9]\d{9}\b", "[PHONE]", value)


def redact_entry_value(value):
    if isinstance(value, str):
        return redact_entry_text(value)
    if isinstance(value, list):
        return [redact_entry_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if re.fullmatch(r"password|secret|authorization|api[_-]?key|access[_-]?token", key, re.IGNORECASE)
            else redact_entry_value(item) for key, item in value.items()
        }
    return value
