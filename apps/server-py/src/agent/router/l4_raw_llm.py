"""L4 原始 LLM Router —— 无 few-shot 示例增强。

对应 TS: apps/server/src/services/agent-runtime/routing/l3-llm-router.ts 的 llmClassify。

当 L2 和 L3 都无法确定时兜底。接受规则与 L3 一致：
confidence >= 0.5 且（route != DIAGNOSIS 或 confidence >= 0.7）。
"""

import logging

from src.agent.router.l3_fewshot_llm import (
    ROUTER_SYSTEM_PROMPT,
    parse_router_decision,
)
from src.agent.types import RouteName, RouterDecision
from src.config import settings
from src.schemas.chat import ChatMessage

logger = logging.getLogger(__name__)


async def llm_classify(
    message: str,
    history: list[ChatMessage] | None,
    model_id: str | None,
) -> RouterDecision | None:
    """L4: 原始 LLM Router（无 few-shot 示例增强）。"""
    try:
        from src.providers.registry import get_provider, resolve_model

        resolved = resolve_model(model_id)
        provider = get_provider(resolved["provider_name"])
        model = resolved["model_id"]

        context_messages = list((history or [])[-4:]) + [
            ChatMessage(role="user", content=message)
        ]

        result = await provider.chat_sync(
            context_messages,
            model,
            ROUTER_SYSTEM_PROMPT,
            0.0,
            settings.router_llm_max_tokens_l4,
            True,  # json_mode
        )

        parsed = parse_router_decision(result.content)
        if parsed:
            if parsed.route == RouteName.DIAGNOSIS and parsed.confidence < 0.7:
                logger.info(
                    "L4: DIAGNOSIS but confidence < 0.7, falling back to IntentDetector"
                )
            elif parsed.confidence >= 0.5:
                return parsed

        logger.info("L4: low confidence, falling back to IntentDetector")
    except Exception as exc:
        logger.warning(
            "L4: LLM call failed, falling back to IntentDetector: %s", exc
        )

    return None
