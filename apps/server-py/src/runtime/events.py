"""EventBus —— 基于 asyncio.Queue 的运行时事件总线。

对应 TS: 无直接对应（TS 端事件系统分布在 controller.ts 的 listeners 和 buffer.ts 中）。

设计要点：
- 发布/订阅模式（pub/sub），解耦执行节点与下游消费者
- 基于 asyncio.Queue：订阅者通过 async for 消费事件
- 支持按事件类型过滤（node:start, node:complete, node:fail, node:cancel, buffer:append 等）
- unsubscribe 防止内存泄漏

Python 新概念：
- asyncio.Queue：asyncio 原生队列，支持 async put/get，适合生产者-消费者模式
- async generator：subscribe() 返回 AsyncIterator，消费者用 async for 消费
"""

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum


class RuntimeEventType(StrEnum):
    """运行时事件类型。"""
    NODE_START = "node:start"
    NODE_COMPLETE = "node:complete"
    NODE_FAIL = "node:fail"
    NODE_CANCEL = "node:cancel"
    NODE_TIMEOUT = "node:timeout"
    STATE_CHANGE = "node:state_change"
    BUFFER_APPEND = "buffer:append"
    BUFFER_CLEAR = "buffer:clear"


@dataclass(slots=True)
class RuntimeEvent:
    """运行时事件。

    Attributes:
        type: 事件类型（见 RuntimeEventType）
        node_id: 触发事件的节点 ID
        data: 附加数据（如 token 内容、状态变更详情等）
        timestamp: 事件发生时间（monotonic 秒）
    """
    type: str
    node_id: str
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.monotonic)


class EventBus:
    """运行时事件总线。

    用法:
        bus = EventBus()

        # 发布
        bus.publish(RuntimeEvent(type="node:start", node_id="abc"))

        # 订阅
        async for event in bus.subscribe("node:start"):
            print(f"Node {event.node_id} started")
    """

    def __init__(self) -> None:
        self._queues: dict[str, list[asyncio.Queue[RuntimeEvent | None]]] = {}

    def publish(self, event: RuntimeEvent) -> None:
        """同步发布事件（非阻塞 put_nowait）。

        将事件放入所有匹配类型的订阅者队列。
        如果队列已满（极少发生），丢弃事件以避免阻塞 Runtime。
        """
        for queue in self._queues.get(event.type, []):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # 队列已满时丢弃，不阻塞 Runtime 主流程
                pass

    def subscribe(
        self, event_type: str
    ) -> "asyncio.Queue[RuntimeEvent | None]":
        """订阅指定类型的事件，返回 asyncio.Queue。

        消费者用 async for 消费：
            queue = bus.subscribe("node:start")
            while True:
                event = await queue.get()
                if event is None:  # None = 停止信号
                    break
                # 处理 event
        """
        queue: asyncio.Queue[RuntimeEvent | None] = asyncio.Queue()
        self._queues.setdefault(event_type, []).append(queue)
        return queue

    def unsubscribe(self, event_type: str, queue: "asyncio.Queue[RuntimeEvent | None]") -> None:
        """取消订阅，防止内存泄漏。"""
        queues = self._queues.get(event_type)
        if queues and queue in queues:
            queues.remove(queue)
            # 清理空列表
            if not queues:
                del self._queues[event_type]

    def close(self, event_type: str | None = None) -> None:
        """关闭指定类型的全部订阅（放入 None 哨兵通知消费者退出）。

        event_type 为 None 时关闭所有类型。
        """
        types = [event_type] if event_type else list(self._queues.keys())
        for etype in types:
            for queue in self._queues.get(etype, []):
                try:
                    queue.put_nowait(None)  # 哨兵：通知消费者停止
                except asyncio.QueueFull:
                    pass
            if etype in self._queues:
                del self._queues[etype]

    @property
    def subscriber_count(self) -> int:
        """当前订阅者总数（用于调试）。"""
        return sum(len(qs) for qs in self._queues.values())
