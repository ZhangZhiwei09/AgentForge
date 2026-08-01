"""AgentExecutor —— 统一的 TASK 路由 ReAct 执行器（LangGraph 版）。

对应 TS: apps/server/src/services/agent-runtime/agent-executor.ts

Phase A 升级：手写 while 循环 → LangGraph StateGraph + astream_events()。

Graph 结构:
    START → agent_node → (有 tool_calls?) → tools_node → agent_node
                           → (无 tool_calls?) → END

流式策略（astream_events v2）:
    - on_chat_model_stream → yield StreamToken（实时流式）
    - on_chat_model_end → 捕获最终回答（含 tool_calls 检查）
    - on_tool_end → 日志记录

不变项（关键约束）:
    - chat.py 的 _to_sse() 和路由分发逻辑 不修改
    - types.py 的 RouteStreamEvent 和 RouteAgent Protocol 不修改
    - StreamMeta → StreamToken* → StreamDone 事件序列 不变
    - 现有 tests/test_agent.py 必须通过
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from src.agent.checkpoint import get_checkpointer
from src.agent.langchain_adapter import ProviderChatModel, _coerce_to_str
from src.agent.react_graph import build_react_graph
from src.agent.tools.registry import ToolRegistry, tool_registry
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

# ── 常量 ──────────────────────────────────────────────────
MAX_ITERATIONS = 5
HARDCODED_FALLBACK = "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。"

# ReAct 系统提示词（中文）
REACT_SYSTEM_PROMPT = """你是核身排障智能助手，专门帮助用户诊断和解决身份核身（人脸核身、活体检测、OCR 识别）相关的技术问题。

## 你的专业领域
- 核身错误码排查（FACE_TIMEOUT、LIVENESS_FAIL、NETWORK_TIMEOUT、SDK_VERSION_TOO_OLD、CAMERA_PERMISSION_DENIED 等）
- SDK 集成诊断（H5、小程序、App 端）
- 商户接入配置与通过率优化
- 核身批量失败应急响应

## 回答规则
1. 先理解用户的问题，提取关键信息（错误码、端类型、产品类型等）
2. 使用 search_knowledge_base 工具查询核身知识库获取排查方案
3. 基于工具返回的知识库内容，用自然语言给出结构化的排查建议
4. 回答要包含：原因分析 → 排查步骤 → 处理方案，使用 Markdown 列表或表格组织
5. 如果知识库没有覆盖用户的问题，如实告知并建议联系技术支持
6. 必要时引导用户补充更多诊断信息（如 trace 日志、SDK 版本、端类型等）

## 重要
- 严格基于知识库返回的内容回答，不要编造任何技术细节
- 每次只调用一个工具，等待结果后再决定下一步
- 如果用户问题不属于核身领域，礼貌说明你的专业范围"""


class AgentExecutor:
    """ReAct Agent 执行器，实现 RouteAgent 协议。

    用法:
        executor = AgentExecutor()
        async for event in executor.execute(context):
            if isinstance(event, StreamToken):
                print(event.content, end="")
            elif isinstance(event, StreamDone):
                break
    """

    route = RouteName.TASK

    def __init__(self, registry: ToolRegistry | None = None) -> None:
        self._registry = registry or tool_registry

    async def execute(
        self,
        context: RouteContext,
        system_prompt: str | None = None,
    ) -> AsyncIterator[RouteStreamEvent]:
        """执行 ReAct Agent 流程（LangGraph StateGraph 驱动）。

        Args:
            context: RouteContext with user_message, conversation_id, etc.
            system_prompt: Optional custom system prompt.
        """
        assistant_msg_id = context.assistant_msg_id
        resolved_model = context.resolved_model

        # ── 发送 meta ──
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
            # ── 解析 Provider + Model ──
            resolved = resolve_model(resolved_model)
            provider = get_provider(resolved["provider_name"])
            model_id = resolved["model_id"]

            # ── 获取工具定义 ──
            # 注册中心在此 init（幂等），确保工具就绪
            self._registry.init()
            tool_defs = self._to_openai_tools(self._registry.get_definitions())

            # ── 构建 LangChain 模型适配器 ──
            model = ProviderChatModel(
                provider=provider,
                model_name=model_id,
                temperature=0.7,
                max_tokens=4096,
            )

            effective_system_prompt = (
                system_prompt if system_prompt else REACT_SYSTEM_PROMPT
            )

            # ── 获取 Checkpointer ──
            checkpointer = await get_checkpointer()

            # ── 构建 LangGraph StateGraph ──
            graph = build_react_graph(
                model=model,
                tool_defs=tool_defs,
                system_prompt=effective_system_prompt,
                registry=self._registry,
                conversation_id=context.conversation_id,
                checkpointer=checkpointer,
                max_iterations=MAX_ITERATIONS,
            )

            # ── 初始状态 ──
            # 优先使用 ContextBuilder 预组装的消息（含历史 + 摘要）
            # 否则回退到简单模式：System Prompt + 当前用户消息
            from langchain_core.messages import HumanMessage, SystemMessage

            if context.prebuilt_messages:
                initial_state: AgentState = {
                    "messages": list(context.prebuilt_messages),
                    "iteration_count": 0,
                }
            else:
                initial_state: AgentState = {
                    "messages": [
                        SystemMessage(content=effective_system_prompt),
                        HumanMessage(content=context.user_message),
                    ],
                    "iteration_count": 0,
                }

            # ── 流式执行 ──
            final_answer = ""
            final_answer_collected = False

            config = {"configurable": {"thread_id": context.conversation_id}}

            async for event in graph.astream_events(
                initial_state,
                config=config,
                version="v2",
            ):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    chunk = event["data"]["chunk"]
                    content = getattr(chunk, "content", None)
                    if content:
                        text = _coerce_to_str(content)
                        if text:
                            yield StreamToken(
                                content=text,
                                message_id=assistant_msg_id,
                            )
                            # 让出事件循环，确保 SSE 数据刷新到网络层
                            await asyncio.sleep(0)

                elif kind == "on_chat_model_end":
                    output = event["data"]["output"]
                    # output 是聚合后的 AIMessage
                    if hasattr(output, "content") and output.content:
                        content_text = _coerce_to_str(output.content)
                        if content_text:
                            final_answer = content_text
                            final_answer_collected = True

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    tool_output = event["data"].get("output", "")
                    logger.info(
                        "Tool executed: %s, output preview: %.100s",
                        tool_name,
                        str(tool_output),
                    )

            # ── Fallback ──
            if not final_answer_collected or not final_answer:
                for char in HARDCODED_FALLBACK:
                    yield StreamToken(content=char, message_id=assistant_msg_id)
                    await asyncio.sleep(0)

            # ── Done ──
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=not final_answer_collected or not bool(final_answer),
            )

        except Exception as exc:
            logger.error("AgentExecutor failed: %s", exc)
            yield StreamError(content=str(exc))
            for char in HARDCODED_FALLBACK:
                yield StreamToken(content=char, message_id=assistant_msg_id)
                await asyncio.sleep(0)
            yield StreamDone(
                message_id=assistant_msg_id,
                usage={},
                route=self.route.value,
                fallback_used=True,
            )

    # ── 工具方法 ──────────────────────────────────────────

    @staticmethod
    def _to_openai_tools(definitions) -> list[dict]:
        """将 ToolDefinition 列表转为 OpenAI function calling 格式。"""
        tools: list[dict] = []
        for d in definitions:
            tools.append({
                "type": d.type,
                "function": {
                    "name": d.function.name,
                    "description": d.function.description,
                    "parameters": d.function.parameters,
                },
            })
        return tools
