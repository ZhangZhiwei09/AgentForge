"""Bound and redact observation copies without changing business inputs."""

import logging
import math
import re
import traceback
from itertools import islice
from urllib.parse import urlsplit

REDACTED = "[REDACTED]"
TRUNCATED = "[TRUNCATED]"
MAX_TEXT = 4000
MAX_ITEMS = 50
MAX_DEPTH = 8
MAX_TOTAL_TEXT = 16000

_SENSITIVE_KEYS = {
    "authorization", "proxyauthorization", "cookie", "cookies", "setcookie",
    "password", "passwd", "pwd", "secret", "clientsecret", "apikey", "accesskey",
    "secretkey", "privatekey", "credential", "credentials", "token", "accesstoken",
    "refreshtoken", "idtoken", "sessiontoken", "databaseurl", "redisurl", "dsn",
    "connectionstring", "email", "phone", "mobile", "idcard", "身份证", "密码", "手机号",
}
_KEY_VALUE = re.compile(
    r"""(?ix)((?<!\w)(?:api[_ -]?key|access[_ -]?key|password|passwd|pwd|secret|
    client[_ -]?secret|authorization|access[_ -]?token|refresh[_ -]?token|token|
    cookie|database[_ -]?url|redis[_ -]?url|dsn|密码)
    ["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}\]]+)"""
)
_URL = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>\"']+")


def safe_connection_label(dsn: str) -> str:
    """Expose only scheme, host and port; paths/query/userinfo may contain secrets."""
    try:
        parsed = urlsplit(dsn)
        host = parsed.hostname
        if not host or not re.fullmatch(r"[a-zA-Z0-9.:\[\]_-]+", host):
            return "[connection]"
        host = f"[{host}]" if ":" in host else host
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{host}{port}"
    except (ValueError, TypeError):
        return "[connection]"


def redact_text(value: str, *, limit: int = MAX_TEXT) -> str:
    # Process past the visible boundary so clipping cannot expose a partial secret.
    text = value[:limit * 2 + 256]
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)",
                  REDACTED, text, flags=re.DOTALL)
    text = _URL.sub(lambda match: safe_connection_label(match[0]), text)
    text = re.sub(r"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", REDACTED, text, flags=re.IGNORECASE)
    text = _KEY_VALUE.sub(lambda match: match[1] + REDACTED, text)
    text = re.sub(r"\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b", REDACTED, text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", REDACTED, text)
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[EMAIL]", text, flags=re.IGNORECASE)
    text = re.sub(r"\b\d{17}[\dXx]\b|\b\d{16,19}\b", "[IDENTIFIER]", text)
    text = re.sub(r"\b1[3-9]\d{9}\b", "[PHONE]", text)
    if len(text) > limit or len(value) > limit * 2 + 256:
        return text[:limit] + TRUNCATED
    return text


def redact_observation(data: object) -> object:
    """Return bounded JSON-compatible data; unknown objects never use repr/str."""
    remaining = MAX_TOTAL_TEXT
    nodes_left = 500
    active: set[int] = set()

    def visit(item: object, depth: int) -> object:
        nonlocal remaining, nodes_left
        nodes_left -= 1
        if depth > MAX_DEPTH or nodes_left < 0 or remaining <= 0:
            return TRUNCATED
        if isinstance(item, str):
            text = redact_text(item, limit=min(MAX_TEXT, remaining))
            remaining -= len(text)
            return text
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, int):
            return item if item.bit_length() <= 256 else TRUNCATED
        if isinstance(item, float):
            return item if math.isfinite(item) else "[NONFINITE]"
        if isinstance(item, (dict, list, tuple)):
            if id(item) in active:
                return "[CIRCULAR]"
            active.add(id(item))
            try:
                if isinstance(item, dict):
                    result = {}
                    for key, child in islice(item.items(), MAX_ITEMS):
                        if not isinstance(key, str):
                            key = "[KEY]"
                        normalized = re.sub(r"[\W_]", "", key).lower()
                        safe_key = str(visit(key, depth + 1))
                        secret = normalized in _SENSITIVE_KEYS or any(
                            normalized.endswith(suffix) for suffix in ("password", "secret", "apikey", "accesstoken")
                        )
                        result[safe_key] = REDACTED if secret else visit(child, depth + 1)
                        if nodes_left < 0 or remaining <= 0:
                            break
                    if len(item) > len(result):
                        result[TRUNCATED] = True
                    return result
                result = []
                for child in islice(item, MAX_ITEMS):
                    result.append(visit(child, depth + 1))
                    if nodes_left < 0 or remaining <= 0:
                        break
                if len(item) > len(result):
                    result.append(TRUNCATED)
                return result
            finally:
                active.remove(id(item))
        return "[UNSUPPORTED]"

    return visit(data, 0)


def install_log_redaction() -> None:
    """Sanitize text and exception chains before any configured handler formats them."""
    previous = logging.getLogRecordFactory()
    if getattr(previous, "_agentforge_redacts", False):
        return

    def factory(*args, **kwargs):
        record = previous(*args, **kwargs)
        if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
            # AccessFormatter reads the five arguments directly, including the numeric status.
            client, method, path, version, status = record.args
            if isinstance(path, str):
                path = path.partition("?")[0]
            record.args = tuple(redact_observation(item) for item in (client, method, path, version, status))
            record.msg = '%s - "%s %s HTTP/%s" %d'
        else:
            record.msg = redact_text(record.getMessage(), limit=MAX_TOTAL_TEXT)
            record.args = ()
        if record.exc_info:
            record.exc_text = redact_text(
                "".join(traceback.format_exception(*record.exc_info)), limit=MAX_TOTAL_TEXT,
            )
            record.exc_info = None
        if record.stack_info:
            record.stack_info = redact_text(record.stack_info, limit=MAX_TOTAL_TEXT)
        return record

    factory._agentforge_redacts = True
    logging.setLogRecordFactory(factory)
