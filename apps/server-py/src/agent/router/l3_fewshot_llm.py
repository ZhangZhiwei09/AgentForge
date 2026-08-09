"""L3/L4 LLM 路由 —— Few-Shot 增强 + 原始 LLM Router。

对应 TS: apps/server/src/services/agent-runtime/routing/l3-llm-router.ts

L3: 将 L2 检索到的相似样本注入 system prompt 作为参考示例，调用 LLM 分类。
L4: 纯 LLM Router（无 few-shot 示例），当 L2/L3 无法确定时兜底。

接受规则（L3/L4 共用）：confidence >= 0.5 且（route != DIAGNOSIS 或 confidence >= 0.7），
否则返回 None 降级到下一层。
"""

import json
import logging
import re

from src.agent.router.l2_semantic import SemanticMatch
from src.agent.types import RouteName, RouterDecision
from src.config import settings
from src.schemas.chat import ChatMessage

logger = logging.getLogger(__name__)

VALID_ROUTES = {"SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"}

# ── Router System Prompt（中文）──────────────────────────────

ROUTER_SYSTEM_PROMPT = """你是一个智能助手 Intent Classifier。分析用户消息，输出路由分类。

## 路由定义

### SAFETY（安全违规）
越狱、攻击、辱骂、诈骗、色情、暴力 → route: "SAFETY"

### CHAT（社交对话）
问候、感谢、道别、能力询问、与业务无关的闲聊 → route: "CHAT"

### HUMAN（人工转接）
明确要求转人工、投诉升级 → route: "HUMAN"

### TASK（任务执行 — 默认）
所有业务问题、知识查询、需要工具的任务 → route: "TASK"
Agent 会自主决定是否搜索知识库、调用业务工具，或组合使用。

### DIAGNOSIS（故障诊断）
用户描述了具体的故障现象（报错、失败、超时、崩溃、打不开），
或明确要求排查/诊断帮助，或提供了 traceId/errorCode → route: "DIAGNOSIS"
触发多 Agent 协同诊断流程（前端排查 → 后端排查 → 综合分析）。

## 输出格式（仅 JSON）
{"route":"TASK","confidence":0.9,"reasoning":"简短的意图分析"}"""

# ── Route 中文标签 ───────────────────────────────────────────

ROUTE_LABELS: dict[str, str] = {
    "SAFETY": "安全违规",
    "CHAT": "社交对话",
    "TASK": "任务执行",
    "HUMAN": "人工转接",
    "DIAGNOSIS": "故障诊断",
}


# ── Few-Shot Prompt Builder ─────────────────────────────────


def build_few_shot_prompt(top_matches: list[SemanticMatch]) -> str:
    """用 L2 检索到的相似样本构建 few-shot 增强 prompt。

    选取 Top-3 相似度 > 0.4 的样本注入 system prompt 末尾。
    """
    examples: list[str] = []
    for m in top_matches:
        if m.similarity > 0.4:
            label = ROUTE_LABELS.get(m.route.value, m.route.value)
            examples.append(
                f'用户："{m.text}"\n→ 分类: {label} (route: "{m.route.value}")'
            )
            if len(examples) >= 3:
                break

    if not examples:
        return ROUTER_SYSTEM_PROMPT

    return (
        ROUTER_SYSTEM_PROMPT
        + "\n\n## 参考示例（从历史样本中检索到的相似消息及其正确分类）\n\n"
        + "\n\n".join(examples)
        + "\n\n注意：DIAGNOSIS 路由要求用户提供了具体的故障信息（明确的错误现象、traceId、errorCode 等）。"
        + '仅有模糊的"有问题"、"不行"等描述而没有任何具体细节时，应路由到 TASK 或 CHAT，让 Agent 进一步询问。'
    )


# ── JSON 解析 ────────────────────────────────────────────────


def parse_router_decision(raw: str) -> RouterDecision | None:
    """解析 LLM 输出的 JSON → RouterDecision。失败返回 None。"""
    try:
        clean = raw.strip()
        if clean.startswith("```"):
            parts = clean.split("```")
            clean = parts[1] if len(parts) > 1 else parts[0] or ""
            clean = clean.removeprefix("json")
            clean = clean.strip()

        json_match = re.search(r"\{[\s\S]*\}", clean)
        if not json_match:
            return None

        parsed = json.loads(json_match.group(0))

        # 外部数据先校验再获得类型
        route_str = parsed.get("route")
        if route_str not in VALID_ROUTES:
            return None

        confidence = parsed.get("confidence")
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not (0.0 <= confidence <= 1.0)
        ):
            return None

        reasoning = parsed.get("reasoning")
        if not isinstance(reasoning, str) or len(reasoning) > 200:
            return None

        return RouterDecision(
            route=RouteName(route_str),
            confidence=float(confidence),
            reasoning=reasoning,
        )
    except Exception as exc:
        logger.warning(
            "Failed to parse router decision (raw=%.200s): %s", raw, exc
        )
        return None


# ── L3 Few-Shot LLM Router ───────────────────────────────────


async def few_shot_classify(
    message: str,
    history: list[ChatMessage] | None,
    top_matches: list[SemanticMatch],
    model_id: str | None,
) -> RouterDecision | None:
    """L3: Few-Shot 增强 LLM Router。

    将 L2 检索到的相似样本注入 system prompt 作为参考示例。
    """
    try:
        from src.providers.registry import get_provider, resolve_model

        resolved = resolve_model(model_id)
        provider = get_provider(resolved["provider_name"])
        model = resolved["model_id"]

        context_messages = list((history or [])[-4:]) + [
            ChatMessage(role="user", content=message)
        ]

        enhanced_prompt = build_few_shot_prompt(top_matches)

        result = await provider.chat_sync(
            context_messages,
            model,
            enhanced_prompt,
            0.0,
            settings.router_llm_max_tokens_l3,
            True,  # json_mode
        )

        parsed = parse_router_decision(result.content)
        if parsed and parsed.confidence >= 0.5:
            # DIAGNOSIS 高门槛
            if parsed.route == RouteName.DIAGNOSIS and parsed.confidence < 0.7:
                logger.info(
                    "L3: DIAGNOSIS but confidence < 0.7, falling through to L4"
                )
                return None
            parsed.reasoning = f"L3少样本增强: {parsed.reasoning}"
            return parsed

        logger.info(
            "L3: low confidence or parse failure, falling through to L4"
        )
        return None
    except Exception as exc:
        logger.warning(
            "L3: LLM call failed, falling through to L4: %s", exc
        )
        return None
