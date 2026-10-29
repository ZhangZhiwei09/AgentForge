"""Ratings, public FAQ and authenticated feedback/analytics."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_chat_user, get_db, require_admin, require_faq_access
from src.api.v1.conversations import _find_conversation
from src.models.chat import Message, SatisfactionRating
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from src.models.user import User
from src.services import analytics as service

router = APIRouter(prefix="/api/agent/chat", tags=["analytics"])
Db = Annotated[AsyncSession, Depends(get_db)]


class RatingInput(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    message_id: str | None = Field(default=None, max_length=36)
    rating: str = Field(min_length=1, max_length=20)
    comment: str | None = Field(default=None, max_length=10000)


@router.post("/rate")
async def rate(body: RatingInput, db: Db, user: Annotated[User, Depends(get_chat_user)]):
    conversation = await _find_conversation(db, body.session_id, conv_type="agent_chat", user_id=user.id)
    if conversation is None:
        raise HTTPException(404, "会话不存在")
    if body.message_id:
        message = await db.scalar(select(Message.id).where(
            Message.id == body.message_id, Message.conversation_id == conversation.id, Message.role == "assistant",
        ))
        if message is None:
            raise HTTPException(400, "评价消息不属于此会话")
    db.add(SatisfactionRating(
        id=str(uuid.uuid4()), conversation_id=conversation.id, message_id=body.message_id or None,
        rating=body.rating, comment=body.comment or None,
    ))
    await db.commit()
    return {"status": "ok", "rating": body.rating}


@router.get("/faq", dependencies=[Depends(require_faq_access)])
async def faq(db: Db, category: str | None = None):
    return {"documents": await service.faq_documents(db, category)}


@router.get("/faq/categories", dependencies=[Depends(require_faq_access)])
async def faq_categories(db: Db):
    documents = await service.faq_documents(db)
    return {"categories": [
        {"name": name, "count": sum(name[:2] in doc["title"] for doc in documents)} for name in service.FAQ_CATEGORIES
    ]}


@router.get("/faq/{document_id}", dependencies=[Depends(require_faq_access)])
async def faq_detail(document_id: str, db: Db):
    document = (await db.execute(select(
        KnowledgeDocument.id, KnowledgeDocument.title, KnowledgeDocument.chunk_count, KnowledgeDocument.status,
    ).join(KnowledgeBase, KnowledgeBase.id == KnowledgeDocument.knowledge_base_id).where(
        KnowledgeDocument.id == document_id, KnowledgeDocument.enabled.is_(True),
        KnowledgeDocument.status == "completed", KnowledgeBase.enabled.is_(True),
    ))).first()
    if document is None:
        raise HTTPException(404, "文档不存在")
    content = await db.scalar(select(KnowledgeChunk.content).where(
        KnowledgeChunk.document_id == document_id, KnowledgeChunk.enabled.is_(True),
    ).order_by(KnowledgeChunk.chunk_index).limit(1))
    return {
        "id": document.id, "title": document.title, "content": (content or "")[:500],
        "chunkCount": document.chunk_count, "status": document.status,
    }


@router.get("/feedback", dependencies=[Depends(require_admin)])
async def feedback(
    db: Db, type: Literal["all", "positive", "negative"] = "all",
    page: Annotated[int, Query(ge=1)] = 1, limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    return await service.feedback(db, type, page, limit)


@router.get("/analytics", dependencies=[Depends(require_admin)])
async def analytics(db: Db):
    return await service.analytics(db)
