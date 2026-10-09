"""会话管理 API —— 历史 / 列表 / 删除 / FAQ / 兼容别名。

与聊天执行解耦：聊天端点（POST /api/v1/chat、POST /api/agent/chat）留在
chat.py，这里只负责会话资源的管理。共享的会话查询/序列化辅助函数也放在此，
供 chat.py 复用。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, select
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_current_user, get_db
from src.models.chat import Conversation, Message
from src.models.user import User


async def _find_conversation(
    db: AsyncSession, conv_id: str, *, conv_type: str | None = None
) -> Conversation | None:
    """按 id 查询会话，可选按类型过滤；不存在返回 None。

    注意：不做归属校验，调用方按各自语义处理 403/404 或返回空。
    """
    stmt = select(Conversation).where(Conversation.id == conv_id)
    if conv_type is not None:
        stmt = stmt.where(Conversation.type == conv_type)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def _serialize_message(m: Message) -> dict:
    """消息 → API 输出 dict（多个端点复用的统一序列化）。"""
    return {
        "id": m.id,
        "role": m.role,
        "type": m.type,
        "content": m.content,
        "timestamp": m.created_at.isoformat(),
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
    conversation_id: str = Query(..., description="会话 ID"),
    before_time: str | None = Query(None, description="游标：ISO 时间戳"),
    before_id: str | None = Query(None, description="游标：消息 ID"),
    limit: int = Query(5, ge=1, le=20, description="每页条数"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取会话消息历史，支持复合游标分页。

    首次加载：只传 conversation_id + limit
    翻页：传 conversation_id + limit + before_time + before_id
    """
    # 验证 ownership
    conv = await _find_conversation(db, conversation_id, conv_type="agent_chat")
    if conv is None:
        return {"conversation_id": conversation_id, "messages": [], "has_more": False}
    if conv.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权访问此会话")

    # 构建查询
    conditions = [Message.conversation_id == conversation_id]

    if before_time and before_id:
        # 复合游标：(created_at, id) < (cursor_time, cursor_id)
        cursor_time = datetime.fromisoformat(before_time)
        conditions.append(
            sa_text(
                "(messages.created_at, messages.id) < (:cursor_time, :cursor_id)"
            ).bindparams(cursor_time=cursor_time, cursor_id=before_id)
        )

    query = (
        select(Message)
        .where(and_(*conditions))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit + 1)  # 多取 1 条判断 has_more
    )

    result = await db.execute(query)
    rows = result.scalars().all()

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

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
        "conversation_id": conversation_id,
        "messages": messages,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


@agent_chat_router.get("/conversations")
async def agent_conversations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户所有 agent_chat 会话，按更新时间倒序。"""
    result = await db.execute(
        select(Conversation)
        .where(
            Conversation.user_id == user.id,
            Conversation.type == "agent_chat",
        )
        .order_by(Conversation.updated_at.desc())
    )
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
            "session_id": conv.id,  # 向后兼容：前端旧代码用 session_id
            "created_at": conv.created_at.isoformat(),
            "updated_at": conv.updated_at.isoformat(),
            "first_message": first_msg[:100] if first_msg else None,
        })

    return {"conversations": conv_list}


@agent_chat_router.delete("/conversations/{conv_id}")
async def agent_delete_conversation(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
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


@agent_chat_router.get("/faq/categories")
async def agent_faq_categories():
    """FAQ 分类列表。"""
    return {"categories": []}


# ═══════════════════════════════════════════════════════════
# /api/conversations —— 向后兼容别名
# ═══════════════════════════════════════════════════════════

conversations_router = APIRouter(prefix="/api", tags=["conversations"])


@conversations_router.get("/conversations")
async def list_conversations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """会话列表 —— GET /api/conversations（向后兼容）。"""
    result = await db.execute(
        select(Conversation.id, Conversation.title, Conversation.created_at, Conversation.updated_at)
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
                "session_id": row.id,
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
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
