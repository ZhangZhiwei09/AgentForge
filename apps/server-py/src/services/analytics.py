"""Portable SQL aggregation for the existing feedback and analytics DTOs."""

import math
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from src.models.chat import Conversation, Message, SatisfactionRating
from src.models.knowledge import KnowledgeBase, KnowledgeDocument

FAQ_CATEGORIES = ("退货退款", "物流查询", "售后联系", "账户会员", "支付订单")


async def faq_documents(db: AsyncSession, category: str | None = None):
    base = await db.scalar(select(KnowledgeBase.id).where(
        KnowledgeBase.name.contains("客服"), KnowledgeBase.enabled.is_(True),
    ).order_by(KnowledgeBase.created_at, KnowledgeBase.id).limit(1))
    if not base:
        return []
    statement = select(
        KnowledgeDocument.id, KnowledgeDocument.title, KnowledgeDocument.chunk_count,
        KnowledgeDocument.status, KnowledgeDocument.created_at,
    ).where(
        KnowledgeDocument.knowledge_base_id == base, KnowledgeDocument.status == "completed",
        KnowledgeDocument.enabled.is_(True),
    ).order_by(KnowledgeDocument.created_at.desc(), KnowledgeDocument.id)
    if category:
        statement = statement.where(KnowledgeDocument.title.contains(category, autoescape=True))
    return [
        {"id": row.id, "title": row.title, "chunkCount": row.chunk_count, "status": row.status, "createdAt": row.created_at}
        for row in (await db.execute(statement)).all()
    ]


async def feedback(db: AsyncSession, feedback_type: str, page: int, limit: int):
    assistant = aliased(Message)
    user = aliased(Message)
    conditions = [Conversation.type == "agent_chat"]
    if feedback_type == "negative":
        conditions.append(or_(
            SatisfactionRating.rating == "negative", SatisfactionRating.rating.startswith("star_"),
        ))
    elif feedback_type == "positive":
        conditions.append(SatisfactionRating.rating == "positive")
    user_message = select(user.content).where(
        user.conversation_id == Conversation.id, user.role == "user",
        user.created_at <= SatisfactionRating.created_at,
    ).order_by(user.created_at.desc(), user.id.desc()).limit(1).correlate(
        Conversation, SatisfactionRating,
    ).scalar_subquery()
    total = await db.scalar(select(func.count()).select_from(SatisfactionRating).join(
        Conversation, Conversation.id == SatisfactionRating.conversation_id,
    ).where(*conditions))
    rows = (await db.execute(select(
        SatisfactionRating, Conversation.session_id, Conversation.intent,
        user_message.label("user_message"), assistant.content.label("assistant_message"),
    ).join(Conversation, Conversation.id == SatisfactionRating.conversation_id).outerjoin(
        assistant, (assistant.id == SatisfactionRating.message_id)
        & (assistant.conversation_id == Conversation.id) & (assistant.role == "assistant"),
    ).where(*conditions).order_by(SatisfactionRating.created_at.desc(), SatisfactionRating.id.desc()).offset(
        (page - 1) * limit,
    ).limit(limit))).all()
    return {
        "feedback": [{
            "id": rating.id, "rating": rating.rating, "comment": rating.comment, "created_at": rating.created_at,
            "conversation_id": rating.conversation_id, "session_id": session_id, "intent": intent,
            "user_message": (question or "")[:200], "assistant_message": (answer or "")[:300],
            "message_id": rating.message_id,
        } for rating, session_id, intent, question, answer in rows],
        "pagination": {"page": page, "limit": limit, "total": total, "totalPages": math.ceil(total / limit)},
    }


async def analytics(db: AsyncSession):
    today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    base = select(func.count()).select_from(Conversation).where(Conversation.type == "agent_chat")
    ratings = (await db.execute(select(SatisfactionRating.rating, func.count()).join(
        Conversation, Conversation.id == SatisfactionRating.conversation_id,
    ).where(Conversation.type == "agent_chat").group_by(SatisfactionRating.rating))).all()
    total_ratings = sum(count for _, count in ratings)
    positive = sum(count for rating, count in ratings if rating == "positive" or rating.startswith(("star_4", "star_5")))
    return {
        "total_conversations": await db.scalar(base),
        "today_conversations": await db.scalar(base.where(Conversation.created_at >= today)),
        "total_messages": await db.scalar(select(func.count()).select_from(Message).join(
            Conversation, Conversation.id == Message.conversation_id,
        ).where(Conversation.type == "agent_chat")),
        "satisfaction_rate": math.floor(positive / total_ratings * 100 + 0.5) if total_ratings else 0,
        "total_ratings": total_ratings,
    }
