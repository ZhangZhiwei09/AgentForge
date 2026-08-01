"""DiagnosisState —— Multi-Agent 诊断父图的状态定义。

对应 multi-agent-langgraph-plan.md §3.3。

父图只在 Phase 2（团队级 Checkpointing）挂 checkpointer；Phase 1 无
持久化要求，dataclass 产物直接存实例即可。§3.3 已说明产物 dataclass
（FrontendOutput 等）字段全为 str/int/bool/list/dict，天然 JSON 可序列化。

字段说明：
- blackboard: Blackboard.serialize() 的镜像快照（供 Phase 2 checkpoint 恢复时
  重建共享上下文；Phase 1 节点实际经闭包持有 Blackboard 实例）。
"""

from typing import TypedDict

from src.agent.diagnosis.mode import (
    BackendOutput,
    DiagnosisResolution,
    FrontendOutput,
    ScoringResult,
)


class DiagnosisState(TypedDict):
    """Multi-Agent 诊断父图的跨阶段状态。

    Attributes:
        task: 用户原始问题。
        conversation_id: 会话 ID。
        frontend_output: 前端阶段产物（含 need_escalation 等）。
        backend_output: 后端阶段产物。
        scoring: Leader 评分结果。
        resolution: 最终决议（resolve / fast_track 节点写入）。
        blackboard: Blackboard 序列化快照（镜像）。
    """

    task: str
    conversation_id: str
    frontend_output: FrontendOutput | None
    backend_output: BackendOutput | None
    scoring: ScoringResult | None
    resolution: DiagnosisResolution | None
    blackboard: dict | None
