"""Regression coverage for filtering persisted diagnosis internals."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from src.api.v1.conversations import agent_chat_history
from src.models.chat import Message


async def test_filtered_page_keeps_cursor_for_older_messages(monkeypatch):
    conversation = SimpleNamespace(user_id="user-1")
    monkeypatch.setattr(
        "src.api.v1.conversations._find_conversation",
        AsyncMock(return_value=conversation),
    )
    created_at = datetime(2026, 10, 9, 10, 0)
    rows = [
        Message(
            id=id_,
            conversation_id="conv-1",
            role="assistant",
            type="text",
            content="Blackboard（共享上下文）",
            created_at=created_at,
        )
        for id_ in ("m3", "m2", "m1")
    ]
    query_result = MagicMock()
    query_result.scalars.return_value.all.return_value = rows
    db = SimpleNamespace(execute=AsyncMock(return_value=query_result))

    result = await agent_chat_history(
        conversation_id="conv-1",
        before_time=None,
        before_id=None,
        limit=2,
        user=SimpleNamespace(id="user-1"),
        db=db,
    )

    assert result["messages"] == []
    assert result["has_more"] is True
    assert result["next_cursor"] == {
        "before_time": created_at.isoformat(),
        "before_id": "m2",
    }
