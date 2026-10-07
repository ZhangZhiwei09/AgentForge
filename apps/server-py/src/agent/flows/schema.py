"""Small flow DSL and publish-time validation.

Edges describe control flow; explicit input references describe data flow.
Only mutually exclusive branches are supported. Diagnosis policies are not
editable code, and every escalated path must retain backend and synthesis.
"""

from collections import defaultdict
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from pydantic.alias_generators import to_camel


class FlowModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True, allow_inf_nan=False,
    )


class ValueRef(FlowModel):
    source: Literal["task", "node"]
    node_id: str | None = None
    path: list[str] = Field(default_factory=list, max_length=8)


class OutputField(FlowModel):
    name: str = Field(pattern=r"^[a-zA-Z_][a-zA-Z0-9_]*$", max_length=60)
    type: Literal["string", "number", "boolean", "object", "array"]
    required: bool = True


class RoleConfig(FlowModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    system_prompt: str = Field(default="", max_length=12000)


class ExecutionConfig(FlowModel):
    tools: list[str] = Field(default_factory=list, max_length=20)
    max_iterations: int = Field(default=5, ge=1, le=10)
    timeout_ms: int = Field(default=60000, ge=1000, le=180000)


class ConditionConfig(FlowModel):
    reference: ValueRef
    operator: Literal["eq", "ne"] = "eq"
    value: str | int | float | bool | None = None


class Position(FlowModel):
    x: float = 0
    y: float = 0


class FlowNode(FlowModel):
    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]*$", max_length=64)
    type: Literal["start", "agent", "condition", "end"]
    name: str = Field(min_length=1, max_length=100)
    position: Position = Field(default_factory=Position)
    role: RoleConfig | None = None
    task: str = Field(default="", max_length=12000)
    inputs: dict[str, ValueRef] = Field(default_factory=dict, max_length=20)
    outputs: list[OutputField] = Field(default_factory=list, max_length=20)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    condition: ConditionConfig | None = None


class FlowEdge(FlowModel):
    id: str = Field(min_length=1, max_length=100)
    source: str
    target: str
    branch: Literal["true", "false"] | None = None


class DiagnosisBindings(FlowModel):
    frontend: str
    backend: str
    leader: str


class FlowLimits(FlowModel):
    timeout_ms: int = Field(default=180000, ge=1000, le=180000)
    max_total_iterations: int = Field(default=50, ge=1, le=100)


class FlowDefinition(FlowModel):
    schema_version: Literal[1] = 1
    nodes: list[FlowNode] = Field(max_length=24)
    edges: list[FlowEdge] = Field(max_length=40)
    diagnosis_bindings: DiagnosisBindings
    output_adapter: Literal["diagnosis_v1"] = "diagnosis_v1"
    limits: FlowLimits = Field(default_factory=FlowLimits)


CONTRACTS: dict[str, dict[str, str]] = {
    "frontend": {
        "conclusion": "string", "evidence": "array", "need_escalation": "boolean",
        "escalation_reason": "string", "context_for_backend": "object",
    },
    "backend": {"conclusion": "string", "evidence": "array"},
    "leader": {
        "frontend_score": "number", "backend_score": "number", "frontend_breakdown": "object",
        "backend_breakdown": "object", "reasoning": "string", "synthesis": "string",
        "missing_fields": "array", "message": "string",
    },
}


def matches_type(value: JsonValue, kind: str) -> bool:
    return {
        "string": isinstance(value, str),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
    }.get(kind, False)


def validate_definition(definition: FlowDefinition, allowed_tools: set[str]) -> list[dict[str, str]]:
    """Validate bounded topology, path-safe references and mandatory policies."""
    errors: list[dict[str, str]] = []

    def fail(path: str, message: str):
        errors.append({"path": path, "message": message})

    nodes = {node.id: node for node in definition.nodes}
    if len(nodes) != len(definition.nodes):
        fail("nodes", "节点 ID 必须唯一")
    if len({edge.id for edge in definition.edges}) != len(definition.edges):
        fail("edges", "连线 ID 必须唯一")
    starts = [n for n in definition.nodes if n.type == "start"]
    if len(starts) != 1:
        fail("nodes", "必须恰好有一个开始节点")
    if not any(n.type == "end" for n in definition.nodes):
        fail("nodes", "至少需要一个结束节点")
    if len([n for n in definition.nodes if n.type == "agent"]) > 10:
        fail("nodes", "最多支持 10 个 Agent 节点")
    outgoing: dict[str, list[FlowEdge]] = defaultdict(list)
    incoming: dict[str, list[str]] = defaultdict(list)
    for edge in definition.edges:
        if edge.source not in nodes or edge.target not in nodes:
            fail(f"edges.{edge.id}", "连线引用了不存在的节点")
            continue
        outgoing[edge.source].append(edge)
        incoming[edge.target].append(edge.source)

    bindings = definition.diagnosis_bindings.model_dump()
    if len(set(bindings.values())) != 3:
        fail("diagnosisBindings", "三个核心诊断节点必须不同")
    for key, node_id in bindings.items():
        node = nodes.get(node_id)
        if node is None or node.type != "agent":
            fail(f"diagnosisBindings.{key}", "必须绑定一个 Agent 节点")
            continue
        fields = {field.name: field for field in node.outputs}
        for name, kind in CONTRACTS[key].items():
            field = fields.get(name)
            if field is None or field.type != kind or not field.required:
                # Escalation reason may be null when the frontend resolves.
                if name == "escalation_reason" and field is not None and field.type == kind:
                    continue
                fail(f"nodes.{node_id}.outputs", f"内置契约要求 {name}: {kind}")

    for node in definition.nodes:
        path = f"nodes.{node.id}"
        edges = outgoing[node.id]
        if node.type == "start" and incoming[node.id]:
            fail(path, "开始节点不能有入边")
        if node.type == "end":
            if edges:
                fail(path, "结束节点不能有出边")
        elif node.type == "condition":
            if node.condition is None:
                fail(path, "条件配置不能为空")
            if len(edges) != 2 or {e.branch for e in edges} != {"true", "false"}:
                fail(path, "条件节点必须具有 true 和 false 两个出口")
        elif len(edges) != 1 or any(e.branch for e in edges):
            fail(path, "开始和 Agent 节点必须恰好有一个普通出口")
        if node.type == "agent":
            if node.role is None or not node.role.system_prompt.strip() or not node.task.strip():
                fail(path, "Agent 身份、系统提示词和任务不能为空")
            if not node.outputs:
                fail(path, "至少声明一个输出字段")
            if len({f.name for f in node.outputs}) != len(node.outputs):
                fail(path, "输出字段名必须唯一")
            for tool in node.execution.tools:
                if tool not in allowed_tools:
                    fail(f"{path}.execution.tools", f"工具不可用：{tool}")
            if node.execution.timeout_ms > definition.limits.timeout_ms:
                fail(path, "节点超时不能超过流程总超时")

    if errors:
        return errors

    paths: list[list[str]] = []

    def visit(node_id: str, stack: list[str]):
        if node_id in stack:
            fail(f"nodes.{node_id}", "不允许循环")
            return
        if len(paths) >= 256:
            fail("edges", "分支过多，最多支持 256 条路径")
            return
        stack = [*stack, node_id]
        if nodes[node_id].type == "end":
            paths.append(stack)
        else:
            for edge in outgoing[node_id]:
                visit(edge.target, stack)

    visit(starts[0].id, [])
    if errors:
        return errors
    reachable = {item for path in paths for item in path}
    if reachable != set(nodes):
        fail("nodes", "存在不可达或无法结束的节点")

    fe, be, leader = (bindings[k] for k in ("frontend", "backend", "leader"))
    if outgoing[starts[0].id][0].target != fe:
        fail("diagnosisBindings.frontend", "诊断必须从前端排查开始")
    gate_id = outgoing[fe][0].target
    gate = nodes[gate_id]
    ref = gate.condition.reference if gate.condition else None
    if (gate.type != "condition" or ref is None or ref.source != "node" or
            ref.node_id != fe or ref.path != ["need_escalation"] or
            gate.condition.operator != "eq" or gate.condition.value is not True):
        fail(f"nodes.{gate_id}", "前端后必须以 need_escalation == true 判断升级")
    else:
        escalated_target = next(e.target for e in outgoing[gate_id] if e.branch == "true")
        for path in paths:
            escalated = path[path.index(gate_id) + 1] == escalated_target
            if escalated:
                if be not in path or leader not in path or path.index(be) > path.index(leader):
                    fail("edges", "每条升级路径必须先执行后端，再执行综合分析")
            elif be in path or leader in path:
                fail("edges", "非升级路径不能执行后端或综合分析")

    for path in paths:
        budget = sum(nodes[n].execution.max_iterations for n in path if nodes[n].type == "agent")
        if budget > definition.limits.max_total_iterations:
            fail("limits.maxTotalIterations", "路径迭代预算超出总上限")
        for index, node_id in enumerate(path):
            node = nodes[node_id]
            refs = list(node.inputs.items())
            if node.condition:
                refs.append(("condition", node.condition.reference))
            for name, reference in refs:
                if reference.source == "task":
                    if reference.node_id or reference.path:
                        fail(f"nodes.{node_id}.inputs.{name}", "用户问题引用不能指定节点或字段")
                    if name == "condition" and node.condition and not isinstance(node.condition.value, str):
                        fail(f"nodes.{node_id}.condition", "用户问题条件只能与字符串比较")
                    continue
                source = nodes.get(reference.node_id or "")
                if source is None or source.type != "agent" or source.id not in path[:index]:
                    fail(f"nodes.{node_id}.inputs.{name}", "引用必须在每条路径上由上游 Agent 产出")
                    continue
                if len(reference.path) > 1:
                    fail(f"nodes.{node_id}.inputs.{name}", "首版仅支持顶层输出字段或完整输出")
                if reference.path and reference.path[0] not in {f.name for f in source.outputs}:
                    fail(f"nodes.{node_id}.inputs.{name}", "引用的输出字段未声明")
                if reference.path and any(
                    f.name == reference.path[0] and not f.required for f in source.outputs
                ):
                    fail(f"nodes.{node_id}.inputs.{name}", "不能直接引用可能缺失的可选输出字段")
                if node_id == be and (source.id != fe or reference.path != ["context_for_backend"]):
                    fail(f"nodes.{node_id}.inputs.{name}", "后端只允许读取前端事实字段")
                if node.condition and name == "condition":
                    field = next((f for f in source.outputs if reference.path == [f.name]), None)
                    if field is None or not field.required or not matches_type(node.condition.value, field.type):
                        fail(f"nodes.{node_id}.condition", "条件必须引用必填字段且比较值类型一致")
            for name, source_id in (("frontend", fe), ("backend", be)):
                if node_id == leader:
                    reference = node.inputs.get(name)
                    if (reference is None or reference.source != "node" or
                            reference.node_id != source_id or reference.path):
                        fail(f"nodes.{leader}.inputs.{name}", "综合分析需要完整的前端及后端输出")
    return [dict(item) for item in {tuple(e.items()) for e in errors}]
