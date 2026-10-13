"""Moving-window HTTP limits without buffering request bodies or SSE streams."""

import logging
import math
import time

from limits import RateLimitItemPerMinute
from limits.aio.storage import MemoryStorage, RedisStorage
from limits.aio.strategies import MovingWindowRateLimiter
from starlette.responses import JSONResponse

from src.config import settings

logger = logging.getLogger(__name__)


class RateLimitMiddleware:
    def __init__(self, app):
        self.app = app
        self.memory = MovingWindowRateLimiter(MemoryStorage())
        self.redis = MovingWindowRateLimiter(RedisStorage(
            f"async+{settings.redis_url}", implementation="redispy",
            socket_connect_timeout=0.5, socket_timeout=0.5,
        )) if settings.rate_limit_redis_enabled else None
        self.redis_retry_at = 0.0

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            async def send_lifespan(message):
                if message["type"] == "lifespan.shutdown.complete" and self.redis:
                    await self.redis.storage.bridge.storage.aclose()
                await send(message)
            await self.app(scope, receive, send_lifespan)
            return
        if scope["type"] != "http" or not settings.rate_limit_enabled or scope.get("path") in {
            "/api/health", "/api/ready",
        }:
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        key = client[0] if client else "unknown"
        item = RateLimitItemPerMinute(settings.rate_limit_max, namespace="agentforge-http")
        limiter = self.redis if self.redis and time.monotonic() >= self.redis_retry_at else self.memory
        try:
            allowed = await limiter.hit(item, key)
            stats = await limiter.get_window_stats(item, key)
        except Exception:
            if limiter is self.memory:
                raise
            logger.exception("Redis rate limit storage unavailable; using local limits for 60 seconds")
            self.redis_retry_at = time.monotonic() + 60
            allowed = await self.memory.hit(item, key)
            stats = await self.memory.get_window_stats(item, key)
        headers = {
            "X-RateLimit-Remaining": str(stats.remaining),
            "X-RateLimit-Reset": str(math.ceil(stats.reset_time)),
        }
        if not allowed:
            retry = max(1, math.ceil(stats.reset_time - time.time()))
            response = JSONResponse({"detail": f"Too many requests. Try again in {retry} seconds."},
                                    status_code=429, headers={**headers, "Retry-After": str(retry)})
            await response(scope, receive, send)
            return

        async def send_with_limits(message):
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), *[
                    (name.lower().encode("ascii"), value.encode("ascii")) for name, value in headers.items()
                ]]
            await send(message)

        await self.app(scope, receive, send_with_limits)
