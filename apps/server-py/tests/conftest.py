import pytest

from src.config import settings
from tests.entry_fixtures import empty_postgres, entry_api

__all__ = ["empty_postgres", "entry_api"]


@pytest.fixture
def monitoring_demo(monkeypatch):
    """Opt into synthetic evidence only in tests that exercise demo diagnosis."""
    monkeypatch.setattr(settings, "monitoring_mode", "mock")
