"""QueryRouter —— 路由管线编排器（L1-L5）。

对应 TS: apps/server/src/services/agent-runtime/routing/pipeline.ts

编排 5 层路由管线，按优先级依次尝试：
    L1: 关键词快速路由（SAFETY/HUMAN/DIAGNOSIS + Python 独有 CHAT）→ 零延迟
    L2: 语义意图分类（Embedding + pgvector k-NN）→ <50ms
    L3: Few-Shot 增强 LLM Router（L2 中置信度时）→ ~500ms
    L4: 原始 LLM Router（兜底）→ ~500ms
    L5: IntentDetector regex 兜底 → 永远返回

降级保障：L2 需要 embedding provider + intent_samples 表，L3/L4 需要 LLM provider；
任一缺失自动跳过对应层，最终由 L5 兜底。
"""

import logging

from src.agent.router.l1_keyword import quick_route_scan
from src.agent.router.l2_semantic import SemanticClassifier
from src.agent.router.l3_fewshot_llm import few_shot_classify
from src.agent.router.l4_raw_llm import llm_classify
from src.agent.router.l5_fallback import fallback_classify
from src.agent.types import RouteName, RouterDecision
from src.config import settings

logger = logging.getLogger(__name__)


class QueryRouter:
    """查询路由器 —— 编排 L1-L5 路由管线。

    用法:
        router = QueryRouter(model_id="gpt-4o-mini")
        decision = await router.classify(message, history)
    """

    def __init__(
        self,
        model_id: str | None = None,
        semantic_classifier: SemanticClassifier | None = None,
    ) -> None:
        self.model_id = model_id
        self.semantic_classifier = semantic_classifier or SemanticClassifier()

    async def classify(
        self,
        message: str,
        history: list | None = None,
    ) -> RouterDecision:
        """对用户消息分类，返回路由决策。

        Args:
            message: 用户原始消息
            history: 最近对话历史（L3/L4 取最近 4 条），可空
        """
        history = history or []

        # ── L1: 关键词快速路由（零延迟）──
        quick = quick_route_scan(message)
        if quick is not None:
            return quick

        # ── L2: 语义意图分类 ──
        if settings.router_semantic_enabled:
            l2 = await self.semantic_classifier.classify(message)
            if l2 is not None:
                # L2 高置信度（≥ high_confidence）→ 直接返回
                if l2.confidence >= settings.router_semantic_high_confidence:
                    logger.info(
                        "Router: L2 high confidence (%.2f), returning directly",
                        l2.confidence,
                    )
                    return RouterDecision(
                        route=l2.route,
                        confidence=l2.confidence,
                        reasoning=l2.reasoning,
                    )
                # L2 中置信度（low ~ high）且有 matches → L3 Few-Shot 增强
                if (
                    l2.confidence >= settings.router_semantic_low_confidence
                    and l2.matches
                    and settings.router_llm_enabled
                ):
                    l3 = await few_shot_classify(
                        message, history, l2.matches, self.model_id
                    )
                    if l3 is not None:
                        return l3
        else:
            logger.info("Router: L2 disabled by config")

        # ── L4: 原始 LLM Router（兜底）──
        if settings.router_llm_enabled:
            l4 = await llm_classify(message, history, self.model_id)
            if l4 is not None:
                return l4

        # ── L5: regex 兜底（永远返回）──
        if settings.router_fallback_enabled:
            return fallback_classify(message)

        # 理论不可达：所有层被禁用时回退 TASK
        return RouterDecision(
            route=RouteName.TASK,
            confidence=0.0,
            reasoning="Router fallback disabled",
        )
