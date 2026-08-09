"""路由模块 —— L1-L5 五层路由管线（对齐 TS routing/）。"""

from src.agent.router.pipeline import QueryRouter, quick_route_scan

__all__ = ["QueryRouter", "quick_route_scan"]
