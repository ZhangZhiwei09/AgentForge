"""DSL v1 shared with the existing entry flow editor."""

import re
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]


def text(maximum: int):
    return Annotated[str, StringConstraints(max_length=maximum, pattern=r"\S")]


class EntryFlowError(Exception):
    def __init__(self, message: str, status: int, errors: list[dict] | None = None):
        super().__init__(message)
        self.status = status
        self.errors = errors or []


class EntryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Position(EntryModel):
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)


class Condition(EntryModel):
    operator: Literal["contains_any", "contains_all", "equals_any"]
    words: list[text(128)] = Field(min_length=1, max_length=50)
    excludeAny: list[text(128)] = Field(max_length=50)
    ignoreCase: bool
    stripTrailingPunctuation: bool


class Handoff(EntryModel):
    withinHours: text(8000)
    outsideHours: text(8000)
    suggestions: list[text(200)] = Field(max_length=5)


class Node(EntryModel):
    id: Identifier
    name: text(200)
    position: Position


class StartNode(Node):
    type: Literal["start"]


class ConditionNode(Node):
    type: Literal["condition"]
    condition: Condition


class ReplyNode(Node):
    type: Literal["reply"]
    answer: text(8000)
    suggestions: list[text(200)] = Field(max_length=5)


class RouteNode(Node):
    type: Literal["route"]
    target: Literal["CHAT", "TASK", "HUMAN", "DIAGNOSIS"]
    handoff: Handoff | None = None

    @field_validator("handoff", mode="before")
    @classmethod
    def nonnull_handoff(cls, value):
        if value is None:
            raise ValueError("转接配置不能为 null")
        return value


class ContinueNode(Node):
    type: Literal["continue"]


class Edge(EntryModel):
    id: Identifier
    source: Identifier
    target: Identifier
    branch: Literal["true", "false"] | None


class EntryDefinition(EntryModel):
    schemaVersion: Literal[1]
    nodes: list[Annotated[StartNode | ConditionNode | ReplyNode | RouteNode | ContinueNode, Field(discriminator="type")]] = Field(min_length=1, max_length=30)
    edges: list[Edge] = Field(max_length=60)

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def numeric_version(cls, value):
        if isinstance(value, bool):
            raise ValueError("版本必须为数字")  # noqa: TRY004 - Pydantic validators require ValueError.
        return value


def definition_json(definition: EntryDefinition) -> dict:
    return definition.model_dump(mode="json", exclude_none=True) | {
        "edges": [edge.model_dump(mode="json") for edge in definition.edges],
    }


def normalize_entry_text(value: str, condition: Condition) -> str:
    value = value.strip()
    if condition.ignoreCase:
        value = value.lower()
    if condition.stripTrailingPunctuation:
        value = re.sub(r"[\s!！。.,，]+$", "", value)
    return value


def structural_errors(error: ValidationError, value: object = None) -> list[dict]:
    errors = []
    for issue in error.errors(include_url=False, include_input=False):
        # Discriminated unions insert a type label into Pydantic paths.
        loc = list(issue["loc"])
        if len(loc) > 2 and loc[0] == "nodes" and isinstance(loc[1], int) and loc[2] in ("start", "condition", "reply", "route", "continue"):
            del loc[2]
        item = {"path": ".".join(str(part) for part in loc), "message": issue["msg"]}
        if len(loc) > 1 and loc[0] == "nodes" and isinstance(loc[1], int) and isinstance(value, dict):
            nodes = value.get("nodes")
            if isinstance(nodes, list) and loc[1] < len(nodes) and isinstance(nodes[loc[1]], dict):
                node_id = nodes[loc[1]].get("id")
                if isinstance(node_id, str):
                    item["nodeId"] = node_id
        errors.append(item)
    return errors


def parse_draft(value: object) -> EntryDefinition:
    try:
        return EntryDefinition.model_validate(value)
    except ValidationError as exc:
        raise EntryFlowError("草稿字段校验失败", 400, structural_errors(exc, value)) from exc


def validate_entry_definition(value: object) -> dict:
    try:
        definition = EntryDefinition.model_validate(value)
    except ValidationError as exc:
        return {"valid": False, "errors": structural_errors(exc, value)}
    errors: list[dict] = []

    def add(path: str, message: str, node_id: str | None = None):
        errors.append({"path": path, "message": message, **({"nodeId": node_id} if node_id else {})})

    nodes = {node.id: node for node in definition.nodes}
    if len(nodes) != len(definition.nodes):
        add("nodes", "节点 ID 重复")
    starts = [node for node in definition.nodes if node.type == "start"]
    if len(starts) != 1:
        add("nodes", "必须有且仅有一个开始节点")
    edge_ids: set[str] = set()
    for index, edge in enumerate(definition.edges):
        if edge.id in edge_ids:
            add(f"edges.{index}.id", "连线 ID 重复")
        edge_ids.add(edge.id)
        if edge.source not in nodes or edge.target not in nodes:
            add(f"edges.{index}", "连线引用了不存在的节点")
        if edge.source == edge.target:
            add(f"edges.{index}", "不能连接到自身", edge.source)
    for index, node in enumerate(definition.nodes):
        outgoing = [edge for edge in definition.edges if edge.source == node.id]
        incoming = [edge for edge in definition.edges if edge.target == node.id]
        path = f"nodes.{index}"
        if isinstance(node, StartNode):
            if incoming or len(outgoing) != 1 or outgoing[0].branch is not None:
                add(path, "开始节点无入边且必须有一个普通出口", node.id)
        elif isinstance(node, ConditionNode):
            if len(outgoing) != 2 or sorted(edge.branch or "" for edge in outgoing) != ["false", "true"]:
                add(path, "条件节点必须各有一个 true 和 false 出口", node.id)
            config = node.condition
            if config.stripTrailingPunctuation and config.operator != "equals_any":
                add(f"{path}.condition", "末尾标点规范化仅支持精确匹配", node.id)
            words = [normalize_entry_text(word, config) for word in config.words]
            excluded = [normalize_entry_text(word, config) for word in config.excludeAny]
            if not all(words + excluded):
                add(f"{path}.condition", "规范化后的关键词不能为空", node.id)
            if len(set(words)) != len(words) or len(set(excluded)) != len(excluded):
                add(f"{path}.condition", "规范化后的关键词不能重复", node.id)
            if set(words).intersection(excluded):
                add(f"{path}.condition", "匹配词与排除词不能相同", node.id)
        elif outgoing:
            add(path, "结束节点不能有出口", node.id)
        if isinstance(node, RouteNode) and node.handoff is not None and node.target != "HUMAN":
            add(f"{path}.handoff", "仅 HUMAN 可以配置转接话术", node.id)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str):
        if node_id in visiting:
            add("edges", "流程不能包含循环", node_id)
            return
        if node_id in visited or node_id not in nodes:
            return
        visiting.add(node_id)
        for edge in definition.edges:
            if edge.source == node_id:
                visit(edge.target)
        visiting.remove(node_id)
        visited.add(node_id)

    if len(starts) == 1:
        visit(starts[0].id)
    for node in definition.nodes:
        if node.id not in visited:
            add("nodes", "节点不可从开始到达", node.id)
    if not any(node.type == "continue" and node.id in visited for node in definition.nodes):
        add("nodes", "必须有可达的 continue 兜底节点")
    return {"valid": not errors, "errors": errors}


def parse_entry_definition(value: object) -> EntryDefinition:
    validation = validate_entry_definition(value)
    if not validation["valid"]:
        raise EntryFlowError("一级流程校验失败", 400, validation["errors"])
    return EntryDefinition.model_validate(value)
