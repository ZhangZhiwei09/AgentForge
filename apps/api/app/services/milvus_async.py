"""Milvus 同步操作的异步封装。

pymilvus 是同步库，在高并发下会阻塞 FastAPI 事件循环。
所有 Milvus 调用通过全局线程池委托执行，避免阻塞。
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor

_milvus_executor = ThreadPoolExecutor(
    max_workers=4,
    thread_name_prefix="milvus-",
)


async def run_milvus(func, *args, **kwargs):
    """在线程池中执行同步的 Milvus 函数，避免阻塞事件循环。

    用法:
        result = await run_milvus(collection.insert, entities)
        result = await run_milvus(collection.search, data=[vec], ...)
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _milvus_executor,
        lambda: func(*args, **kwargs),
    )
