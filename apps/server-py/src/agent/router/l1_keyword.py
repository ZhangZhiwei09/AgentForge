"""L1 关键词快速路由 —— 零延迟正则匹配。

对应 TS: apps/server/src/services/agent-runtime/routing/l1-keyword.ts

处理 SAFETY、HUMAN、DIAGNOSIS 三类高确定性场景 + Python 独有的 CHAT 快路径。
其余查询返回 None，交给 L2 SemanticClassifier。

优先级链: SAFETY > HUMAN > DIAGNOSIS > CHAT（Python 独有，TS 在 L1 不判 CHAT）。
"""

import re

from src.agent.types import RouteName, RouterDecision

# ═══════════════════════════════════════════════════════════
# SAFETY 关键词（照搬 TS 全量 ~27 条）
# ═══════════════════════════════════════════════════════════

SAFETY_KEYWORDS: list[re.Pattern] = [
    # ── 英文 prompt injection ──
    re.compile(r"忽略.*(指令|规则|限制|之前)"),
    re.compile(r"扮演.*(角色|黑客|坏人)"),
    re.compile(r"(DAN|jailbreak|system\s*prompt)", re.IGNORECASE),
    re.compile(r"ignore.*(instruction|rule)", re.IGNORECASE),
    re.compile(r"pretend.*(you\s*are|to\s*be)", re.IGNORECASE),
    # ── 多语言攻击变体（日文/繁体）──
    re.compile(r"無視.*(指示|ルール|制限)", re.IGNORECASE),
    re.compile(r"開発者.*モード", re.IGNORECASE),
    re.compile(r"忽略.*(指示|規則|制限|以前)", re.IGNORECASE),
    re.compile(r"(role.?(play|扮演)|cosplay|pretend\s+to\s+be)", re.IGNORECASE),
    re.compile(r"你.*(现在|从现在起|以後|从此).*是.*(ChatGPT|GPT|AI|人工智能|机器人)", re.IGNORECASE),
    re.compile(r"forget.*(everything|all).*(before|above|previous)", re.IGNORECASE),
    # ── Token 窜改 / 特殊分隔符注入 ──
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
    re.compile(r"<\|system\|>", re.IGNORECASE),
    re.compile(r"\[INST\].*\[\/?INST\]", re.IGNORECASE),
    re.compile(r"(system|系统|系統)\s*:\s*(你现在|你的新|ignore|forget)", re.IGNORECASE),
    re.compile(r"<\s*s\s*y\s*s\s*t\s*e\s*m\s*>", re.IGNORECASE),
    # ── 编码混淆检测 ──
    re.compile(r"(base64|b64|base64_decode|atob|fromCharCode)\s*\(", re.IGNORECASE),
    re.compile(r"[A-Za-z0-9+\/=]{40,}\s*(decode|解密|解码)", re.IGNORECASE),
    re.compile(r"fromCharCode\s*\(", re.IGNORECASE),
    # ── 社会工程 / 权限冒充 ──
    re.compile(r"(我是|我是你).*(管理员|开发者|创始人|CEO|CTO|老板|经理).*(请|要求|命令|给我)"),
    re.compile(r"(give|show|reveal|tell|print).*me.*(your\s*(prompt|instructions|system|code|rules))", re.IGNORECASE),
    re.compile(r"(output|print|dump|show).*(your|the).*(prompt|instructions|system\s*message)", re.IGNORECASE),
    # ── 重复/填充攻击 ──
    re.compile(r"([^\s])\1{500,}"),
]

# ═══════════════════════════════════════════════════════════
# HUMAN 关键词
# ═══════════════════════════════════════════════════════════

HUMAN_KEYWORDS: list[re.Pattern] = [
    re.compile(r"转人工"),
    re.compile(r"找(人工|真人|客服|你们经理|你们领导)"),
    re.compile(r"(打|联系|给.*)(客服)?电话"),
    re.compile(r"我要投诉"),
    re.compile(r"投诉.*(你们|客服|服务)"),
    re.compile(r"叫.*(经理|领导|负责人)"),
]

# ═══════════════════════════════════════════════════════════
# DIAGNOSIS 关键词
# ═══════════════════════════════════════════════════════════

DIAGNOSIS_KEYWORDS: list[re.Pattern] = [
    # 强信号：错误码 + traceId
    re.compile(r"traceId\s*[:：]\s*\w+", re.IGNORECASE),
    re.compile(r"error[_ ]?code\s*[:：]\s*\w+", re.IGNORECASE),
    # 故障关键词
    re.compile(r"(报错|失败|超时|打不开|连不上|崩溃|闪退|白屏|卡死)"),
    # 排查/诊断请求
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
# CHAT 关键词（Python 独有 —— TS 在 L1 不判 CHAT）
# ═══════════════════════════════════════════════════════════

CHAT_KEYWORDS: list[re.Pattern] = [
    # 问候 / 寒暄
    re.compile(r"^(你好|hi|hello|嗨|早上好|下午好|晚上好|午安|晚安)[\s!！。.,，]*$", re.IGNORECASE),
    re.compile(r"^(谢谢|多谢|感谢|thank|thanks|thx|3q|3Q)[\s!！。.,，]*$", re.IGNORECASE),
    re.compile(r"^(再见|拜拜|bye|回头见|下次见|88)[\s!！。.,，]*$", re.IGNORECASE),
    # 自我介绍 / 能力询问
    re.compile(r"(你是谁|你叫什么|你能做什么|你有什么功能|你会什么|介绍一下自己|你是什么模型)"),
    # 闲聊话题
    re.compile(r"^(今天天气|讲个笑话|聊聊天|随便聊聊|陪我聊天|好无聊|你在干嘛)"),
    re.compile(r"(心情不好|安慰我|鼓励我|夸我)"),
]


# ═══════════════════════════════════════════════════════════
# quickRouteScan —— L1 关键词快速扫描
# ═══════════════════════════════════════════════════════════


def quick_route_scan(message: str) -> RouterDecision | None:
    """L1 规则优先扫描：零延迟正则匹配。

    处理 SAFETY、HUMAN、DIAGNOSIS 三类高确定性场景 + Python 独有 CHAT。
    其余所有查询返回 None，交给下游（L2/L3/L4/L5）。

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

    # CHAT —— 寒暄/问候/自我介绍（低优先级，避免误拦 TASK）
    for pattern in CHAT_KEYWORDS:
        if pattern.search(message):
            return RouterDecision(
                route=RouteName.CHAT,
                confidence=0.9,
                reasoning="闲聊关键词命中",
            )

    return None  # → 交给下游层
