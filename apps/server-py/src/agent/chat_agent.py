"""ChatAgent —— CHAT 路由的轻量 Agent（无工具、无 ReAct 循环）。

对应 TS: apps/server/src/services/agent-runtime/chat-agent.ts

设计要点:
    - 直接使用 ProviderChatModel.astream()，不使用 LangGraph StateGraph
    - 不注册工具，不检查 tool_calls
    - 单次 LLM 调用 → 流式输出 → Done
    - 遵循项目规范：中文 system prompt、禁止静默吞错
"""

import asyncio
import logging

from src.agent.langchain_adapter import ProviderChatModel, _coerce_to_str
from src.agent.types import (
    RouteContext,
    RouteName,
    RouteStreamEvent,
    StreamDone,
    StreamError,
    StreamMeta,
    StreamToken,
)
from src.providers.registry import get_provider, resolve_model

logger = logging.getLogger(__name__)

CHAT_SYSTEM_PROMPT = """你是一个友好、专业的AI助手。请用简洁清晰的中文回答用户的问题。

## 你的能力
- 回答各类知识性问题
- 进行自然、友好的对话
- 提供有用的建议和信息

## 回答规则
1. 保持回答简洁、有条理
2. 如果问题超出你的知识范围，如实告知
3. 语气友好但不啰嗦
4. 使用中文回复"""

FALLBACK_MESSAGE = "抱歉，我暂时无法回答这个问题。"


class ChatAgent:
    """CHAT 路由 Agent —— 轻量级单轮对话。

    实现 RouteAgent 协议:
        route = RouteName.CHAT

    用法:
        agent = ChatAgent()
        async for event in agent.execute(context):
            if isinstance(event, StreamToken):
                print(event.content, end="")
    """

    route = RouteName.CHAT

    async def execute(
        self,
        context: RouteContext,
        system_prompt: str | None = None,
    ) -> RouteStreamEvent:
        """执行 CHAT Agent 流程。

        Args:
            context: RouteContext with user_message, conversation_id, etc.
            system_prompt: Optional custom system prompt.
        """
        assistant_msg_id = context.assistant_msg_id
        resolved_model = context.resolved_model

        yield StreamMeta(
            message_id=assistant_msg_id,
            conversation_id=context.conversation_id,
            session_id=context.session_id,
            model=resolved_model,
            provider=context.provider_name,
            route=self.route.value,
            intent=context.intent,
        )

        try:
            resolved = resolve_model(resolved_model)
            provider = get_provider(resolved["provider_name"])

            model = ProviderChatModel(
                provider=provider,
                model_name=resolved["model_id"],
                temperature=0.7,
                max_tokens=4096,
            )

            from langchain_core.messages import HumanMessage, SystemMessage

            effective_system_prompt = (
                system_prompt if system_prompt else CHAT_SYSTEM_PROMPT
            )

            messages = [
                SystemMessage(content=effective_system_prompt),
                HumanMessage(content=context.user_message),
            ]

            answer_collected = ""

            async for chunk in model.astream(messages, tools=None):
                if chunk.content:
                    text = _coerce_to_str(chunk.content)
                    if text:
                        answer_collected += text
                        yield StreamToken(
                            content=text,
                            message_id=assistant_msg_id,
                        )
                        await asyncio.sleep(0)

            if not answer_collected:
                for char in FALLBACK_MESSAGE:
                    yield StreamToken(content=char, message_id=assistant_msg_id)
                    await asyncio.sleep(0)

            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=not bool(answer_collected),
            )

        except Exception as exc:
            logger.error("ChatAgent failed: %s", exc)
            yield StreamError(content=str(exc))
            fallback = "抱歉，服务暂时不可用，请稍后再试。"
            for char in fallback:
                yield StreamToken(content=char, message_id=assistant_msg_id)
                await asyncio.sleep(0)
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=True,
            )
