"""Synthetic credentials must stay out of logs and tracing, without changing tool inputs."""

import copy
import json
import logging
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from uvicorn.logging import AccessFormatter

from src.agent import checkpoint
from src.config import settings
from src.observability.langfuse_provider import LangfuseProvider
from src.observability.privacy import (
    MAX_TEXT,
    install_log_redaction,
    redact_observation,
    safe_connection_label,
)

PASSWORD = "synthetic-password-value"
EMAIL = "private-person@example.test"
PHONE = "13812345678"
API_KEY = "sk-proj-syntheticKey1234567890"
DSN = f"postgresql://service:{PASSWORD}@database.example.test:5432/private?token=hidden"


def test_recursive_redaction_keeps_inputs_and_operational_numbers():
    raw = {
        "Authorization": "Bearer syntheticBearer123",
        "nested": [{"apiKey": API_KEY, "request": f"phone={PHONE} email={EMAIL} password='{PASSWORD}'"}],
        "url": DSN, "counts": {"input_tokens": 17, "output_tokens": 4},
    }
    before = copy.deepcopy(raw)
    safe = redact_observation(raw)
    serialized = json.dumps(safe)
    for secret in (PASSWORD, EMAIL, PHONE, API_KEY, "syntheticBearer123", "private?", "hidden"):
        assert secret not in serialized
    assert raw == before
    assert safe["counts"] == {"input_tokens": 17, "output_tokens": 4}
    assert "database.example.test:5432" in serialized


def test_redaction_is_bounded_and_never_serializes_unknown_objects():
    class PrivateObject:
        def __str__(self):
            raise AssertionError("must not stringify unknown business objects")

        __repr__ = __str__

    cycle = []
    cycle.append(cycle)
    tree = {"cycle": cycle, "object": PrivateObject(), "large": ["x" * 100000] * 1000}
    safe = redact_observation(tree)
    assert "[CIRCULAR]" in json.dumps(safe)
    assert safe["object"] == "[UNSUPPORTED]"
    assert len(json.dumps(safe)) < 30000
    assert len(redact_observation("x" * 1000000)) <= MAX_TEXT + 20
    assert redact_observation(10 ** 10000) == "[TRUNCATED]"


@pytest.mark.parametrize("dsn", [DSN, "postgresql+asyncpg://user:pass@[::1]:5432/db?password=hidden",
                                "postgresql://[invalid", "host=db password=secret"])
def test_connection_labels_omit_credentials_database_and_query(dsn):
    label = safe_connection_label(dsn)
    assert "@" not in label and "?" not in label
    assert "password" not in label and "secret" not in label and "private" not in label


def test_log_redaction_covers_formatted_args_and_exception_chains(caplog):
    previous = logging.getLogRecordFactory()
    try:
        install_log_redaction()
        installed = logging.getLogRecordFactory()
        install_log_redaction()
        assert logging.getLogRecordFactory() is installed
        with caplog.at_level(logging.INFO):
            logging.getLogger("test.privacy").info("endpoint=%s request=%s", DSN, {"api_key": API_KEY})
            try:
                try:
                    raise ValueError(f"password={PASSWORD}")
                except ValueError as exc:
                    raise RuntimeError(f"user={EMAIL} phone={PHONE}") from exc
            except RuntimeError:
                logging.getLogger("test.privacy").exception("Model failure")
        for secret in (PASSWORD, EMAIL, PHONE, API_KEY):
            assert secret not in caplog.text
        assert "RuntimeError" in caplog.text and "ValueError" in caplog.text
    finally:
        logging.setLogRecordFactory(previous)


@pytest.mark.parametrize("use_colors", [False, True])
def test_uvicorn_access_formatter_retains_arguments_and_redacts_requests(use_colors):
    previous = logging.getLogRecordFactory()
    request_args = ("127.0.0.1:1234", "GET", f"/users/{EMAIL}?token={PASSWORD}&other=encoded%40secret", "1.1", 200)
    try:
        install_log_redaction()
        record = logging.getLogger("uvicorn.access").makeRecord(
            "uvicorn.access", logging.INFO, __file__, 0,
            '%s - "%s %s HTTP/%s" %d', request_args, None,
        )
        formatted = AccessFormatter(
            fmt='%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
            use_colors=use_colors,
        ).format(record)
        for secret in (PASSWORD, EMAIL, "encoded%40secret"):
            assert secret not in formatted
            assert secret not in record.getMessage()
        assert "GET /users/[EMAIL] HTTP/1.1" in formatted
        assert "200 OK" in formatted
        assert record.args[-1] == 200
        assert PASSWORD in request_args[2]
    finally:
        logging.setLogRecordFactory(previous)


class StrictObservation:
    def __init__(self):
        self.updates = []
        self.ends = 0
        self.trace_id = "trace"

    def update(self, **kwargs):
        self.updates.append(kwargs)

    def end(self):
        self.ends += 1


def observation_provider():
    provider = LangfuseProvider()
    provider._client = MagicMock()
    observation = StrictObservation()
    provider._client.start_observation.return_value = observation
    return provider, observation


@pytest.mark.parametrize("kind", ["generation", "tool"])
def test_span_all_create_and_update_fields_are_sanitized_and_usage_is_recorded(kind):
    provider, observation = observation_provider()
    create = provider.create_generation if kind == "generation" else provider.create_tool_span
    raw = {"password": PASSWORD, "message": EMAIL}
    span = create("call", input=raw, output=raw, metadata=raw)
    span.end(output=raw, usage={"prompt_tokens": 17, "completion_tokens": 4}, metadata=raw)
    span.end(output="ignored")
    captured = str(provider._client.start_observation.call_args) + json.dumps(observation.updates)
    assert PASSWORD not in captured and EMAIL not in captured
    assert observation.updates[0]["usage_details"] == {"input": 17, "output": 4, "total": 21}
    assert observation.ends == 1
    assert raw["password"] == PASSWORD


def test_trace_enters_once_and_does_not_pass_raw_exception_to_sdk():
    provider, observation = observation_provider()
    transitions = []

    @contextmanager
    def context():
        transitions.append("enter")
        try:
            yield observation
        except Exception as exc:
            transitions.append(str(exc))
            raise
        finally:
            transitions.append("exit")

    provider._client.start_as_current_observation.return_value = context()
    trace = provider.create_trace("trace", input=EMAIL, metadata={"password": PASSWORD})
    assert transitions == []
    with pytest.raises(RuntimeError, match=PASSWORD), trace:
        assert trace.trace_id == "trace"
        raise RuntimeError(PASSWORD)
    assert transitions == ["enter", "exit"]
    assert observation.updates == [{"level": "ERROR", "status_message": "Application execution failed"}]
    assert PASSWORD not in str(provider._client.start_as_current_observation.call_args)


async def test_trace_manual_end_releases_context_once():
    provider, observation = observation_provider()
    context = MagicMock()
    context.__enter__.return_value = observation
    provider._client.start_as_current_observation.return_value = context
    async with provider.create_trace("trace") as trace:
        trace.end(output=EMAIL, metadata={"token": PASSWORD})
    context.__enter__.assert_called_once()
    context.__exit__.assert_called_once_with(None, None, None)
    assert EMAIL not in json.dumps(observation.updates)
    assert PASSWORD not in json.dumps(observation.updates)


def test_sdk_mask_callback_accepts_keyword_data(monkeypatch):
    factory = MagicMock()
    monkeypatch.setattr("langfuse.Langfuse", factory)
    monkeypatch.setattr(settings, "langfuse_enabled", True)
    monkeypatch.setattr(settings, "langfuse_public_key", "public-test")
    monkeypatch.setattr(settings, "langfuse_secret_key", "private-test")
    LangfuseProvider()
    mask = factory.call_args.kwargs["mask"]
    assert mask(data={"password": PASSWORD}) == {"password": "[REDACTED]"}


def test_sdk_update_failure_still_ends_span_without_leaking_exception(caplog):
    provider, observation = observation_provider()
    observation.update = MagicMock(side_effect=RuntimeError(PASSWORD))
    with caplog.at_level(logging.DEBUG):
        provider.create_generation("test").end(output="test")
    assert observation.ends == 1
    assert PASSWORD not in caplog.text


async def test_checkpoint_logging_keeps_real_connection_argument_private(monkeypatch, caplog):
    monkeypatch.setattr(settings, "database_url", DSN)
    monkeypatch.setattr(checkpoint, "_pool", None)
    monkeypatch.setattr(checkpoint, "_saver", None)
    pool = MagicMock(return_value=MagicMock(open=AsyncMock()))
    saver = MagicMock(return_value=MagicMock(setup=AsyncMock()))
    monkeypatch.setattr(checkpoint, "AsyncConnectionPool", pool)
    monkeypatch.setattr(checkpoint, "AsyncPostgresSaver", saver)
    with caplog.at_level(logging.INFO):
        await checkpoint.get_checkpointer(required=True)
    assert pool.call_args.args[0] == DSN
    assert PASSWORD not in caplog.text and "database.example.test:5432" in caplog.text
