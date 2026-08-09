"""Multi-Agent Diagnosis 模块 —— 故障排查协同诊断。

核心组件：
- Blackboard: 共享上下文黑板
- DiagnosisMode: 3 阶段诊断执行器
- DiagnosisRouteAgent: DIAGNOSIS 路由 Agent
- nodes: 意图分类、实体提取、缺失字段检查
- tools: Mock 监控工具
"""

from src.agent.diagnosis.blackboard import Blackboard, BlackboardEntry
from src.agent.diagnosis.mode import DiagnosisMode
from src.agent.diagnosis.nodes import (
    classify_intent_from_query,
    extract_entities_from_query,
    get_missing_fields,
    build_clarification_content,
    FIELD_HINTS,
    INTENT_LABELS,
)
from src.agent.diagnosis.route_agent import DiagnosisRouteAgent
from src.agent.diagnosis.tools import DIAGNOSIS_TOOLS

__all__ = [
    "Blackboard",
    "BlackboardEntry",
    "DiagnosisMode",
    "DiagnosisRouteAgent",
    "classify_intent_from_query",
    "extract_entities_from_query",
    "get_missing_fields",
    "build_clarification_content",
    "FIELD_HINTS",
    "INTENT_LABELS",
    "DIAGNOSIS_TOOLS",
]
