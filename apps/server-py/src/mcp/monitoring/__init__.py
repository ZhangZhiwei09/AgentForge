"""模拟监控系统 MCP Server。

分层职责：
- repository.py: 数据来源（mock trace 数据集）。未来接入真实监控平台时，在此新增
  真实数据源实现，Agent → MCP → repository 的接缝保持不变。
- schemas.py:   数据契约（Pydantic 模型 + schemaVersion）。
- tools.py:     MCP tool 的无状态处理函数（薄，只做校验 + 转发 repository）。
- server.py:    MCP 协议层（Streamable HTTP 入口 + 可选 API Key 认证）。

生命周期约定：本 server 由部署环境负责启动（dev 用脚本/turbo task，生产用
docker-compose/k8s），调用方（TS 服务）绝不主动 spawn 本进程。
"""

SCHEMA_VERSION = "1.0"

__all__ = ["SCHEMA_VERSION"]
