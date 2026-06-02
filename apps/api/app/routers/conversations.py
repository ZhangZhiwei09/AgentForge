from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database.session import get_db
from app.models.conversation import ConversationModel
from app.schemas.conversation import ConversationOut, CreateConversationDTO, UpdateConversationDTO

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"


@router.post("", response_model=ConversationOut, status_code=201)
async def create_conversation(dto: CreateConversationDTO, db: AsyncSession = Depends(get_db)):
    conv = ConversationModel(
        title=dto.title or "New Conversation",
        user_id=DEFAULT_USER_ID,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


@router.get("", response_model=list[ConversationOut])
async def list_conversations(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ConversationModel)
        .where(ConversationModel.user_id == DEFAULT_USER_ID)
        .order_by(ConversationModel.updated_at.desc())
    )
    return result.scalars().all()


@router.get("/{conversation_id}", response_model=ConversationOut)
async def get_conversation(conversation_id: str, db: AsyncSession = Depends(get_db)):
    conv = await db.get(ConversationModel, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str, db: AsyncSession = Depends(get_db)):
    conv = await db.get(ConversationModel, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await db.delete(conv)
    await db.commit()
