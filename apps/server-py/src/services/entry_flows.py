"""Transactions and audit records for the existing entry flow editor."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.entry_flows.privacy import redact_entry_text, redact_entry_value
from src.agent.entry_flows.runtime import (
    EntryExecution,
    check_cancel,
    execute_entry_flow,
)
from src.agent.entry_flows.schema import (
    EntryDefinition,
    EntryFlowError,
    definition_json,
    parse_draft,
    parse_entry_definition,
    validate_entry_definition,
)
from src.agent.entry_flows.templates import default_entry_template, empty_entry_template
from src.models.entry_flow import EntryRouteFlow, EntryRouteFlowRun

logger = logging.getLogger(__name__)


def timestamp(value: datetime) -> str:
    return value.replace(tzinfo=UTC).isoformat().replace("+00:00", "Z") if value.tzinfo is None else value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def flow_dto(flow: EntryRouteFlow) -> dict:
    return {
        "id": flow.id, "name": flow.name, "draft": flow.draft,
        "draftRevision": flow.draft_revision, "published": flow.published,
        "publishedVersion": flow.published_version, "publishedRevision": flow.published_revision,
        "enabled": flow.enabled, "archived": flow.archived, "updatedBy": flow.updated_by,
        "createdAt": timestamp(flow.created_at), "updatedAt": timestamp(flow.updated_at),
    }


def run_dto(run: EntryRouteFlowRun) -> dict:
    return {
        "id": run.id, "flowId": run.flow_id, "version": run.version,
        "draftRevision": run.draft_revision, "snapshot": redact_entry_value(run.snapshot),
        "actorId": run.actor_id, "conversationId": run.conversation_id,
        "assistantMessageId": run.assistant_message_id, "test": run.test, "status": run.status,
        "inputSummary": redact_entry_text(run.input_summary)[:2000],
        "records": redact_entry_value(run.records), "output": redact_entry_value(run.output),
        "terminalNodeId": run.terminal_node_id,
        "error": redact_entry_text(run.error)[:1000] if run.error else None,
        "durationMs": run.duration_ms, "createdAt": timestamp(run.created_at),
        "updatedAt": timestamp(run.updated_at),
    }


@dataclass(frozen=True)
class PublishedSnapshot:
    flow_id: str
    version: int
    definition: EntryDefinition


@dataclass
class RunExecution:
    run_id: str
    flow_id: str
    version: int
    execution: EntryExecution


class EntryRouteFlowService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list(self) -> dict:
        rows = await self.db.scalars(select(EntryRouteFlow).where(
            EntryRouteFlow.archived.is_(False),
        ).order_by(EntryRouteFlow.updated_at.desc(), EntryRouteFlow.id.desc()))
        return {"items": [flow_dto(row) for row in rows]}

    async def create(self, name: str, actor_id: str, template: str = "default") -> dict:
        flow = EntryRouteFlow(
            id=str(uuid.uuid4()), name=name, updated_by=actor_id,
            draft=default_entry_template() if template == "default" else empty_entry_template(),
        )
        self.db.add(flow)
        await self.db.commit()
        await self.db.refresh(flow)
        return flow_dto(flow)

    async def _flow(self, flow_id: str, *, locked: bool = False, global_lock: bool = False) -> EntryRouteFlow:
        if global_lock and self.db.get_bind().dialect.name == "postgresql":
            await self.db.execute(text("SELECT pg_advisory_xact_lock(hashtext('entry_route_flows_activation'))"))
        stmt = select(EntryRouteFlow).where(EntryRouteFlow.id == flow_id).execution_options(populate_existing=True)
        if locked:
            stmt = stmt.with_for_update()
        flow = await self.db.scalar(stmt)
        if flow is None or (locked and flow.archived):
            raise EntryFlowError("流程不存在或已归档", 404)
        return flow

    async def get(self, flow_id: str) -> dict:
        return flow_dto(await self._flow(flow_id))

    @staticmethod
    def check_revision(flow: EntryRouteFlow, revision: int):
        if flow.draft_revision != revision:
            raise EntryFlowError("草稿已被其他页面修改，请重新加载后再操作", 409)

    async def _change(self, flow: EntryRouteFlow, values: dict, *, revision: int | None = None,
                      version: int | None = None) -> dict:
        conditions = [EntryRouteFlow.id == flow.id, EntryRouteFlow.archived.is_(False)]
        if revision is not None:
            conditions.append(EntryRouteFlow.draft_revision == revision)
        if version is not None:
            conditions.append(EntryRouteFlow.published_version == version)
        changed = await self.db.scalar(update(EntryRouteFlow).where(*conditions)
                                       .values(**values).returning(EntryRouteFlow.id))
        if changed is None:
            raise EntryFlowError("草稿已被其他页面修改，请重新加载后再操作", 409)
        await self.db.commit()
        await self.db.refresh(flow)
        return flow_dto(flow)

    async def save(self, flow_id: str, name: str, revision: int, definition: object, actor_id: str) -> dict:
        parsed = parse_draft(definition)
        flow = await self._flow(flow_id, locked=True)
        self.check_revision(flow, revision)
        return await self._change(flow, {
            "name": name, "draft": definition_json(parsed), "draft_revision": revision + 1,
            "updated_by": actor_id,
        }, revision=revision)

    async def validate(self, flow_id: str, revision: int) -> dict:
        flow = await self._flow(flow_id)
        if flow.archived:
            raise EntryFlowError("流程已归档", 404)
        self.check_revision(flow, revision)
        return validate_entry_definition(flow.draft)

    async def publish(self, flow_id: str, revision: int, actor_id: str) -> dict:
        flow = await self._flow(flow_id, locked=True)
        self.check_revision(flow, revision)
        parsed = parse_entry_definition(flow.draft)
        return await self._change(flow, {
            "published": definition_json(parsed), "published_version": flow.published_version + 1,
            "published_revision": revision, "updated_by": actor_id,
        }, revision=revision, version=flow.published_version)

    async def activate(self, flow_id: str, enabled: bool, actor_id: str) -> dict:
        flow = await self._flow(flow_id, locked=True, global_lock=True)
        if enabled:
            if flow.published is None or not flow.published_version:
                raise EntryFlowError("请先发布流程", 400)
            parse_entry_definition(flow.published)
            await self.db.execute(update(EntryRouteFlow).where(
                EntryRouteFlow.enabled.is_(True), EntryRouteFlow.id != flow_id,
            ).values(enabled=False, updated_by=actor_id))
        return await self._change(flow, {"enabled": enabled, "updated_by": actor_id})

    async def archive(self, flow_id: str, actor_id: str) -> dict:
        flow = await self._flow(flow_id, locked=True, global_lock=True)
        await self._change(flow, {"archived": True, "enabled": False, "updated_by": actor_id})
        return {"ok": True}

    async def active_snapshot(self) -> PublishedSnapshot | None:
        try:
            flow = (await self.db.scalars(select(EntryRouteFlow).where(
                EntryRouteFlow.enabled.is_(True),
            ).execution_options(populate_existing=True))).one_or_none()
            if flow is None:
                return None
            if flow.archived or flow.published is None or flow.published_version < 1:
                raise ValueError("Invalid active entry flow")
            return PublishedSnapshot(flow.id, flow.published_version, parse_entry_definition(flow.published))
        except Exception as exc:
            logger.warning("Entry flow configuration unavailable", exc_info=True)
            raise EntryFlowError("一级路由流程加载失败，请联系管理员检查配置或停用流程", 503) from exc

    async def execute(self, snapshot: PublishedSnapshot, message: str, actor_id: str, *,
                      cancel: asyncio.Event | None = None, draft_revision: int | None = None,
                      conversation_id: str | None = None) -> RunExecution:
        started = time.monotonic()
        run_id = str(uuid.uuid4())
        run = EntryRouteFlowRun(
            id=run_id, flow_id=snapshot.flow_id, version=snapshot.version, draft_revision=draft_revision,
            snapshot=redact_entry_value(definition_json(snapshot.definition)),
            actor_id=actor_id, conversation_id=conversation_id, test=draft_revision is not None,
            input_summary=redact_entry_text(message)[:2000],
        )
        try:
            self.db.add(run)
            await self.db.commit()
        except Exception as exc:
            await self.db.rollback()
            raise EntryFlowError("一级路由运行记录创建失败，请联系管理员", 503) from exc
        try:
            execution = execute_entry_flow(snapshot.definition, message, cancel)
            check_cancel(cancel)
            await self.db.execute(update(EntryRouteFlowRun).where(EntryRouteFlowRun.id == run_id).values(
                status="completed", records=redact_entry_value(execution.records),
                output=redact_entry_value(execution.result), terminal_node_id=execution.terminal_node_id,
                duration_ms=int((time.monotonic() - started) * 1000),
            ))
            await self.db.commit()
            return RunExecution(run_id, snapshot.flow_id, snapshot.version, execution)
        except (Exception, asyncio.CancelledError) as exc:
            await self.db.rollback()
            cancelled = isinstance(exc, asyncio.CancelledError) or (cancel is not None and cancel.is_set())
            try:
                await self.db.execute(update(EntryRouteFlowRun).where(EntryRouteFlowRun.id == run_id).values(
                    status="cancelled" if cancelled else "failed",
                    error=redact_entry_text(str(exc) or "执行失败")[:1000],
                    duration_ms=int((time.monotonic() - started) * 1000),
                ))
                await self.db.commit()
            except Exception:
                await self.db.rollback()
                logger.exception("Failed to persist entry flow failure run_id=%s", run_id)
            if cancelled:
                raise asyncio.CancelledError() from exc
            if isinstance(exc, EntryFlowError):
                raise
            raise EntryFlowError("一级路由决策或记录保存失败，请联系管理员", 503) from exc

    async def test_run(self, flow_id: str, revision: int, message: str, actor_id: str) -> dict:
        flow = await self._flow(flow_id)
        if flow.archived:
            raise EntryFlowError("流程已归档", 404)
        self.check_revision(flow, revision)
        snapshot = PublishedSnapshot(flow.id, flow.published_version, parse_entry_definition(flow.draft))
        execution = await self.execute(snapshot, message, actor_id, draft_revision=revision)
        return await self.get_run(flow_id, execution.run_id)

    async def link_assistant(self, run_id: str, assistant_message_id: str):
        await self.db.execute(update(EntryRouteFlowRun).where(EntryRouteFlowRun.id == run_id)
                              .values(assistant_message_id=assistant_message_id))
        await self.db.commit()

    async def runs(self, flow_id: str, page: int = 1, page_size: int = 20) -> dict:
        await self._flow(flow_id)
        rows = await self.db.scalars(select(EntryRouteFlowRun).where(EntryRouteFlowRun.flow_id == flow_id)
                                     .order_by(EntryRouteFlowRun.created_at.desc(), EntryRouteFlowRun.id.desc())
                                     .offset((page - 1) * page_size).limit(page_size))
        total = await self.db.scalar(select(func.count()).select_from(EntryRouteFlowRun)
                                     .where(EntryRouteFlowRun.flow_id == flow_id))
        return {"items": [run_dto(row) for row in rows], "total": total, "page": page, "pageSize": page_size}

    async def get_run(self, flow_id: str, run_id: str) -> dict:
        run = await self.db.scalar(select(EntryRouteFlowRun).where(
            EntryRouteFlowRun.id == run_id, EntryRouteFlowRun.flow_id == flow_id,
        ).execution_options(populate_existing=True))
        if run is None:
            raise EntryFlowError("运行记录不存在", 404)
        return run_dto(run)
