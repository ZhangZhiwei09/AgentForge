"""模拟监控系统 MCP Streamable HTTP 端点测试。

真实拉起 uvicorn 服务（Streamable HTTP 的 session manager 依赖 uvicorn 的
lifespan 初始化 task group），用 httpx 走真实 HTTP（trust_env=False 避免测试
进程继承系统代理导致 502），覆盖：
- 完整协议流：initialize → notifications/initialized → tools/list → tools/call
- 可选 API Key 认证：未带 Authorization 返回 401，带正确 Bearer 返回 200
"""

import asyncio
import json
import re

import httpx
import pytest
import uvicorn

from src.mcp.monitoring.server import build_app

DEFAULT_TIMEOUT = 10.0


async def _post(client: httpx.AsyncClient, payload: dict, session_id: str | None = None):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    resp = await client.post("/mcp", headers=headers, json=payload)
    sid = resp.headers.get("mcp-session-id")
    text = resp.text.strip()
    if not text:
        return sid, resp.status_code, None
    if text.startswith("event:"):
        matches = re.findall(r"^data: (.*)$", text, re.M)
        text = matches[-1] if matches else "{}"
    return sid, resp.status_code, json.loads(text)


async def _wait_until(predicate, timeout: float = DEFAULT_TIMEOUT) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return False


async def _start_server(api_key: str | None = None) -> tuple[uvicorn.Server, int, asyncio.Task]:
    """启动 uvicorn，端口由系统分配，返回 (server, port, serve_task)。"""
    config = uvicorn.Config(
        build_app(api_key=api_key),
        host="127.0.0.1",
        port=0,
        log_level="error",
        access_log=False,
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    ok = await _wait_until(lambda: server.started is True)
    assert ok, "uvicorn 未在超时时间内启动"
    port = server.servers[0].sockets[0].getsockname()[1]
    return server, port, task


async def _stop_server(server: uvicorn.Server, task: asyncio.Task) -> None:
    server.should_exit = True
    try:
        await asyncio.wait_for(task, timeout=DEFAULT_TIMEOUT)
    except asyncio.TimeoutError:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


INITIALIZE_PAYLOAD = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0.1"},
    },
}


@pytest.mark.asyncio
async def test_full_protocol_flow():
    server, port, task = await _start_server()
    try:
        transport = httpx.AsyncHTTPTransport()
        async with httpx.AsyncClient(
            transport=transport,
            base_url=f"http://127.0.0.1:{port}",
            timeout=DEFAULT_TIMEOUT,
            trust_env=False,
        ) as client:
            # 1. initialize
            sid, status, resp = await _post(client, INITIALIZE_PAYLOAD)
            assert status == 200
            assert resp["result"]["protocolVersion"] == "2025-06-18"
            assert resp["result"]["serverInfo"]["name"] == "agentforge-monitoring"
            assert sid

            # 2. initialized notification（空响应体）
            _, status_n, body = await _post(
                client, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid
            )
            assert status_n in (200, 202)
            assert body is None

            # 3. tools/list：仅暴露 query_trace_log
            _, status_list, tools = await _post(
                client, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid
            )
            assert status_list == 200
            names = [t["name"] for t in tools["result"]["tools"]]
            assert names == ["query_trace_log"]
            assert "traceId" in tools["result"]["tools"][0]["inputSchema"]["properties"]

            # 4. tools/call：命中 trace 返回完整 span 数据
            _, status_call, call = await _post(
                client,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "query_trace_log", "arguments": {"traceId": "abc123"}},
                },
                sid,
            )
            assert status_call == 200
            assert call["result"]["isError"] is False
            envelope = json.loads(call["result"]["content"][0]["text"])
            assert envelope["schemaVersion"] == "1.0"
            assert envelope["data"]["errorCode"] == "FACE_TIMEOUT"
            assert len(envelope["data"]["spans"]) == 5
    finally:
        await _stop_server(server, task)


@pytest.mark.asyncio
async def test_api_key_auth():
    server, port, task = await _start_server(api_key="test-secret")
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}",
            timeout=DEFAULT_TIMEOUT,
            trust_env=False,
        ) as client:
            base_headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            }
            no_auth = await client.post("/mcp", headers=base_headers, json=INITIALIZE_PAYLOAD)
            assert no_auth.status_code == 401

            wrong = await client.post(
                "/mcp",
                headers={**base_headers, "Authorization": "Bearer wrong"},
                json=INITIALIZE_PAYLOAD,
            )
            assert wrong.status_code == 401

            ok = await client.post(
                "/mcp",
                headers={**base_headers, "Authorization": "Bearer test-secret"},
                json=INITIALIZE_PAYLOAD,
            )
            assert ok.status_code == 200
    finally:
        await _stop_server(server, task)


@pytest.mark.asyncio
async def test_no_api_key_by_default():
    """未配置 MCP_API_KEY 时认证关闭，任何请求均可访问。"""
    server, port, task = await _start_server(api_key=None)
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}",
            timeout=DEFAULT_TIMEOUT,
            trust_env=False,
        ) as client:
            resp = await client.post(
                "/mcp",
                headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
                json=INITIALIZE_PAYLOAD,
            )
            assert resp.status_code == 200
    finally:
        await _stop_server(server, task)
