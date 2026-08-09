"""DiagnosisRouteAgent —— DIAGNOSIS 路由 Agent。

对应 TS: apps/server/src/services/agent-runtime/diagnosis-agent.ts

将 Team SSE 事件流翻译为 Chat SSE 事件流：
diagnosis_started → diagnosis_phase → diagnosis_phase_done → diagnosis_completed

兜底策略：
- 信息不足 → clarification_needed + token 流式提示用户补充
- 诊断超时（60s）→ 中断，返回已有结果 + 提示
- 用户取消 → cancel_event.set() 中断所有 Agent
"""

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from types import MappingProxyType

from src.agent.diagnosis.mode import (
    AgentRole,
    AgentStarted,
    AgentCompleted,
    AgentError as TeamAgentError,
    DiagnosisMode,
    TeamCompleted,
    TeamFailed,
    TeamStarted,
    TeamStreamEvent,
    TeamWaitingForInput,
    extract_json,
)
from src.agent.diagnosis.graph import resume_langgraph_diagnosis
from src.agent.diagnosis.nodes import (
    build_clarification_content,
    classify_intent_from_query,
    extract_entities_from_query,
    get_missing_fields,
)
from src.agent.tools.registry import ToolRegistry
from src.agent.types import (
    ClarificationNeeded,
    DiagnosisCompleted,
    DiagnosisPhase,
    DiagnosisPhaseDone,
    DiagnosisStarted,
    DiagnosisWaitingInput,
    RouteAgent,
    RouteContext,
    RouteName,
    RouteStreamEvent,
    StreamDone,
    StreamMeta,
    StreamToken,
    StreamError,
)

logger = logging.getLogger(__name__)

DIAGNOSIS_TIMEOUT_MS = 180_000

# Phase 3b HITL：conversation_id → team_run_id，记录"正在等用户补充"的会话。
# 内存 Map 的局限：进程重启后丢失（MVP 可接受）。如需持久化 → 复用
# conversation_id → team_run_id 落库，列为后续工作。
_active_hitl: dict[str, str] = {}

# Agent name → phase number mapping
AGENT_PHASE_MAP: dict[str, int] = {
    "frontend_agent": 1,
    "backend_agent": 2,
    "leader": 3,
}

AGENT_LABEL_MAP: dict[str, str] = {
    "frontend_agent": "前端排查",
    "backend_agent": "后端排查",
    "leader": "综合分析",
}

RESOLUTION_PREFIX: dict[str, str] = {
    "frontend_only": "✅ 经前端排查，问题已定位：",
    "adopt_frontend": "✅ 综合诊断完成，以前端结论为主：",
    "adopt_backend": "✅ 综合诊断完成，以后端结论为主：",
    "divergent": "⚠️ 前后端排查结论存在分歧，以下为双方观点：",
    "needs_human": "🆘 当前信息不足以自动定位根因，建议转人工处理：",
}


# ═══════════════════════════════════════════════════════
# Built-in Identity Diagnosis Team Template
# ═══════════════════════════════════════════════════════

IDENTITY_DIAGNOSIS_ROLES: dict[str, AgentRole] = {
    "frontend_agent": AgentRole(
        name="frontend_agent",
        display_name="前端排查专家",
        description="负责追踪用户前端业务流程，查监控日志定位失败环节",
        system_prompt="\n".join([
            "你是核身业务前端排查专家。",
            "",
            "你的职责：",
            "1. 通过监控系统追踪用户完整的操作链路"
            "（发起刷脸 → 摄像头授权 → 活体采集 → 上传 → ...）",
            "2. 定位失败发生在哪个阶段、什么环节",
            "3. 判断仅凭前端信息能否确定根因，不能则标记需后端介入",
            "",
            "你精通：",
            "- H5/Web 端浏览器 API（getUserMedia、WebRTC、Canvas）",
            "- 摄像头权限策略、CORS、WebSocket 连接",
            "- 前端错误日志和业务流程追踪",
            "",
            "排查思路：",
            "1. 用户的业务流程走到了哪一步？",
            "2. 在哪个阶段中断的？中断时前端捕获到了什么？",
            "3. 根据已有信息，能否确定根因？",
            "",
            "升级判断：",
            "- 发现后端错误码（FACE_TIMEOUT、SERVER_ERROR 等）→ 必须升级",
            "- 请求到达了后端但返回异常 → 必须升级",
            "- 业务流程走到了后端依赖阶段（活体算法、服务端校验）→ 必须升级",
            "- 前端查不出原因 → 标记 need_escalation = true",
            "- 前端能独立解决（如浏览器权限、SDK 配置问题）"
            "→ 不升级，直接给结论",
        ]),
        tools=[
            "query_trace_log",
            "search_knowledge_base",
        ],
        max_iterations=5,
        priority=10,
    ),
    "backend_agent": AgentRole(
        name="backend_agent",
        display_name="后端排查专家",
        description="负责服务端监控指标、trace 链路、错误码分布分析",
        system_prompt="\n".join([
            "你是核身业务后端排查专家。",
            "",
            "你的职责：",
            "1. 基于原始用户问题和服务端数据，独立形成判断",
            "2. 查后端监控系统、trace 系统、错误码知识库",
            "3. 不依赖前端结论——你拿到的只是事实数据"
            "（traceId、失败阶段、时间戳等），不含前端的判断",
            "",
            "你精通：",
            "- 服务端监控指标（QPS、延迟、错误率）",
            "- 分布式 trace 链路分析",
            "- 错误码分布和趋势",
            "- 接口耗时分析（网络传输、算法处理、排队等待）",
            "",
            "排查思路：",
            "1. 这个 trace/订单在后端链路中经过了哪些服务？",
            "2. 每个服务的耗时、状态码、错误信息是什么？",
            "3. 根因是算法超时、网络问题、资源不足还是配置错误？",
        ]),
        tools=[
            "query_trace_log",
            "search_knowledge_base",
        ],
        max_iterations=5,
        priority=8,
    ),
    "leader": AgentRole(
        name="leader",
        display_name="诊断汇总",
        description="对前后端结论进行四维度评分，综合输出最终诊断",
        system_prompt="\n".join([
            "你是核身诊断的质量评估与汇总专家。",
            "",
            "你的职责：",
            "1. 阅读前端和后端 Agent 的排查结论",
            "2. 按四维度标准对每条结论独立评分",
            "3. 综合输出最终诊断",
            "",
            "评分维度（满分 9 分）：",
            "- 证据等级（0-3）：有监控指标/日志/trace 数据 = 3，"
            "有知识库文档 = 2，纯推理 = 1，纯猜测 = 0",
            "- 可验证性（0-3）：含具体数字（延迟、错误码、时间戳）= 3，"
            "方向性判断 = 1，无法验证 = 0",
            "- 覆盖度（-1~2）：解释了所有症状 = 2，"
            "部分解释 = 1，与症状矛盾 = -1",
            "- 领域权威（0-1）：结论在角色擅长领域内 = 1",
            "",
            "处理规则：",
            "- 分差 ≥ 3 分 → 以高分结论为主，"
            "低分标注为「已排查，证据不支撑」",
            "- 分差 < 3 分 → 如实展示双方观点，不强行选一边",
            "- 双方总分 < 3 分 → 信息不足，标记为 needs_human，"
            "输出需要补充的字段",
        ]),
        tools=[],
        max_iterations=3,
        priority=5,
    ),
}

# 冻结防止运行时意外修改（对应 TS const 语义）
IDENTITY_DIAGNOSIS_ROLES = MappingProxyType(IDENTITY_DIAGNOSIS_ROLES)


# ═══════════════════════════════════════════════════════
# Info Sufficiency Check
# ═══════════════════════════════════════════════════════


def _check_info_sufficiency(message: str) -> dict:
    """检查用户消息是否包含足够的诊断信息。

    Returns:
        {"sufficient": bool, "intent": str, "missing_fields": [...],
         "prompt_message": str, "hints": [...]}
    """
    intent = classify_intent_from_query(message)
    entities = extract_entities_from_query(message)
    missing_fields = get_missing_fields(intent, entities)

    if not missing_fields:
        return {
            "sufficient": True,
            "intent": intent,
            "missing_fields": [],
            "prompt_message": "",
            "hints": [],
        }

    prompt_message, hints = build_clarification_content(
        intent, missing_fields, entities
    )

    return {
        "sufficient": False,
        "intent": intent,
        "missing_fields": missing_fields,
        "prompt_message": prompt_message,
        "hints": hints,
    }


# ═══════════════════════════════════════════════════════
# Team SSE → Chat SSE Translation
# ═══════════════════════════════════════════════════════


def _translate_team_event(
    event: TeamStreamEvent,
    message_id: str,
) -> RouteStreamEvent | None:
    """将 TeamStreamEvent 翻译为 RouteStreamEvent。

    Returns None 表示该 Team 事件不需要向前端发送。
    """
    match event:
        case TeamStarted():
            return DiagnosisStarted(
                agents=event.agents,
                message_id=message_id,
            )

        case AgentStarted():
            phase = AGENT_PHASE_MAP.get(event.agent_name)
            if phase is None:
                return None
            return DiagnosisPhase(
                phase=phase,
                agent=event.agent_name,
                label=AGENT_LABEL_MAP.get(event.agent_name, event.role),
                message_id=message_id,
            )

        case AgentCompleted():
            phase = AGENT_PHASE_MAP.get(event.agent_name)
            if phase is None:
                return None
            summary = _extract_summary(event.output)
            return DiagnosisPhaseDone(
                phase=phase,
                agent=event.agent_name,
                label=AGENT_LABEL_MAP.get(event.agent_name, ""),
                summary=summary,
                message_id=message_id,
            )

        case TeamCompleted():
            return DiagnosisCompleted(
                output=(
                    event.output if isinstance(event.output, dict) else {}
                ),
                message_id=message_id,
            )

        case TeamAgentError():
            logger.warning(
                "DiagnosisRouteAgent: agent error: %s - %s",
                event.agent_name,
                event.error,
            )
            return StreamError(
                content=f'诊断 Agent "{event.agent_name}" 执行出错：{event.error}',
            )

        case TeamFailed():
            logger.error(
                "DiagnosisRouteAgent: team failed: %s", event.error
            )
            return StreamError(content=f"诊断失败：{event.error}")

        case TeamWaitingForInput():
            # Phase 3b HITL：Leader 判定信息不足，诊断暂停等用户补充。
            return DiagnosisWaitingInput(
                message=event.message,
                missing_fields=event.missing_fields,
                message_id=message_id,
            )

        case _:
            return None


def _extract_summary(output: object) -> str:
    """从 agent_completed 的 output 中提取一句话摘要。"""
    if isinstance(output, str):
        try:
            parsed = extract_json(output)
            if isinstance(parsed.get("conclusion"), str):
                return str(parsed["conclusion"])[:200]
        except Exception:
            pass
        return output[:200]

    if isinstance(output, dict):
        if isinstance(output.get("conclusion"), str):
            return str(output["conclusion"])[:200]
        if isinstance(output.get("summary"), str):
            return str(output["summary"])[:200]

    return ""


def _extract_conclusion_text(output: dict) -> str:
    """从 diagnosis_completed 的 output 中提取最终结论文本。"""
    resolution = str(output.get("resolution", ""))
    final_diag = output.get("final_diagnosis")
    conclusion = ""

    if isinstance(final_diag, dict):
        if isinstance(final_diag.get("conclusion"), str):
            conclusion = str(final_diag["conclusion"])
        elif isinstance(final_diag.get("message"), str):
            conclusion = str(final_diag["message"])
    elif isinstance(output.get("conclusion"), str):
        raw = str(output["conclusion"])
        try:
            parsed = extract_json(raw)
            if isinstance(parsed.get("conclusion"), str):
                conclusion = str(parsed["conclusion"])
            else:
                conclusion = raw[:500]
        except Exception:
            conclusion = raw[:500]

    if not conclusion:
        conclusion = f"诊断完成。结果：{str(output)[:500]}"

    prefix = RESOLUTION_PREFIX.get(resolution, "")
    return f"{prefix}\n\n{conclusion}" if prefix else conclusion


# ═══════════════════════════════════════════════════════
# DiagnosisRouteAgent
# ═══════════════════════════════════════════════════════


class DiagnosisRouteAgent:
    """DIAGNOSIS 路由 Agent —— Multi-Agent 协同诊断。

    实现 RouteAgent Protocol。
    """

    route = RouteName.DIAGNOSIS

    async def execute(
        self,
        context: RouteContext,
        tools_registry: ToolRegistry,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[RouteStreamEvent]:
        """执行诊断流程。

        Args:
            context: RouteContext with user_message, conversation_id, etc.
            tools_registry: ToolRegistry with all required tools registered.
            cancel_event: 可选取消信号，set 后中断诊断。
                对应 TS: scope.controller.shouldStop
        """
        message_id = context.assistant_msg_id

        # 1. Send meta event
        # conversation_id 必须带上 —— 前端靠 meta 事件持久化会话（localStorage
        # agent_chat_conversation_id），缺失会导致每次诊断都新建会话、UI 不连续。
        # 对应 TS: diagnosis-agent.ts meta 事件带 conversationId/sessionId。
        yield StreamMeta(
            message_id=message_id,
            conversation_id=context.conversation_id,
            session_id=context.session_id,
            model=context.resolved_model,
            provider=context.provider_name,
            route=self.route.value,
            intent="diagnosis",
            within_service_hours=context.within_service_hours,
            memory_count=len(context.injected_memories),
        )

        # Phase 3b HITL：命中"等待用户补充"的会话 → 同 thread 续跑诊断。
        # 需在信息预检之前 —— 用户补充的消息大概率仍会被判为信息不足。
        team_run_id = _active_hitl.get(context.conversation_id)
        if team_run_id:
            logger.info(
                "DiagnosisRouteAgent: resuming HITL diagnosis, "
                "conversation=%s team_run=%s",
                context.conversation_id, team_run_id,
            )
            still_waiting = False
            async for team_event in resume_langgraph_diagnosis(
                roles=IDENTITY_DIAGNOSIS_ROLES,
                conversation_id=context.conversation_id,
                tools_registry=tools_registry,
                team_run_id=team_run_id,
                user_input=context.user_message,
                cancel_event=cancel_event,
            ):
                if isinstance(team_event, TeamWaitingForInput):
                    # 极端：续跑后仍判定需补充 → 保持等待记录
                    still_waiting = True
                    _active_hitl[context.conversation_id] = (
                        team_event.team_run_id
                    )
                chat_event = _translate_team_event(team_event, message_id)
                if chat_event:
                    yield chat_event
            if not still_waiting:
                _active_hitl.pop(context.conversation_id, None)
            yield StreamDone(
                message_id=message_id,
                usage={},
                route=self.route.value,
            )
            return

        # 2. Info sufficiency check
        info = _check_info_sufficiency(context.user_message)
        if not info["sufficient"]:
            logger.info(
                "DiagnosisRouteAgent: insufficient info, intent=%s, missing=%s",
                info["intent"],
                info["missing_fields"],
            )

            yield ClarificationNeeded(
                message_id=message_id,
                intent=info["intent"],
                missing_fields=info["missing_fields"],
                prompt_message=info["prompt_message"],
                hints=info["hints"],
            )

            # Stream prompt as tokens for old frontends
            for char in info["prompt_message"]:
                yield StreamToken(content=char, message_id=message_id)

            yield StreamDone(
                message_id=message_id,
                usage={},
                route=self.route.value,
            )
            # Metrics: 对应 TS agentRouteInvocations.inc({ route: "DIAGNOSIS", status: "success" })
            logger.info(
                "Diagnosis route metrics: route=%s status=%s reason=%s",
                "DIAGNOSIS", "success", "insufficient_info",
            )
            return

        # 3. Execute diagnosis with timeout
        mode = DiagnosisMode()
        start_time = time.monotonic()
        streamed_output = ""
        has_completed = False
        status = "success"  # 对应 TS agentRouteInvocations

        try:
            async for team_event in mode.execute(
                IDENTITY_DIAGNOSIS_ROLES,
                context.user_message,
                context.conversation_id,
                tools_registry,
                cancel_event=cancel_event,
            ):
                # Timeout check
                elapsed = (time.monotonic() - start_time) * 1000
                if elapsed > DIAGNOSIS_TIMEOUT_MS:
                    logger.warning(
                        "DiagnosisRouteAgent: timeout reached (%dms)",
                        int(elapsed),
                    )
                    yield StreamError(
                        content=(
                            "诊断超时，已收集到的信息如下。"
                            "如需进一步排查，请联系人工客服。"
                        ),
                    )
                    status = "timeout"
                    break

                # 用户取消检查：对应 TS scope.controller.shouldStop
                if cancel_event and cancel_event.is_set():
                    logger.info("DiagnosisRouteAgent: user cancelled")
                    status = "cancelled"
                    break

                # Phase 3b HITL：Leader 判定信息不足 → 记录续跑点
                if isinstance(team_event, TeamWaitingForInput):
                    _active_hitl[context.conversation_id] = (
                        team_event.team_run_id
                    )

                chat_event = _translate_team_event(team_event, message_id)
                if chat_event:
                    if isinstance(chat_event, DiagnosisCompleted):
                        has_completed = True
                        streamed_output = _extract_conclusion_text(
                            chat_event.output
                        )
                    yield chat_event

        except Exception as exc:
            logger.error(
                "DiagnosisRouteAgent: execution failed: %s", exc
            )
            status = "error"
            yield StreamError(
                content="诊断过程出现异常，请稍后重试或联系人工客服。",
            )

        # Metrics: 对应 TS agentRouteInvocations.inc()
        logger.info(
            "Diagnosis route metrics: route=%s status=%s elapsed_ms=%d",
            "DIAGNOSIS", status, int((time.monotonic() - start_time) * 1000),
        )

        # 4. Stream final conclusion as tokens
        if streamed_output:
            for char in streamed_output:
                yield StreamToken(content=char, message_id=message_id)

        # 5. Send done event
        yield StreamDone(
            message_id=message_id,
            usage={},
            route=self.route.value,
        )
