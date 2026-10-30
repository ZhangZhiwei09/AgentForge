"""Execution authority cannot be widened by callers, resumes or tool wrappers."""

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from src.agent.task_guard import TaskGuardConfig
from src.agent.tools.registry import ToolRegistry
from src.config import Settings, settings
from src.models.agent_session import AgentSession
from src.services import agent_tasks
from src.services.execution_policy import (
    DISABLED_TOOLS,
    ToolExecutionContext,
    build_execution_policy,
)
from tests.test_agent_tasks_api import (
    USER,
    answer,
    decision,
    events,
    pause_for_approval,
    run,
    task_api,
    tool_call,
)

__all__ = ["task_api"]


def context(*, tools=None, conversation_id="conv"):
    return ToolExecutionContext(
        actor_id="test-user", conversation_id=conversation_id, run_id="test-run",
        policy=build_execution_policy(requested_tools=tools),
    )


def test_client_cannot_relax_platform_policy(monkeypatch):
    monkeypatch.setattr(settings, "agent_max_tokens", 3000)
    monkeypatch.setattr(settings, "agent_max_cost_cents", 5)
    monkeypatch.setattr(settings, "agent_max_iterations", 3)
    effective = build_execution_policy(
        TaskGuardConfig(max_tokens=10**9, max_cost_cents=10**9,
                        pii_detection_enabled=False, content_safety_enabled=False),
        ["calculator", "db_query"], 20,
    )
    assert effective.tools == ("calculator",)
    assert (effective.max_tokens, effective.max_cost_cents, effective.max_iterations) == (3000, 5, 3)
    assert effective.guard_config().pii_detection_enabled
    assert effective.guard_config().content_safety_enabled
    assert build_execution_policy(requested_tools=[]).tools == ()


@pytest.mark.parametrize("value", [float("inf"), float("nan")])
def test_nonfinite_budgets_rejected(value):
    with pytest.raises(ValidationError):
        TaskGuardConfig(max_cost_cents=value)


async def test_registry_requires_identity_and_preserves_restrictions(monkeypatch):
    registry = ToolRegistry()
    execute = AsyncMock(return_value={"status": "success", "output": "one"})
    registry.register(replace(registry.get("calculator"), execute=execute))
    assert (await registry.execute("calculator", {}, "conv"))["status"] == "failed"
    assert (await registry.get("calculator").execute({}, "conv"))["status"] == "failed"
    bound = registry.bind(context(tools=["calculator"]))
    assert (await bound.execute("calculator", {}, "foreign"))["status"] == "failed"
    assert (await bound.get("calculator").execute({}, "conv"))["status"] == "success"
    narrowed = bound.filter([]).bind(context())
    narrowed.register(replace(registry.get("calculator"), execute=execute))
    assert not narrowed.list_names()
    assert (await narrowed.execute("calculator", {}, "conv"))["status"] == "failed"
    monkeypatch.setattr(settings, "agent_allowed_tools", [])
    assert (await bound.execute("calculator", {}, "conv"))["status"] == "failed"
    execute.assert_awaited_once()
    with pytest.raises(ValueError, match="different principal"):
        bound.bind(replace(context(), actor_id="other"))


@pytest.mark.parametrize("name", sorted(DISABLED_TOOLS))
async def test_disabled_tools_cannot_be_reenabled_or_called_directly(name, monkeypatch):
    monkeypatch.setattr(settings, "agent_allowed_tools", [name])
    registry = ToolRegistry().bind(context())
    execute = AsyncMock(return_value={"status": "success"})
    registry.register(replace(registry.get(name), execute=execute))
    assert name not in registry.list_names()
    assert (await registry.execute(name, {}, "conv"))["status"] == "failed"
    assert (await registry.get(name).execute({}, "conv"))["status"] == "failed"
    execute.assert_not_awaited()


async def test_empty_tools_and_forced_filters_survive_http(task_api):
    client, sessions, provider, execute = task_api
    provider.responses.extend([[tool_call("read_file")], answer("手机号 13812345678")])
    stream = await run(client, tools=[], guard_config={
        "max_tokens": 10**9, "max_cost_cents": 10**9,
        "pii_detection_enabled": False, "content_safety_enabled": False,
    })
    assert stream[0]["tools_enabled"] == []
    assert stream[0]["guard_config"]["max_tokens"] == settings.agent_max_tokens
    assert "13812345678" not in str(stream)
    execute.assert_not_awaited()
    async with sessions() as db:
        saved = await db.scalar(select(AgentSession))
        assert saved.runtime_state["tools"] == []
        assert saved.runtime_state["guard"]["content_safety_enabled"]


async def test_approval_resume_rechecks_revoked_tool(task_api, monkeypatch):
    client, sessions, provider, execute = task_api
    approval = await pause_for_approval(client, provider)
    monkeypatch.setattr(settings, "agent_allowed_tools", ["read_file"])
    provider.responses.append(answer("当前权限不允许执行"))
    stream = events(await client.post("/api/agent/approve", headers=USER, json={
        "session_id": approval["session_id"], "approval_id": approval["approval_id"],
        "action": "approve",
    }))
    assert "write_file" not in stream[0]["tools_enabled"]
    execute.assert_not_awaited()
    async with sessions() as db:
        saved = await db.get(AgentSession, approval["session_id"])
        assert saved.runtime_state["tokens_used"] > 0
        assert "write_file" not in saved.runtime_state["tools"]


async def test_mutation_risk_requires_approval_without_boolean_flag(task_api):
    client, _, provider, execute = task_api
    registry = agent_tasks.tool_registry
    registry.register(replace(registry.get("write_file"), require_approval=False, execute=execute))
    approval = await pause_for_approval(client, provider)
    assert approval["tool_name"] == "write_file"
    execute.assert_not_awaited()


async def test_resume_never_relaxes_saved_limits(task_api, monkeypatch):
    client, sessions, provider, _ = task_api
    provider.responses.append([decision("ask_user", question="哪个请求？")])
    first = await run(client, tools=[], guard_config={"max_tokens": 20000}, max_iterations=4)
    monkeypatch.setattr(settings, "agent_max_tokens", 100000)
    provider.responses.append(answer())
    resumed = events(await client.post("/api/agent/respond", headers=USER, json={
        "session_id": first[0]["session_id"], "response": "trace",
    }))
    assert resumed[0]["tools_enabled"] == []
    assert resumed[0]["guard_config"]["max_tokens"] == 20000
    assert resumed[0]["max_iterations"] == 4
    async with sessions() as db:
        saved = await db.get(AgentSession, first[0]["session_id"])
        assert saved.runtime_state["tokens_used"] >= 240


def test_monitoring_disabled_by_default_and_forbidden_in_production(monkeypatch):
    monkeypatch.delenv("MONITORING_MODE", raising=False)
    assert Settings(_env_file=None).monitoring_mode == "disabled"
    with pytest.raises(ValidationError, match="forbids mock"):
        Settings(_env_file=None, app_env="production", jwt_secret="test-secret", monitoring_mode="mock")
