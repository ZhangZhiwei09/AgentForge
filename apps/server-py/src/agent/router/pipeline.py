"""QueryRouter —— 路由管线编排器。

对应 TS: apps/server/src/services/agent-runtime/router.ts + routing/pipeline.ts

V1 简化版：只做 L1 关键词正则路由（SAFETY / HUMAN / TASK）。
L2 语义分类、L3/L4 LLM 路由留到后续版本。

Python 新概念：
- re.compile + pattern.search(): 正则匹配（类似 TS Regexp.test()）
- 优先级链模式: SAFETY > HUMAN > TASK(fallback)
"""

import re

from src.agent.types import RouteName, RouterDecision

# ═══════════════════════════════════════════════════════════
# L1 关键词正则（中/英）
# ═══════════════════════════════════════════════════════════

SAFETY_KEYWORDS: list[re.Pattern] = [
    re.compile(r"忽略.*(指令|规则|限制|之前)"),
    re.compile(r"扮演.*(角色|黑客|坏人)"),
    re.compile(r"(DAN|jailbreak|system\s*prompt)", re.IGNORECASE),
    re.compile(r"(ignore|forget).*(instruction|rule|prompt|everything|all)", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
    re.compile(r"<\|system\|>", re.IGNORECASE),
    re.compile(r"\[INST\].*/?INST\]", re.IGNORECASE),
    re.compile(r"(system|系统)\s*:\s*(你现在|你的新|ignore|forget)"),
    re.compile(r"(我是|我是你).*(管理员|开发者|创始人|CEO|CTO|老板).*(请|要求|命令|给我)"),
    re.compile(r"([^\s])\1{500,}"),  # 字符重复攻击
]

HUMAN_KEYWORDS: list[re.Pattern] = [
    re.compile(r"转人工"),
    re.compile(r"找(人工|真人|客服|你们经理|你们领导)"),
    re.compile(r"(打|联系|给.*)(客服)?电话"),
    re.compile(r"我要投诉"),
    re.compile(r"投诉.*(你们|客服|服务)"),
    re.compile(r"叫.*(经理|领导|负责人)"),
]

DIAGNOSIS_KEYWORDS: list[re.Pattern] = [
    # 强信号：错误码 + traceId
    re.compile(r"traceId\s*[:：]\s*\w+", re.IGNORECASE),
    re.compile(r"error[_ ]?code\s*[:：]\s*\w+", re.IGNORECASE),
    # 故障关键词
    re.compile(r"(报错|失败|超时|打不开|连不上|崩溃|闪退|白屏|卡死)"),
    re.compile(
        r"(排查|诊断|定位|帮我看下|帮我查下|帮我查|帮我看看|帮我看|帮我分析)"
        r".*(问题|原因|怎么回事|什么情况|什么原因)"
    ),
    # 摄像头/活体/人脸 故障
    re.compile(
        r"(摄像头|麦克风|活体|刷脸|人脸|认证|识别)"
        r".*(失败|打不开|不能用|没反应|超时|异常)"
    ),
    # 网络/WebSocket 故障
    re.compile(r"(WebSocket|网络|连接).*(断开|超时|失败)"),
    # 通过率/成功率 异常
    re.compile(r"(成功率|通过率).*(下跌|下降|降低|异常|掉|低)"),
]


# ═══════════════════════════════════════════════════════════
# quickRouteScan —— L1 关键词快速扫描
# ═══════════════════════════════════════════════════════════


def quick_route_scan(message: str) -> RouterDecision | None:
    """L1 规则优先扫描：零延迟正则匹配。

    处理 SAFETY、HUMAN 两类高确定性场景。
    其余所有查询返回 None，交给下游（当前版本直接 fallback 到 TASK）。

    Args:
        message: 用户原始消息

    Returns:
        RouterDecision 或 None（需要进一步分类）
    """
    # SAFETY 优先 —— 安全合规不能有任何延迟
    for pattern in SAFETY_KEYWORDS:
        if pattern.search(message):
            return RouterDecision(
                route=RouteName.SAFETY,
                confidence=1.0,
                reasoning="安全关键词命中",
            )

    # HUMAN —— 明确要求转人工
    for pattern in HUMAN_KEYWORDS:
        if pattern.search(message):
            return RouterDecision(
                route=RouteName.HUMAN,
                confidence=0.95,
                reasoning="转人工关键词命中",
            )

    # DIAGNOSIS —— 故障排查/诊断类问题
    for pattern in DIAGNOSIS_KEYWORDS:
        if pattern.search(message):
            return RouterDecision(
                route=RouteName.DIAGNOSIS,
                confidence=0.85,
                reasoning="诊断关键词命中",
            )

    return None  # → 默认走 TASK


# ═══════════════════════════════════════════════════════════
# QueryRouter
# ═══════════════════════════════════════════════════════════


class QueryRouter:
    """查询路由器 —— V1 只做 L1 关键词匹配 + TASK fallback。

    V2 将加入：
    - L2: 语义意图分类（Embedding + k-NN）
    - L3: Few-Shot LLM Router
    - L4: LLM Router
    - L5: Regex Fallback
    """

    def classify(self, message: str) -> RouterDecision:
        """对用户消息分类，返回路由决策。

        当前版本：L1 正则 → TASK fallback。
        """
        # L1: 关键词快速路由
        quick = quick_route_scan(message)
        if quick is not None:
            return quick

        # 默认：TASK（当前没有 L2-L5，直接用 ReAct 处理）
        return RouterDecision(
            route=RouteName.TASK,
            confidence=0.5,
            reasoning="默认路由（无关键词命中）",
        )
