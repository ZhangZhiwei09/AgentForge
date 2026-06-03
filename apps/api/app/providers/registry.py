from app.providers.base import LLMProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.config import settings

_providers: dict[str, LLMProvider] = {}


def _init_providers() -> None:
    global _providers
    if settings.openai_api_key:
        _providers["openai"] = OpenAIProvider(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )
    if settings.deepseek_api_key:
        _providers["deepseek"] = DeepSeekProvider(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
        )


def get_provider(name: str) -> LLMProvider:
    if not _providers:
        _init_providers()
    provider = _providers.get(name)
    if provider is None:
        raise ValueError(f"Provider '{name}' not configured")
    return provider


def list_providers() -> list[dict]:
    if not _providers:
        _init_providers()
    result = []
    for name, p in _providers.items():
        result.append({"type": name, "models": p.list_models()})
    return result


def _first_provider() -> str:
    """Return the first configured provider name."""
    if not _providers:
        _init_providers()
    if not _providers:
        raise ValueError("No LLM providers configured")
    return next(iter(_providers.keys()))


def resolve_model(model_id: str | None = None) -> tuple[str, str]:
    """Return (provider_name, resolved_model_id)."""
    if not _providers:
        _init_providers()

    if model_id:
        for name, p in _providers.items():
            for m in p.list_models():
                if m["id"] == model_id:
                    return name, model_id
        # If model not found in any configured provider, use first available
        return _first_provider(), model_id

    return _first_provider(), settings.default_model
