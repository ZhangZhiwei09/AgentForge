"""Enterprise entry precedence; configuration errors never fall through."""

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

from src.agent.entry_flows.runtime import check_cancel
from src.agent.router.business_classifier import classify_business_intent
from src.agent.router.l1_keyword import SAFETY_KEYWORDS
from src.agent.types import RouteName, RouterDecision
from src.schemas.chat import ChatMessage

_CONTENT_SAFETY_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|above|prior)\s+instructions?",
    r"disregard\s+(all\s+)?(previous|above|prior)\s+instructions?",
    r"forget\s+(all\s+)?(previous|earlier|prior)\s+instructions?",
    r"you\s+are\s+now\s+(a\s+)?different", r"new\s+system\s+prompt", r"override\s+system",
    r"reveal\s+(your|the)\s+(system\s+)?prompt", r"show\s+me\s+(your|the)\s+(system\s+)?prompt",
    r"what\s+(is|are)\s+(your|the)\s+(system\s+)?prompt",
    r"print\s+(your|the)\s+(system\s+)?instructions", r"dump\s+(your|the)\s+(system\s+)?prompt",
    r"^\s*system\s*:\s*", r"\[system\]", r"<system>", r"<\|system\|>",
    r"DAN\s+mode", r"developer\s+mode", r"jailbreak", r"pretend\s+you\s+are", r"act\s+as\s+if",
    r"ignore\s+the\s+above", r"disregard\s+everything\s+(above|before)",
]
_CONTENT_SAFETY = [re.compile(pattern, re.IGNORECASE | re.MULTILINE) for pattern in _CONTENT_SAFETY_PATTERNS]
_CONTENT_SAFETY.append(re.compile(r"\[INST\]"))


def request_outside_quotes(message: str) -> str:
    value = re.sub(r'''"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`''', " ", message)
    return re.sub(r"[\s!！。.,，?？;；]+$", "", value.strip())


def explicit_entry_control(message: str) -> Literal["human", "cancel"] | None:
    request = request_outside_quotes(message)
    if re.fullmatch(r"(?:请|麻烦)?(?:帮我)?(?:取消|停止|结束)(?:当前|这次|本次)?(?:的)?(?:排查|诊断)", request):
        return "cancel"
    if re.fullmatch(r"(?:请|麻烦)?(?:帮我|我要|我想)?(?:转(?:接)?人工(?:支持|客服)?|找人工(?:支持|客服)?|联系人工支持)", request):
        return "human"
    return None


def affirmative_diagnosis(message: str) -> bool:
    clauses = [part.strip() for part in re.split(r"[，,。!！?？;；\n]", request_outside_quotes(message))]
    information_object = re.compile(r"(?:文档|资料|知识|说明|含义|教程|步骤|流程|原理|规则|示例|案例)(?:在哪里|在哪|是什么|有哪些)?(?:就行|即可|就好|就可以|就够)?(?:了|吧|吗|啊|呀|啦|呢)?$")
    information_question = re.compile(r"(?:是什么|什么意思|意味着什么|(?:怎么|如何)(?:做|操作|使用|配置|排查|诊断|理解)|有哪些(?:步骤|流程|方法))")
    for clause in clauses:
        if re.search(r"(?:不要|不用|无需|不需要|不想|不打算|别)(?:再|继续|进行|帮我|帮忙|做)?(?:排查|诊断|定位|查(?:一下|下|一查)?(?:这次|本次|当前)?(?:故障|原因|日志|监控|链路|trace))", clause, re.IGNORECASE):
            return False
        if (re.search(r"^(?:请|麻烦)?(?:帮我|帮忙|(?:我)?(?:只是|只|仅)?(?:想|需要|要)?)?(?:了解|知道|解释|查看|看看|看|查询|查阅|查(?:一下|下|一查)?|找|学习|阅读)", clause)
                and information_object.search(clause)):
            return False
    for clause in clauses:
        if information_object.search(clause) or information_question.search(clause):
            continue
        if re.search(r"^(?:请|麻烦)?(?:帮我|帮忙|协助我|我想|我要|我需要|我想要)?(?:排查|诊断|定位|查一下|查下|查一查)", clause):
            return True
        if re.search(r"^(?:请|麻烦)?(?:帮我|帮忙)查", clause):
            return True
        if re.search(r"^(?:我|我们|这个用户|该用户|某用户|本次请求|这次请求)(?:的)?(?:登录|认证|核身|刷脸|页面|接口|请求|服务|摄像头|SDK|sdk|网络|操作)(?:现在|刚才|一直|又|出现|发生|遇到|时){0,2}(?:失败|报错|超时|白屏|闪退|打不开|异常)", clause):
            return True
    return False


def safety_route_scan(message: str) -> RouterDecision | None:
    if not message.strip() or len(message) > 16000 or any(pattern.search(message) for pattern in [*SAFETY_KEYWORDS, *_CONTENT_SAFETY]):
        return RouterDecision(RouteName.SAFETY, 1, "安全关键词命中")
    return None


def conversational_reply(message: str) -> dict | None:
    rules = [
        (r"(你好|hi|hello|嗨|您好|早上好|下午好|晚上好|在吗|在不在)[\s!！。.,，]*",
         "你好，我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。需要什么帮助？", ["查询知识库", "诊断系统故障"]),
        (r"(谢谢|感谢|多谢|谢谢你|谢谢您|thanks|thank you|3q)[\s!！。.,，]*", "不客气。还有其他问题可以随时找我。", []),
        (r"(再见|拜拜|Bye|bye|88|下次见|回头见)[\s!！。.,，]*", "再见。", []),
    ]
    for pattern, answer, suggestions in rules:
        if re.fullmatch(pattern, message.strip()):
            return {"answer": answer, "suggestions": suggestions}
    return None


@dataclass
class EntryDecision:
    action: Literal["dispatch", "reply", "clarify", "unavailable"]
    source: str
    reasoning: str
    route: RouteName = RouteName.CHAT
    answer: str = ""
    suggestions: list[str] = field(default_factory=list)
    business_intent: str | None = None
    resolved_query: str | None = None
    handoff: dict | None = None


async def decide_entry(
    message: str, history: list[ChatMessage], model_id: str | None, *,
    safety_decision: RouterDecision | None, waiting_diagnosis: bool,
    load_entry_result: Callable[[], Awaitable[dict | None]],
    cancel_waiting_diagnosis: Callable[[], Awaitable[bool]],
    conversational: dict | None = None,
    classify: Callable[..., Awaitable[dict]] | None = None,
    cancel: asyncio.Event | None = None,
    waiting_task: bool = False,
    cancel_waiting_task: Callable[[], Awaitable[bool]] | None = None,
) -> EntryDecision:
    check_cancel(cancel)
    if safety_decision is not None:
        return EntryDecision("dispatch", "safety_rule", safety_decision.reasoning, RouteName.SAFETY)
    control = explicit_entry_control(message)
    if control == "human":
        return EntryDecision("dispatch", "control_rule", "明确请求人工支持", RouteName.HUMAN)
    if control == "cancel":
        cancelled = waiting_diagnosis and await cancel_waiting_diagnosis()
        task_cancelled = await cancel_waiting_task() if waiting_task and cancel_waiting_task else False
        check_cancel(cancel)
        return EntryDecision("reply", "control_rule", "取消等待补充的排查",
                             answer="已取消当前等待中的任务。" if task_cancelled else
                             "已取消当前等待补充的排查。" if cancelled else "当前没有可取消的等待排查。")
    if waiting_diagnosis:
        return EntryDecision("dispatch", "session_state", "等待补充的配置诊断续跑",
                             RouteName.DIAGNOSIS, business_intent="diagnosis")
    if waiting_task:
        return EntryDecision("dispatch", "session_state", "等待补充或审批的任务续跑",
                             RouteName.TASK, business_intent="consultation")
    configured = await load_entry_result()
    check_cancel(cancel)
    if configured and configured["action"] == "reply":
        return EntryDecision("reply", "entry_flow", "一级流程固定回复",
                             answer=configured["answer"], suggestions=configured["suggestions"])
    if configured and configured["action"] == "route":
        target = configured["target"]
        if target == "HUMAN" or (target == "DIAGNOSIS" and not affirmative_diagnosis(message)):
            return EntryDecision("unavailable", "entry_flow",
                                 f"配置 {target} 分流缺少明确请求，请管理员检查匹配条件",
                                 answer="入口配置与当前请求不一致，暂时无法处理。请联系管理员检查流程配置。")
        return EntryDecision("dispatch", "entry_flow", "一级流程分流", RouteName(target),
                             business_intent="consultation" if target == "TASK" else "diagnosis" if target == "DIAGNOSIS" else None,
                             handoff=configured.get("handoff"))
    if configured is None and conversational is not None:
        return EntryDecision("reply", "conversational_rule", "精确问候匹配", **conversational)
    classified = await (classify or classify_business_intent)(message, history, model_id)
    check_cancel(cancel)
    if classified["status"] == "unavailable":
        return EntryDecision("unavailable", "business_llm", classified["reason"],
                             answer="意图识别服务暂时不可用，请稍后重试。")
    result = classified["result"]
    if result["intent"] == "unclear":
        return EntryDecision("clarify", "business_llm", result["reasoning"], answer=result["clarification"])
    return EntryDecision("dispatch", "business_llm", result["reasoning"],
                         RouteName.TASK if result["intent"] == "consultation" else RouteName.DIAGNOSIS,
                         business_intent=result["intent"], resolved_query=result["resolvedQuery"])
