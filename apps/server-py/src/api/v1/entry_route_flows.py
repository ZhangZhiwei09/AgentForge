"""Compatible admin endpoints, including controlled validation errors."""

import json
import logging
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import Field, StringConstraints, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent.entry_flows.schema import (
    EntryFlowError,
    EntryModel,
    structural_errors,
    text,
)
from src.api.deps import get_current_user, get_db
from src.models.user import User
from src.services.entry_flows import EntryRouteFlowService

logger = logging.getLogger(__name__)


class EntryAPIRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def compatible_errors(request: Request):
            try:
                response = await handler(request)
            except EntryFlowError as exc:
                response = JSONResponse(status_code=exc.status, content={
                    "detail": {"message": str(exc), "errors": exc.errors},
                })
            except HTTPException as exc:
                response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            except Exception:
                logger.exception("Entry flow API failed path=%s", request.url.path)
                response = JSONResponse(status_code=503, content={"detail": "一级流程服务暂不可用，请检查数据库与配置"})
            response.headers["Cache-Control"] = "no-store"
            return response

        return compatible_errors


router = APIRouter(prefix="/api/entry-route-flows", tags=["entry-route-flows"], route_class=EntryAPIRoute)
DB = Annotated[AsyncSession, Depends(get_db)]


async def admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可以管理一级路由流程")
    return user


Admin = Annotated[User, Depends(admin)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class CreateRequest(EntryModel):
    name: Name
    template: Literal["default", "empty"] = "default"


class RevisionRequest(EntryModel):
    revision: int = Field(gt=0)


class SaveRequest(RevisionRequest):
    name: Name
    definition: object


class ActivationRequest(EntryModel):
    enabled: bool


class TestRequest(RevisionRequest):
    message: text(16000)


async def body(request: Request, schema: type[EntryModel]):
    raw = await request.body()
    if len(raw.decode("utf-8", errors="replace")) > 300000:
        raise EntryFlowError("请求内容超过上限", 400)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise EntryFlowError("请求必须是有效 JSON", 400) from exc
    try:
        return schema.model_validate(value)
    except ValidationError as exc:
        raise EntryFlowError("请求格式错误", 400, structural_errors(exc)) from exc


def checked_id(value: str) -> str:
    try:
        UUID(value)
        if len(value) != 36:
            raise ValueError()
    except ValueError as exc:
        raise EntryFlowError("请求格式错误", 400) from exc
    return value


@router.get("")
async def list_flows(user: Admin, db: DB):
    return await EntryRouteFlowService(db).list()


@router.post("", status_code=201)
async def create(request: Request, user: Admin, db: DB):
    value = await body(request, CreateRequest)
    return await EntryRouteFlowService(db).create(value.name, user.id, value.template)


@router.get("/{flow_id}")
async def detail(flow_id: str, user: Admin, db: DB):
    return await EntryRouteFlowService(db).get(checked_id(flow_id))


@router.put("/{flow_id}/draft")
async def save(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    value = await body(request, SaveRequest)
    return await EntryRouteFlowService(db).save(flow_id, value.name, value.revision, value.definition, user.id)


@router.post("/{flow_id}/validate")
async def validate(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    value = await body(request, RevisionRequest)
    return await EntryRouteFlowService(db).validate(flow_id, value.revision)


@router.post("/{flow_id}/publish")
async def publish(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    value = await body(request, RevisionRequest)
    return await EntryRouteFlowService(db).publish(flow_id, value.revision, user.id)


@router.put("/{flow_id}/activation")
async def activate(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    value = await body(request, ActivationRequest)
    return await EntryRouteFlowService(db).activate(flow_id, value.enabled, user.id)


@router.delete("/{flow_id}")
async def archive(flow_id: str, user: Admin, db: DB):
    return await EntryRouteFlowService(db).archive(checked_id(flow_id), user.id)


@router.post("/{flow_id}/test-run")
async def test_run(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    value = await body(request, TestRequest)
    return await EntryRouteFlowService(db).test_run(flow_id, value.revision, value.message, user.id)


@router.get("/{flow_id}/runs")
async def runs(flow_id: str, request: Request, user: Admin, db: DB):
    checked_id(flow_id)
    query = dict(request.query_params)
    if set(query) - {"page", "pageSize"}:
        raise EntryFlowError("请求格式错误", 400)
    try:
        page = int(query.get("page", "1"))
        page_size = int(query.get("pageSize", "20"))
        if not 1 <= page <= 100000 or not 1 <= page_size <= 50:
            raise ValueError()
    except ValueError as exc:
        raise EntryFlowError("请求格式错误", 400) from exc
    return await EntryRouteFlowService(db).runs(flow_id, page, page_size)


@router.get("/{flow_id}/runs/{run_id}")
async def run_detail(flow_id: str, run_id: str, user: Admin, db: DB):
    return await EntryRouteFlowService(db).get_run(checked_id(flow_id), checked_id(run_id))
