"""build_react_graph 回归测试。

覆盖 langchain_core 1.5.1 下 AIMessage(tool_calls=None) 触发 pydantic
ValidationError 的修复：无 tool_calls 的纯文本回复不应崩溃。
"""

import pytest
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from src.agent.react_graph import build_react_graph
from src.agent.tools.registry import ToolRegistry


class FakeBaseChatModel(BaseChatModel):
    """纯文本回复的 fake 模型 —— 不产出 tool_calls。"""

    model_name: str = "fake"

    @property
    def _llm_type(self) -> str:
        return "fake_base_chat"

    @property
    def _identifying_params(self) -> dict:
        return {"model_name": self.model_name}

    async def _astream(
        self,
        messages: list,
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs,
    ):
        for text in ["摄像头", "权限被拒绝"]:
            if run_manager:
                await run_manager.on_llm_new_token(text)
            yield ChatGenerationChunk(message=AIMessageChunk(content=text))

    async def _agenerate(
        self,
        messages: list,
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs,
    ) -> ChatResult:
        parts = []
        async for c in self._astream(messages, stop, run_manager, **kwargs):
            parts.append(c.message.content)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content="".join(parts),
        ))])

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise NotImplementedError("sync path unused in tests")


@pytest.mark.asyncio
async def test_plain_text_response_does_not_crash():
    """无 tool_calls 的纯文本回复不应触发 AIMessage(tool_calls=None) 校验错误。"""
    graph = build_react_graph(
        model=FakeBaseChatModel(),
        tool_defs=[],
        registry=ToolRegistry(),
        conversation_id="conv-1",
        checkpointer=None,
        max_iterations=3,
    )
    final = await graph.ainvoke({
        "messages": [
            SystemMessage(content="你是核身助手"),
            HumanMessage(content="摄像头被拒绝"),
        ],
        "iteration_count": 0,
    })
    last = final["messages"][-1]
    assert last.content == "摄像头权限被拒绝"
    # 空 tool_calls（而非 None）不应再触发校验错误
    assert last.tool_calls == []
