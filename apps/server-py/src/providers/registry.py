"""Provider 注册中心 —— 管理 LLM 厂商的实例化和查找。

对应 TS: apps/server/src/providers/registry.ts

这一版先不做 Circuit Breaker（熔断器），留到 Step 10 统一加。
DeepSeek 也不在这一版做——只有 OpenAI。

Python 新概念：
- 模块级私有变量 _providers / _initialized（前导下划线 = Python 约定 "请勿直接访问"）
- 惰性初始化（lazy init）：第一次调用 get_provider 时才初始化，不是 import 时
"""

from src.config import settings
from src.providers.base import LLMProvider
from src.providers.openai_provider import OpenAIProvider

# 模块级私有状态
_providers: dict[str, LLMProvider] = {}
_initialized: bool = False


def _init_providers() -> None:
    """惰性初始化：根据 .env 中有无 API Key 决定是否注册 Provider。

    只在第一次调用时执行，后续调用直接跳过。
    """
    global _providers, _initialized
    if _initialized:
        return

    if settings.openai_api_key:
        _providers["openai"] = OpenAIProvider(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )

    _initialized = True


def get_provider(name: str) -> LLMProvider:
    """按名称获取 Provider。

    Args:
        name: Provider 名称，例如 "openai"

    Returns:
        LLMProvider 实例

    Raises:
        ValueError: Provider 未配置（API Key 为空 或 名称不存在）
    """
    _init_providers()
    provider = _providers.get(name)
    if provider is None:
        raise ValueError(f"Provider '{name}' not configured")
    return provider


def list_providers() -> list[dict]:
    """列出所有可用 Provider 及其支持的模型。

    返回格式对应 TS listProviders() 的返回值，
    供前端 /api/providers 端点使用。
    """
    _init_providers()
    result: list[dict] = []
    for name, p in _providers.items():
        result.append({"type": name, "models": p.list_models()})
    return result


def first_provider() -> str:
    """返回第一个可用 Provider 的名称。

    Raises:
        ValueError: 没有配置任何 Provider
    """
    _init_providers()
    if not _providers:
        raise ValueError("No LLM providers configured")
    return next(iter(_providers.keys()))


def resolve_model(model_id: str | None = None) -> dict:
    """解析模型 ID → {provider_name, model_id}。

    对应 TS 的 resolveModel()，返回结构化 dict 而非元组。

    规则：
    1. 如果没传 model_id，用 settings.default_model
    2. 在所有 Provider 的模型列表中搜索
    3. 找不到则回退到第一个 Provider 的第一个模型

    Args:
        model_id: 模型 ID，例如 "gpt-4o-mini"，None 表示用默认

    Returns:
        {"provider_name": "openai", "model_id": "gpt-4o-mini"}
    """
    _init_providers()

    target_model = model_id or settings.default_model

    # 在所有 Provider 的模型列表中搜索
    for name, p in _providers.items():
        for m in p.list_models():
            if m["id"] == target_model:
                return {"provider_name": name, "model_id": target_model}

    # 兜底：使用请求的模型名 + 第一个可用 Provider
    #（不强制限制为 known models，兼容 DeepSeek 等 OpenAI 兼容 API）
    first = first_provider()
    return {"provider_name": first, "model_id": target_model}
