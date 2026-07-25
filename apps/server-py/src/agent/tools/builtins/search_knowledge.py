"""搜索知识库工具 —— 内置占位工具。

对应 TS: apps/server/src/tools/builtin/search-knowledge-base.ts

当前版本：占位实现（Step 11 RAG 阶段实现真正的向量检索）。
返回模拟结果，让 ReAct 循环能跑通。
"""

from src.agent.tools.base import (
    RegisteredTool,
    RiskLevel,
    ToolDefinition,
    ToolFunction,
)


async def search_knowledge_execute(args: dict, run_id: str) -> dict:
    """搜索知识库（占位实现）。

    Step 11 将替换为真正的 Embedding + pgvector 向量检索。
    """
    query = args.get("query", "")
    if not query:
        return {"status": "failed", "error": "搜索词不能为空"}

    # 占位：返回模拟结果
    return {
        "status": "success",
        "output": (
            f'{{"found": true, "query": "{query}", '
            f'"results": ['
            f'{{"content": "[占位] 知识库尚未配置。搜索词: {query}。请在 Step 11 配置 RAG 后获得真实结果。", "score": 0.5, "docTitle": "占位文档"}}'
            f'], "total": 1}}'
        ),
    }


search_knowledge_tool = RegisteredTool(
    definition=ToolDefinition(
        type="function",
        function=ToolFunction(
            name="search_knowledge_base",
            description="搜索知识库。使用此工具查找产品文档、FAQ、政策规则等内部知识。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索查询词，使用用户原始提问中的关键词",
                    },
                },
                "required": ["query"],
            },
        ),
    ),
    execute=search_knowledge_execute,
    risk_level=RiskLevel.READ_ONLY,
    timeout=15000,
    require_approval=False,
    category="search",
    parallelizable=True,
)
