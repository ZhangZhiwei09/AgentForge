"""AgentState —— LangGraph ReAct 循环的状态定义。

对应本方案 Phase A 的 Graph 结构:
    START → agent_node → (有 tool_calls?) → tools_node → agent_node
                           → (无 tool_calls?) → END

AgentState 是 LangGraph StateGraph 的核心类型，使用 TypedDict 定义。
messages 字段使用 add_messages reducer（默认行为），自动追加而非覆盖。
"""

from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


class AgentState(TypedDict):
    """Agent ReAct 循环的内部状态。

    Attributes:
        messages: 对话消息列表。使用 add_messages reducer，
                  新消息自动追加到末尾（而非覆盖）。
        iteration_count: 当前 ReAct 迭代次数，用于截断保护。
    """

    messages: Annotated[list[BaseMessage], add_messages]
    iteration_count: int
