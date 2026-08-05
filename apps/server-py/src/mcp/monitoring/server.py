"""模拟监控系统 MCP Server —— MCP 协议层。

- 使用 MCP SDK 的 MCPServer + Streamable HTTP 传输，监听 127.0.0.1。
- 暴露单一工具 query_trace_log（业务处理见 tools.py，数据源见 repository.py）。
- 可选 API Key 认证：设置环境变量 MCP_API_KEY 后，所有 /mcp 请求必须携带
  `Authorization: Bearer <key>`，否则返回 401。开发环境不设置即为关闭。

生命周期：由部署环境负责启动（dev 用 `uv run python -m src.mcp.monitoring.server`，
生产用 docker-compose / k8s），调用方（TS 服务）不主动 spawn 本进程。

启动：
    uv run python -m src.mcp.monitoring.server --port 3100
"""

from __future__ import annotations

import argparse
import hmac
import os

import uvicorn
from starlette.responses import Response

from .schemas import SCHEMA_VERSION
from .tools import TOOL_DESCRIPTION, TOOL_NAME, handle_query_trace_log

DEFAULT_PORT = 3100
DEFAULT_HOST = "127.0.0.1"


class ApiKeyMiddleware:
    """可选 API Key 认证中间件。

    仅当 api_key 非空时生效：校验 `Authorization: Bearer <key>`。
    使用 hmac.compare_digest 做常量时间比较，避免时序侧信道。
    """

    def __init__(self, app, api_key: str) -> None:
        self.app = app
        self.api_key = api_key
        self.expected = f"Bearer {api_key}"

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            headers = {k.lower(): v for k, v in scope["headers"]}
            auth_header = headers.get(b"authorization", b"").decode("latin-1")
            if not hmac.compare_digest(auth_header, self.expected):
                response = Response("Unauthorized", status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_server():
    """创建并注册工具的 MCPServer 实例。"""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        name="agentforge-monitoring",
        version=SCHEMA_VERSION,
        description="模拟核身监控系统，提供单笔 trace 链路日志查询。",
    )
    server.tool(
        name=TOOL_NAME,
        description=TOOL_DESCRIPTION,
        title="查询链路日志",
    )(handle_query_trace_log)
    return server


def build_app(host: str = DEFAULT_HOST, api_key: str | None = None):
    """构建 Starlette 应用（Streamable HTTP + 可选认证中间件）。"""
    server = create_server()
    app = server.streamable_http_app(streamable_http_path="/mcp", host=host)
    if api_key:
        app.add_middleware(ApiKeyMiddleware, api_key=api_key)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="模拟监控系统 MCP Server")
    parser.add_argument("--host", type=str, default=os.environ.get("MCP_MONITORING_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MCP_MONITORING_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    api_key = os.environ.get("MCP_API_KEY")
    uvicorn.run(
        build_app(host=args.host, api_key=api_key),
        host=args.host,
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
