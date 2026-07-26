"""DiagnosisMode —— 前端先行排查 + 后端按需介入的诊断模式。

对应 TS: apps/server/src/teams/modes/diagnosis.ts

三阶段流程：
  Phase 1: 前端 Agent 排查 → 自评是否需要升级
  Phase 2: 后端 Agent 独立排查（仅升级时）
  Phase 3: Leader Agent 评分汇总（仅升级时）

Fast Track: 前端能独立解决则不调用后端和 Leader。
"""

import asyncio
import json as _json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field

from src.agent.executor import AgentExecutor
from src.agent.tools.registry import ToolRegistry
from src.agent.types import RouteContext, StreamToken
from src.agent.diagnosis.blackboard import Blackboard

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────

BACKEND_ERROR_CODES = [
    "FACE_TIMEOUT",
    "FACE_FAILED",
    "LIVENESS_FAILED",
    "ALGORITHM_ERROR",
    "SERVER_ERROR",
    "INTERNAL_ERROR",
    "SERVICE_UNAVAILABLE",
    "GATEWAY_TIMEOUT",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "UPSTREAM_ERROR",
    "DB_ERROR",
    "CACHE_ERROR",
]

BACKEND_STAGE_PATTERNS: list[re.Pattern] = [
    re.compile(r"活体(算法|检测|校验|比对)"),
    re.compile(r"liveness\s*(algorithm|detection|check|verify)", re.IGNORECASE),
    re.compile(r"服务端(校验|检测|比对)"),
    re.compile(r"人脸(比对|算法|识别)"),
    re.compile(r"face\s*(compare|match|verify|recognize)", re.IGNORECASE),
    re.compile(r"算法(超时|处理|排队)"),
    re.compile(r"algorithm\s*(timeout|processing|queue)", re.IGNORECASE),
]

BACKEND_ABNORMAL_PATTERN = re.compile(
    r"(?:请求|request).*(?:到达|reached|返回|returned)"
    r".*(?:后端|backend|server|服务端)"
    r".*(?:异常|失败|错误|error|fail|timeout|超时)",
    re.IGNORECASE,
)

DIAGNOSIS_TIMEOUT_MS = 60_000

# ── Internal Types ─────────────────────────────────────────


@dataclass
class FrontendOutput:
    conclusion: str = ""
    evidence: list[dict] = field(default_factory=list)
    need_escalation: bool = False
    escalation_reason: str | None = None
    context_for_backend: dict = field(default_factory=dict)


@dataclass
class BackendOutput:
    conclusion: str = ""
    evidence: list[dict] = field(default_factory=list)


@dataclass
class ScoringResult:
    frontend_score: int = 0
    backend_score: int = 0
    frontend_breakdown: dict = field(default_factory=dict)
    backend_breakdown: dict = field(default_factory=dict)
    reasoning: str = ""
    synthesis: str = ""
    missing_fields: list[str] = field(default_factory=list)
    message: str = ""


@dataclass
class DiagnosisResolution:
    resolution: str = "needs_human"
    final_diagnosis: dict = field(default_factory=dict)


# ── Team Stream Events (internal, not RouteStreamEvent) ────


@dataclass
class TeamStarted:
    type: str = "team_started"
    team_run_id: str = ""
    team_name: str = ""
    mode: str = "diagnosis"
    agents: list[dict] = field(default_factory=list)


@dataclass
class AgentStarted:
    type: str = "agent_started"
    agent_name: str = ""
    role: str = ""
    task: str = ""


@dataclass
class AgentCompleted:
    type: str = "agent_completed"
    agent_name: str = ""
    output: object = None
    duration_ms: int = 0


@dataclass
class AgentError:
    type: str = "agent_error"
    agent_name: str = ""
    error: str = ""


@dataclass
class TeamCompleted:
    type: str = "team_completed"
    output: dict = field(default_factory=dict)
    total_duration_ms: int = 0
    rounds_count: int = 0


@dataclass
class TeamFailed:
    type: str = "team_failed"
    error: str = ""


type TeamStreamEvent = (
    TeamStarted | AgentStarted | AgentCompleted | AgentError
    | TeamCompleted | TeamFailed
)


# ── AgentRole (subset of TS AgentRole) ─────────────────────


@dataclass
class AgentRole:
    name: str
    display_name: str
    description: str
    system_prompt: str
    tools: list[str] = field(default_factory=list)
    max_iterations: int = 5
    priority: int = 5


# ═══════════════════════════════════════════════════════════
# Pure Functions (testable without AgentExecutor)
# ═══════════════════════════════════════════════════════════


def extract_json(text: str) -> dict:
    """从 LLM 文本输出中提取 JSON 对象。

    先尝试围栏代码块，再尝试裸 JSON。
    """
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        return _json.loads(fence.group(1).strip())

    raw = re.search(r"\{[\s\S]*\}", text)
    if raw:
        return _json.loads(raw.group(0))

    raise ValueError("No JSON found in output")


def check_rule_escalation(frontend_output: str) -> bool:
    """规则兜底：扫描前端输出中的后端错误码和业务阶段。

    即使 LLM 判断不需要升级，如果检测到后端相关指标也强制升级。
    """
    upper = frontend_output.upper()

    for code in BACKEND_ERROR_CODES:
        if code in upper:
            return True

    for pattern in BACKEND_STAGE_PATTERNS:
        if pattern.search(frontend_output):
            return True

    if BACKEND_ABNORMAL_PATTERN.search(frontend_output):
        return True

    return False


def parse_frontend_output(output: str) -> FrontendOutput:
    """解析前端 Agent 输出为结构化 FrontendOutput。"""
    try:
        j = extract_json(output)
        return FrontendOutput(
            conclusion=str(j.get("conclusion", "")),
            evidence=(
                j["evidence"] if isinstance(j.get("evidence"), list) else []
            ),
            need_escalation=bool(j.get("need_escalation", False)),
            escalation_reason=(
                str(j["escalation_reason"])
                if j.get("escalation_reason")
                else None
            ),
            context_for_backend=(
                j["context_for_backend"]
                if isinstance(j.get("context_for_backend"), dict)
                else {}
            ),
        )
    except Exception:
        return FrontendOutput(
            conclusion=output[:500],
            evidence=[],
            need_escalation=False,
            escalation_reason=None,
            context_for_backend={},
        )


def parse_backend_output(output: str) -> BackendOutput:
    """解析后端 Agent 输出为结构化 BackendOutput。"""
    try:
        j = extract_json(output)
        return BackendOutput(
            conclusion=str(j.get("conclusion", "")),
            evidence=(
                j["evidence"] if isinstance(j.get("evidence"), list) else []
            ),
        )
    except Exception:
        return BackendOutput(
            conclusion=output[:500],
            evidence=[],
        )


def parse_scoring_output(output: str) -> ScoringResult:
    """解析 Leader 评分输出为结构化 ScoringResult。"""
    try:
        j = extract_json(output)
        return ScoringResult(
            frontend_score=(
                int(j["frontend_score"]) if isinstance(j.get("frontend_score"), (int, float)) else 0
            ),
            backend_score=(
                int(j["backend_score"]) if isinstance(j.get("backend_score"), (int, float)) else 0
            ),
            frontend_breakdown=(
                j["frontend_breakdown"]
                if isinstance(j.get("frontend_breakdown"), dict)
                else {}
            ),
            backend_breakdown=(
                j["backend_breakdown"]
                if isinstance(j.get("backend_breakdown"), dict)
                else {}
            ),
            reasoning=str(j.get("reasoning", "")),
            synthesis=str(j.get("synthesis", "")),
            missing_fields=(
                [str(x) for x in j["missing_fields"]]
                if isinstance(j.get("missing_fields"), list)
                else []
            ),
            message=str(j.get("message", "")),
        )
    except Exception:
        return build_fallback_scoring(
            FrontendOutput(
                conclusion=output,
                evidence=[],
                need_escalation=True,
                context_for_backend={},
            ),
            BackendOutput(conclusion="", evidence=[]),
        )


def build_fallback_scoring(
    frontend: FrontendOutput,
    backend: BackendOutput,
    reason: str | None = None,
) -> ScoringResult:
    """构建兜底（零分、转人工）评分结果。"""
    return ScoringResult(
        frontend_score=0,
        backend_score=0,
        frontend_breakdown={
            "evidence_quality": 0,
            "verifiability": 0,
            "coverage": 0,
            "domain_authority": 0,
        },
        backend_breakdown={
            "evidence_quality": 0,
            "verifiability": 0,
            "coverage": 0,
            "domain_authority": 0,
        },
        reasoning=reason or "Leader 未产出有效评分。",
        synthesis=f"前端结论：{frontend.conclusion}\n后端结论：{backend.conclusion}",
        missing_fields=["traceId", "具体失败时间"],
        message="自动评分未产出有效结果，已转人工处理。",
    )


def resolve_diagnosis(
    frontend: FrontendOutput,
    backend: BackendOutput,
    scoring: ScoringResult,
) -> DiagnosisResolution:
    """根据评分阈值确定最终诊断决议。

    阈值规则：
    - 双方总分 < 3 → needs_human
    - 分差 ≥ 3 → 采纳高分方
    - 分差 < 3 → divergent（双方观点分歧）
    """
    f_score = scoring.frontend_score
    b_score = scoring.backend_score
    score_diff = abs(f_score - b_score)
    max_score = max(f_score, b_score)

    if max_score < 3:
        return DiagnosisResolution(
            resolution="needs_human",
            final_diagnosis={
                "status": "needs_human",
                "collected_info": {
                    "frontend_finding": frontend.conclusion,
                    "backend_finding": backend.conclusion,
                },
                "missing_fields": scoring.missing_fields,
                "message": (
                    scoring.message
                    or "当前信息不足以自动定位根因，已转人工处理。"
                ),
            },
        )

    if score_diff >= 3:
        winner = "frontend" if f_score > b_score else "backend"
        winner_result = frontend if winner == "frontend" else backend
        loser_result = backend if winner == "frontend" else frontend
        loser_name = (
            "backend_agent" if winner == "frontend" else "frontend_agent"
        )
        loser_score = b_score if winner == "frontend" else f_score

        return DiagnosisResolution(
            resolution=f"adopt_{winner}",
            final_diagnosis={
                "conclusion": winner_result.conclusion,
                "evidence": winner_result.evidence,
                "dissenting_view": {
                    "agent": loser_name,
                    "conclusion": loser_result.conclusion,
                    "note": "已排查，证据不支撑此结论。",
                    "score": loser_score,
                },
                "scoring": {
                    "frontend_score": scoring.frontend_score,
                    "backend_score": scoring.backend_score,
                },
            },
        )

    return DiagnosisResolution(
        resolution="divergent",
        final_diagnosis={
            "frontend_view": {
                "conclusion": frontend.conclusion,
                "score": f_score,
                "evidence": frontend.evidence,
            },
            "backend_view": {
                "conclusion": backend.conclusion,
                "score": b_score,
                "evidence": backend.evidence,
            },
            "scoring": {
                "frontend_score": scoring.frontend_score,
                "backend_score": scoring.backend_score,
            },
        },
    )


# ═══════════════════════════════════════════════════════════
# DiagnosisMode
# ═══════════════════════════════════════════════════════════

@dataclass
class AgentRunResult:
    events: list[TeamStreamEvent] = field(default_factory=list)
    output: str | None = None


class DiagnosisMode:
    """前端先行排查 + 后端按需介入的诊断执行器。

    用法:
        mode = DiagnosisMode()
        async for event in mode.execute(roles, task, conv_id, tools_registry):
            if isinstance(event, TeamCompleted):
                print(event.output)
    """

    async def execute(
        self,
        roles: dict[str, AgentRole],
        task: str,
        conversation_id: str,
        tools_registry: ToolRegistry,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[TeamStreamEvent]:
        """执行 3 阶段诊断流程。

        Args:
            roles: {"frontend_agent": AgentRole, "backend_agent": AgentRole, "leader": AgentRole}
            task: 用户原始问题
            conversation_id: 会话 ID
            tools_registry: 工具注册中心（已注册所有必要工具）
            cancel_event: 可选取消信号，set 后中断诊断
        """
        bb = Blackboard()
        frontend_role = roles.get("frontend_agent")
        backend_role = roles.get("backend_agent")
        leader_role = roles.get("leader")
        team_run_id = str(uuid.uuid4())

        if not frontend_role:
            yield TeamFailed(
                error=(
                    "DiagnosisMode requires 'frontend_agent' in roles dict"
                )
            )
            return

        bb.write("task", task, "system")

        # Collect agent names for team_started
        agents_info = [
            {"name": r.name, "role": r.display_name}
            for r in roles.values()
        ]
        yield TeamStarted(
            team_run_id=team_run_id,
            team_name="核身诊断团队",
            mode="diagnosis",
            agents=agents_info,
        )

        # ═════════════════════════════════════════════════════
        # Phase 1: Frontend Agent Investigation
        # ═════════════════════════════════════════════════════

        frontend_result = await self._run_agent(
            frontend_role,
            self._build_frontend_task(frontend_role, task, bb),
            conversation_id,
            tools_registry,
            cancel_event=cancel_event,
        )
        for event in frontend_result.events:
            yield event

        frontend_output = parse_frontend_output(
            frontend_result.output or ""
        )

        # Cancel check: user interrupted during Phase 1
        if cancel_event and cancel_event.is_set():
            logger.info("DiagnosisMode: cancelled during Phase 1")
            yield TeamFailed(error="诊断已被用户取消。")
            return

        # Safety net: rule-based check overrides LLM self-assessment
        if check_rule_escalation(frontend_result.output or ""):
            if not frontend_output.need_escalation:
                logger.info(
                    "DiagnosisMode: rule-based escalation triggered "
                    "(LLM missed it)"
                )
                frontend_output.need_escalation = True
                frontend_output.escalation_reason = (
                    "rule_override: backend error code or stage "
                    "detected in frontend output"
                )

        bb.write("frontend_conclusion", {
            "conclusion": frontend_output.conclusion,
            "evidence": frontend_output.evidence,
            "need_escalation": frontend_output.need_escalation,
        }, "frontend_agent")

        # ---- Fast Track: Frontend Resolved Alone ----
        if not frontend_output.need_escalation:
            frontend_scoring = ScoringResult(
                frontend_score=9,
                backend_score=0,
                synthesis=frontend_output.conclusion,
            )
            yield TeamCompleted(
                output={
                    "conclusion": frontend_output.conclusion,
                    "evidence": frontend_output.evidence,
                    "resolution": "frontend_only",
                    "escalated": False,
                    "scoring": asdict(frontend_scoring),
                },
                rounds_count=1,
            )
            return

        # Store context for backend (facts only, not the conclusion)
        bb.write(
            "context_for_backend",
            frontend_output.context_for_backend or {},
            "frontend_agent",
        )

        # ═════════════════════════════════════════════════════
        # Phase 2: Backend Agent Independent Investigation
        # ═════════════════════════════════════════════════════

        backend_output: BackendOutput
        if not backend_role:
            logger.warning(
                "DiagnosisMode: escalated but no backend_agent in team"
            )
            backend_output = BackendOutput(
                conclusion="后端排查 Agent 未配置，无法执行独立排查。",
                evidence=[],
            )
        else:
            backend_result = await self._run_agent(
                backend_role,
                self._build_backend_task(
                    backend_role,
                    task,
                    frontend_output.context_for_backend,
                    bb,
                ),
                conversation_id,
                tools_registry,
                cancel_event=cancel_event,
            )
            for event in backend_result.events:
                yield event

            # Cancel check: user interrupted during Phase 2
            if cancel_event and cancel_event.is_set():
                logger.info("DiagnosisMode: cancelled during Phase 2")
                yield TeamFailed(error="诊断已被用户取消。")
                return

            backend_output = parse_backend_output(
                backend_result.output or ""
            )

        bb.write("backend_conclusion", {
            "conclusion": backend_output.conclusion,
            "evidence": backend_output.evidence,
        }, "backend_agent")

        # ═════════════════════════════════════════════════════
        # Phase 3: Leader Scoring & Synthesis
        # ═════════════════════════════════════════════════════

        scoring_result: ScoringResult
        if not leader_role:
            logger.warning(
                "DiagnosisMode: escalated but no leader agent in team"
            )
            scoring_result = build_fallback_scoring(
                frontend_output,
                backend_output,
                "团队未配置 leader Agent。",
            )
        else:
            leader_result = await self._run_agent(
                leader_role,
                self._build_leader_task(
                    leader_role,
                    task,
                    frontend_output,
                    backend_output,
                    bb,
                ),
                conversation_id,
                tools_registry,
                cancel_event=cancel_event,
            )
            for event in leader_result.events:
                yield event

            # Cancel check: user interrupted during Phase 3
            if cancel_event and cancel_event.is_set():
                logger.info("DiagnosisMode: cancelled during Phase 3")
                yield TeamFailed(error="诊断已被用户取消。")
                return

            scoring_result = parse_scoring_output(
                leader_result.output or ""
            )

        bb.write("scoring_result", {
            "frontend_score": scoring_result.frontend_score,
            "backend_score": scoring_result.backend_score,
            "synthesis": scoring_result.synthesis,
        }, "leader")

        resolution = resolve_diagnosis(
            frontend_output, backend_output, scoring_result
        )

        yield TeamCompleted(
            output={
                "resolution": resolution.resolution,
                "final_diagnosis": resolution.final_diagnosis,
                "scoring": asdict(scoring_result),
                "escalated": True,
            },
            rounds_count=3,
        )

    # ═════════════════════════════════════════════════════
    # Agent Runner
    # ═════════════════════════════════════════════════════

    async def _run_agent(
        self,
        role: AgentRole,
        task_prompt: str,
        conversation_id: str,
        tools_registry: ToolRegistry,
        cancel_event: asyncio.Event | None = None,
    ) -> AgentRunResult:
        """运行单个 Agent，收集事件和最终输出。

        使用现有的 AgentExecutor ReAct 循环。
        role.system_prompt 作为 LLM system prompt，
        task_prompt 作为 user message。

        对应 TS: DiagnosisMode.runAgentAndCollect()
        - role.tools 过滤工具列表（对应 TS role.tools 参数）
        - cancel_event 支持取消中断（对应 TS scope.controller.shouldStop）
        """
        events: list[TeamStreamEvent] = []
        output: str | None = None

        events.append(AgentStarted(
            agent_name=role.name,
            role=role.display_name,
            task=task_prompt,
        ))

        # 工具过滤：每个 Agent 只能使用其声明的工具
        # 对应 TS: agentService.run(..., { tools: role.tools })
        if role.tools:
            filtered_registry = tools_registry.filter(role.tools)
        else:
            filtered_registry = tools_registry

        try:
            executor = AgentExecutor(registry=filtered_registry)

            context = RouteContext(
                conversation_id=conversation_id,
                user_message=task_prompt,
                resolved_model="",
                provider_name="",
                assistant_msg_id=f"diag-{role.name}-{int(time.time() * 1000)}",
                intent="diagnosis",
            )

            # 收集 token 输出
            tokens: list[str] = []
            async for event in executor.execute(
                context,
                system_prompt=role.system_prompt,
            ):
                # 取消检查：对应 TS scope.controller.shouldStop
                if cancel_event and cancel_event.is_set():
                    logger.info(
                        "DiagnosisMode: agent %s cancelled", role.name
                    )
                    break

                if isinstance(event, StreamToken):
                    tokens.append(event.content)

            output = "".join(tokens) if tokens else None

            events.append(AgentCompleted(
                agent_name=role.name,
                output=output or "",
                duration_ms=0,
            ))
        except Exception as exc:
            error_msg = str(exc)
            logger.error(
                "DiagnosisMode: agent %s failed: %s",
                role.name,
                error_msg,
            )
            events.append(AgentError(
                agent_name=role.name,
                error=error_msg,
            ))

        return AgentRunResult(events=events, output=output)

    # ═════════════════════════════════════════════════════
    # Task Builders
    # ═════════════════════════════════════════════════════

    def _build_frontend_task(
        self,
        role: AgentRole,
        task: str,
        bb: Blackboard,
    ) -> str:
        """构建前端 Agent 的任务 prompt。"""
        return "\n".join([
            "## 当前任务",
            task,
            "",
            "## Blackboard（共享上下文）",
            bb.to_context_string(),
            "",
            "## 输出要求",
            "你必须以 JSON 格式输出你的排查结论：",
            "",
            "```json",
            "{",
            '  "conclusion": "排查结论——用户业务流程走到了哪一步、'
            '在哪个阶段中断、前端捕获到了什么",',
            '  "evidence": [',
            '    { "type": "log|trace|observation|knowledge", '
            '"detail": "具体证据" }',
            "  ],",
            '  "need_escalation": true或false,',
            '  "escalation_reason": "monitoring_indicates_backend|'
            'cannot_determine|null（不需要升级时）",',
            '  "context_for_backend": {',
            '    "traceId": "从上下文提取的 traceId",',
            '    "failedStage": "失败发生的业务阶段",',
            '    "clientType": "H5/小程序/App/Web",',
            '    "timestamp": "失败发生时间",',
            '    "frontendObservation": "前端观察到的现象'
            '（只写事实，不包含判断结论）"',
            "  }",
            "}",
            "```",
            "",
            "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
        ])

    def _build_backend_task(
        self,
        role: AgentRole,
        task: str,
        context_for_backend: dict,
        bb: Blackboard,
    ) -> str:
        """构建后端 Agent 的任务 prompt。

        key: 后端只能看到前端传来的事实数据，看不到前端结论。
        """
        ctx_lines = "\n".join(
            f"- {k}: {v}"
            for k, v in (context_for_backend or {}).items()
        ) if context_for_backend else "无"

        return "\n".join([
            "## 原始用户问题",
            task,
            "",
            "## 前端排查上下文（仅包含事实数据，不包含前端结论）",
            ctx_lines,
            "",
            "## Blackboard（共享上下文）",
            bb.to_context_string(),
            "",
            "## 重要提示",
            "- 以上「前端排查上下文」只包含事实数据，不包含前端 Agent 的判断结论。",
            "- 你必须独立形成判断，不能假设前端结论正确或错误。",
            "- 基于后端监控数据、trace 链路、错误码分布，从服务端视角定位根因。",
            "",
            "## 输出要求",
            "你必须以 JSON 格式输出排查结论：",
            "",
            "```json",
            "{",
            '  "conclusion": "独立排查结论——包含根因定位、关键指标、时间线",',
            '  "evidence": [',
            '    { "type": "trace|metric|distribution|knowledge", '
            '"detail": "具体证据" }',
            "  ]",
            "}",
            "```",
            "",
            "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
        ])

    def _build_leader_task(
        self,
        role: AgentRole,
        task: str,
        frontend_result: FrontendOutput,
        backend_result: BackendOutput,
        bb: Blackboard,
    ) -> str:
        """构建 Leader Agent 的任务 prompt（含四维度评分标准）。"""
        frontend_json = _json.dumps(
            {
                "conclusion": frontend_result.conclusion,
                "evidence": frontend_result.evidence,
            },
            ensure_ascii=False,
            indent=2,
        )
        backend_json = _json.dumps(
            {
                "conclusion": backend_result.conclusion,
                "evidence": backend_result.evidence,
            },
            ensure_ascii=False,
            indent=2,
        )

        return "\n".join([
            "## 原始用户问题",
            task,
            "",
            "## 前端 Agent 结论",
            "```json",
            frontend_json,
            "```",
            "",
            "## 后端 Agent 结论",
            "```json",
            backend_json,
            "```",
            "",
            "## 评分标准（四维度，满分 9 分）",
            "",
            "请对以上两条结论分别按以下四个维度打分：",
            "",
            "| 维度 | 分值 | 评分标准 |",
            "|------|------|----------|",
            "| 证据等级 | 0-3 | 3=有监控指标/日志/trace数据支撑；"
            "2=有知识库文档引用；1=纯推理/经验判断；0=纯猜测 |",
            "| 可验证性 | 0-3 | 3=含具体数字（延迟、错误码、时间戳）；"
            "1=方向性判断；0=无法验证 |",
            "| 覆盖度 | -1~2 | 2=解释了所有症状；"
            "1=部分解释；-1=与某些症状矛盾 |",
            "| 领域权威 | 0-1 | 1=结论在该角色擅长领域内"
            "（后端关于延迟=后端Agent+1，前端关于浏览器行为=前端Agent+1）；"
            "0=不在 |",
            "",
            "## Blackboard（共享上下文）",
            bb.to_context_string(),
            "",
            "## 输出要求",
            "以 JSON 格式输出评分结果：",
            "",
            "```json",
            "{",
            '  "frontend_score": 前端总分(0-9),',
            '  "backend_score": 后端总分(0-9),',
            '  "frontend_breakdown": {',
            '    "evidence_quality": 0-3,',
            '    "verifiability": 0-3,',
            '    "coverage": -1到2,',
            '    "domain_authority": 0-1',
            "  },",
            '  "backend_breakdown": {',
            '    "evidence_quality": 0-3,',
            '    "verifiability": 0-3,',
            '    "coverage": -1到2,',
            '    "domain_authority": 0-1',
            "  },",
            '  "reasoning": "评分理由，逐维度说明为什么给这个分数",',
            '  "synthesis": "综合诊断结论——以证据更强的结论为主线，标注分叉点",',
            '  "missing_fields": ["需要补充的信息字段'
            '（不需要转人工时为空数组）"],',
            '  "message": "转人工时的提示消息'
            '（不需要转人工时为空字符串）"',
            "}",
            "```",
            "",
            "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
        ])
