"""L5 正则兜底 —— IntentDetector 最终兜底层。

对应 TS: apps/server/src/services/agent-runtime/routing/l5-fallback.ts

在 L2-L4 全部失败后兜底。永远返回 RouterDecision（不会为 None）。
仅「售后联系」映射到 HUMAN，其余意图均映射 TASK。
"""

from src.agent.router.intent_detector import intent_detector
from src.agent.types import RouteName, RouterDecision

INTENT_TO_ROUTE: dict[str, RouteName] = {
    "退货退款": RouteName.TASK,
    "物流查询": RouteName.TASK,
    "售后联系": RouteName.HUMAN,
    "账户会员": RouteName.TASK,
    "支付订单": RouteName.TASK,
    "其他咨询": RouteName.TASK,
}


def fallback_classify(message: str) -> RouterDecision:
    """正则兜底分类 —— 永远返回一个决策。"""
    intent, confidence = intent_detector.detect(message)
    route = INTENT_TO_ROUTE.get(intent, RouteName.TASK)
    return RouterDecision(
        route=route,
        confidence=confidence,
        reasoning=f"IntentDetector fallback: {intent} (confidence: {confidence:.2f})",
    )
