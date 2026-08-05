"""模拟监控系统数据契约。

TraceLog 描述一笔核身请求的完整分布式链路：多服务节点 span、各阶段耗时、
状态、错误码与诊断建议。span 由 gateway / face-algorithm / liveness-check /
camera-service / sdk-bridge 等节点组成。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Product = Literal["liveness", "face_verify", "ocr", "realname"]
ClientType = Literal["h5", "app", "mini_program", "web"]
SpanStatus = Literal["ok", "error", "timeout"]
OverallStatus = Literal["success", "failed", "timeout"]

SCHEMA_VERSION = "1.0"


class TraceSpan(BaseModel):
    """单个服务节点的调用 span。"""

    spanId: str
    serviceName: str = Field(description="服务节点：gateway / face-algorithm / liveness-check / camera-service / sdk-bridge")
    operationName: str = Field(description="节点内操作名，如 liveness_detect、frame_capture")
    startTime: str = Field(description="ISO 8601 起始时间")
    endTime: str = Field(description="ISO 8601 结束时间")
    durationMs: int = Field(ge=0, description="该节点耗时（毫秒）")
    status: SpanStatus
    errorCode: str | None = None
    errorMessage: str | None = None
    tags: dict[str, str] = Field(default_factory=dict, description="附加标签，如 cpuUsage、queueDepth、sdkVersion")


class TraceLog(BaseModel):
    """单笔核身请求的完整链路日志。"""

    traceId: str
    orderId: str
    product: Product
    clientType: ClientType
    sdkVersion: str
    overallDurationMs: int = Field(ge=0, description="整体耗时（毫秒）")
    overallStatus: OverallStatus
    errorCode: str | None = None
    errorStage: str | None = Field(default=None, description="失败发生的业务阶段，如 face_capture")
    spans: list[TraceSpan] = Field(default_factory=list)
    conclusion: str = Field(description="诊断建议（中文）")
