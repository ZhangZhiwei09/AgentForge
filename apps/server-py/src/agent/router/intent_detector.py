"""客服意图识别 —— 基于关键词匹配的规则分类器。

对应 TS: apps/server/src/services/intent-detector.ts

L5 兜底层的意图检测。V1 用正则匹配，零延迟、零成本。

JS 语义细节：TS 的 message.match(pattern) 未加 g flag，恒返回首个匹配，
故 matches.length 恒为 1（无捕获组），confidence 对任意命中都是 0.7。
"2+ = 0.85" 的分支是死代码（tests 也按 0.7 断言）。Python 用 re.search 精确复刻。
"""

import re

INTENT_PATTERNS: dict[str, re.Pattern] = {
    "退货退款": re.compile(r"退货|退款|换货|退钱|退换|退单|取消订单|订单取消"),
    "物流查询": re.compile(r"物流|快递|发货|运单|配送|送到|送货|邮寄|包裹|签收|没收到|还没到"),
    "售后联系": re.compile(r"投诉|客服|电话|联系|反馈|热线|人工|找你们"),
    "账户会员": re.compile(r"会员|积分|等级|注册|账号|密码|登录|绑定|修改.*信息|个人信息"),
    "支付订单": re.compile(r"支付|付款|订单|优惠券|分期|发票|收据|价钱|价格|多少钱|怎么买"),
}


class IntentDetector:
    """意图检测器 —— 返回 (intent, confidence)。

    多个意图命中时返回匹配到的第一个（顺序即 INTENT_PATTERNS 定义顺序）；
    无命中返回 ("其他咨询", 0.0)。
    """

    def detect(self, message: str) -> tuple[str, float]:
        """检测用户消息的意图分类。"""
        best_intent = "其他咨询"
        best_score = 0

        for intent, pattern in INTENT_PATTERNS.items():
            # JS match() 无 g flag：有匹配即 score = 1
            if pattern.search(message):
                score = 1
                if score > best_score:
                    best_score = score
                    best_intent = intent

        if best_intent == "其他咨询":
            return "其他咨询", 0.0
        # best_score 恒为 1 → confidence = 0.7（保留公式以对齐 TS 结构）
        return best_intent, min(0.7 + (best_score - 1) * 0.15, 1.0)

    def list_intents(self) -> list[str]:
        """列出所有支持的意图分类。"""
        return list(INTENT_PATTERNS.keys())


# 单例
intent_detector = IntentDetector()
