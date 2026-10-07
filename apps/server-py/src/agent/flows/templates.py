"""The existing diagnosis roles packaged as an editable flow."""

from src.agent.flows.schema import CONTRACTS, FlowDefinition


def diagnosis_template() -> FlowDefinition:
    # Import lazily: the diagnosis route also loads the flow execution module.
    from src.agent.diagnosis.route_agent import IDENTITY_DIAGNOSIS_ROLES

    nodes = [
        {"id": "start", "type": "start", "name": "开始", "position": {"x": 0, "y": 160}},
    ]
    tasks = {
        "frontend": "从前端视角排查当前问题，收集证据与后端所需事实，判断是否升级。",
        "backend": "基于原始问题和事实数据独立排查，不参考前端判断结论。",
        "leader": "按身份中的四维度标准评分，综合已映射的专家结论，列出仍缺失的信息。",
    }
    for key, old_name, x, y in [
        ("frontend", "frontend_agent", 240, 160),
        ("backend", "backend_agent", 720, 80),
        ("leader", "leader", 960, 80),
    ]:
        role = IDENTITY_DIAGNOSIS_ROLES[old_name]
        inputs = {"question": {"source": "task"}}
        if key == "backend":
            inputs["facts"] = {"source": "node", "nodeId": "frontend", "path": ["context_for_backend"]}
        if key == "leader":
            inputs.update({
                "frontend": {"source": "node", "nodeId": "frontend", "path": []},
                "backend": {"source": "node", "nodeId": "backend", "path": []},
            })
        nodes.append({
            "id": key, "type": "agent", "name": role.display_name,
            "position": {"x": x, "y": y},
            "role": {"name": role.display_name, "description": role.description,
                     "systemPrompt": role.system_prompt},
            "task": tasks[key], "inputs": inputs,
            "outputs": [{"name": name, "type": kind, "required": name != "escalation_reason"}
                        for name, kind in CONTRACTS[key].items()],
            "execution": {"tools": role.tools, "maxIterations": role.max_iterations, "timeoutMs": 60000},
        })
    nodes.extend([
        {"id": "escalate", "type": "condition", "name": "是否升级",
         "position": {"x": 480, "y": 160},
         "condition": {"reference": {"source": "node", "nodeId": "frontend", "path": ["need_escalation"]},
                       "operator": "eq", "value": True}},
        {"id": "fast_end", "type": "end", "name": "前端完成", "position": {"x": 720, "y": 300}},
        {"id": "end", "type": "end", "name": "诊断完成", "position": {"x": 1200, "y": 80}},
    ])
    edges = [
        {"id": "start_frontend", "source": "start", "target": "frontend"},
        {"id": "frontend_escalate", "source": "frontend", "target": "escalate"},
        {"id": "escalate_backend", "source": "escalate", "target": "backend", "branch": "true"},
        {"id": "escalate_fast", "source": "escalate", "target": "fast_end", "branch": "false"},
        {"id": "backend_leader", "source": "backend", "target": "leader"},
        {"id": "leader_end", "source": "leader", "target": "end"},
    ]
    return FlowDefinition.model_validate({
        "nodes": nodes, "edges": edges,
        "diagnosisBindings": {"frontend": "frontend", "backend": "backend", "leader": "leader"},
    })
