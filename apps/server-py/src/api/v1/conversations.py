"""会话管理 API —— 历史 / 列表 / 删除 / FAQ / 兼容别名。

与聊天执行解耦：聊天端点（POST /api/v1/chat、POST /api/agent/chat）留在
chat.py，这里只负责会话资源的管理。共享的会话查询/序列化辅助函数也放在此，
供 chat.py 复用。
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import ANONYMOUS_USER_ID, get_chat_user, get_current_user, get_db
from src.models.chat import Conversation, Message
from src.models.user import User


async def _find_conversation(
    db: AsyncSession, conv_id: str, *, conv_type: str | None = None,
    user_id: str | None = None,
) -> Conversation | None:
    """先查主键并校验归属，再按用户与类型查旧 session_id。"""
    conv = await db.scalar(select(Conversation).where(Conversation.id == conv_id))
    if conv is not None:
        if user_id is not None and conv.user_id != user_id:
            raise HTTPException(403, "无权访问此会话")
        if conv_type is not None and conv.type != conv_type:
            raise HTTPException(400, "会话类型不匹配")
        return conv
    if user_id is None:
        return None
    stmt = select(Conversation).where(
        Conversation.session_id == conv_id, Conversation.user_id == user_id,
    )
    if conv_type is not None:
        stmt = stmt.where(Conversation.type == conv_type)
    return await db.scalar(stmt.order_by(Conversation.created_at, Conversation.id).limit(1))


def _serialize_message(m: Message) -> dict:
    """消息 → API 输出 dict（多个端点复用的统一序列化）。"""
    return {
        "id": m.id,
        "role": m.role,
        "type": m.type,
        "content": m.content,
        "timestamp": m.created_at.isoformat(),
        "metadata": m.msg_metadata,
    }


def _is_internal_diagnosis_message(m: Message) -> bool:
    """过滤历史中误持久化的多 Agent 内部提示和调试上下文。"""
    if m.role != "assistant":
        return False
    return any(
        marker in m.content
        for marker in (
            "Blackboard（共享上下文）",
            "你是核身业务前端排查专家",
            "你是核身业务后端排查专家",
            "你是核身诊断的质量评估与汇总专家",
        )
    )


# ═══════════════════════════════════════════════════════════
# /api/agent/chat —— 会话资源端点（聊天 POST 在 chat.py）
# ═══════════════════════════════════════════════════════════

agent_chat_router = APIRouter(prefix="/api/agent/chat", tags=["agent-chat"])


@agent_chat_router.get("/history")
async def agent_chat_history(
    user: Annotated[User, Depends(get_chat_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    conversation_id: Annotated[str | None, Query(max_length=64)] = None,
    session_id: Annotated[str | None, Query(max_length=64)] = None,
    before_time: Annotated[datetime | None, Query(description="游标：ISO 时间戳")] = None,
    before_id: Annotated[str | None, Query(max_length=36)] = None,
    limit: Annotated[int | None, Query(ge=1, le=100)] = None,
):
    """获取会话消息历史，支持复合游标分页。

    首次加载：只传 conversation_id + limit
    翻页：传 conversation_id + limit + before_time + before_id
    """
    # 验证 ownership
    lookup_id = conversation_id or session_id
    if not lookup_id:
        raise HTTPException(400, "缺少 conversation_id 参数")
    if (before_time is None) != (before_id is None):
        raise HTTPException(400, "游标需要同时提供 before_time 和 before_id")
    if before_time is not None and before_time.tzinfo is None:
        before_time = before_time.replace(tzinfo=UTC)
    conv = await _find_conversation(db, lookup_id, conv_type="agent_chat", user_id=user.id)
    if conv is None:
        return {"conversation_id": lookup_id, "messages": [], "has_more": False, "next_cursor": None}
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权访问此会话")

    # 构建查询
    conditions = [Message.conversation_id == conv.id]

    if before_time and before_id:
        # 复合游标：(created_at, id) < (cursor_time, cursor_id)
        conditions.append(
            or_(
                Message.created_at < before_time,
                and_(Message.created_at == before_time, Message.id < before_id),
            )
        )

    # Legacy TS callers expect full history when no pagination is requested.
    page_limit = limit if limit is not None else (5 if before_time is not None else None)
    query = (
        select(Message)
        .where(and_(*conditions))
        .order_by(Message.created_at.desc(), Message.id.desc())
    )
    if page_limit is not None:
        query = query.limit(page_limit + 1)

    result = await db.execute(query)
    rows = result.scalars().all()

    has_more = page_limit is not None and len(rows) > page_limit
    if has_more:
        rows = rows[:page_limit]

    # 反序恢复时间升序（前端展示用）
    rows = list(reversed(rows))

    messages = [
        _serialize_message(m) for m in rows
        if not _is_internal_diagnosis_message(m)
    ]

    next_cursor = None
    if has_more and rows:
        oldest = rows[0]
        next_cursor = {
            "before_time": oldest.created_at.isoformat(),
            "before_id": oldest.id,
        }

    return {
        "conversation_id": conv.id,
        "session_id": conv.session_id,
        "created_at": conv.created_at.isoformat(),
        "intent": conv.intent,
        "messages": messages,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


@agent_chat_router.get("/conversations")
async def agent_conversations(
    user: Annotated[User, Depends(get_chat_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    session_id: Annotated[str | None, Query(max_length=64)] = None,
):
    """返回当前用户所有 agent_chat 会话，按更新时间倒序。"""
    if user.id == ANONYMOUS_USER_ID and not session_id:
        return {"conversations": []}
    query = (
        select(Conversation)
        .where(
            Conversation.user_id == user.id,
            Conversation.type == "agent_chat",
        )
        .order_by(Conversation.updated_at.desc())
    )
    if user.id == ANONYMOUS_USER_ID:
        query = query.where(Conversation.session_id == session_id).limit(1)
    result = await db.execute(query)
    conversations = result.scalars().all()

    conv_list = []
    for conv in conversations:
        # 获取首条用户消息作为预览
        first_msg_result = await db.execute(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.created_at.asc())
        )
        first_msg = next(
            (
                m.content
                for m in first_msg_result.scalars().all()
                if not _is_internal_diagnosis_message(m)
            ),
            None,
        )

        conv_list.append({
            "id": conv.id,
            "title": conv.title,
            "conversation_id": conv.id,
            "session_id": conv.session_id,
            "created_at": conv.created_at.isoformat(),
            "updated_at": conv.updated_at.isoformat(),
            "first_message": first_msg[:100] if first_msg else None,
        })

    return {"conversations": conv_list}


@agent_chat_router.delete("/conversations/{conv_id}")
async def agent_delete_conversation(
    conv_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """删除会话 —— 验证 ownership 后级联删除。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除此会话")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# /api/conversations —— 向后兼容别名
# ═══════════════════════════════════════════════════════════

conversations_router = APIRouter(prefix="/api", tags=["conversations"])


@conversations_router.get("/conversations")
async def list_conversations(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """会话列表 —— GET /api/conversations（向后兼容）。"""
    result = await db.execute(
        select(Conversation.id, Conversation.title, Conversation.session_id, Conversation.created_at, Conversation.updated_at)
        .where(
            Conversation.user_id == user.id,
            Conversation.type == "agent_chat",
        )
        .order_by(Conversation.updated_at.desc())
    )
    rows = result.all()
    return {
        "conversations": [
            {
                "id": row.id,
                "title": row.title,
                "session_id": row.session_id,
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
                "first_message": None,
            }
            for row in rows
        ]
    }


@conversations_router.get("/conversations/{conv_id}/messages")
async def get_conversation_messages(
    conv_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """获取会话消息列表 —— GET /api/conversations/:id/messages（向后兼容）。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None or conv.user_id != user.id:
        return {"conversation_id": conv_id, "messages": []}

    msg_result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv_id)
        .order_by(Message.created_at.asc())
    )
    messages = [
        m for m in msg_result.scalars().all()
        if not _is_internal_diagnosis_message(m)
    ]
    return {
        "conversation_id": conv_id,
        "messages": [_serialize_message(m) for m in messages],
    }


@conversations_router.delete("/conversations/{conv_id}")
async def delete_conversation_alias(
    conv_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """删除会话 —— DELETE /api/conversations/:id（向后兼容）。"""
    conv = await _find_conversation(db, conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权删除此会话")

    await db.delete(conv)
    await db.commit()
    return {"ok": True}
