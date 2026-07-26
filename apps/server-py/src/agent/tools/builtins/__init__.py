"""内置工具集 —— Runtime 核心工具。

对应 TS: apps/server/src/tools/builtins.ts
"""

from src.agent.tools.builtins.search_knowledge import search_knowledge_tool

__all__ = ["search_knowledge_tool"]
