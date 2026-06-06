import uuid
import time
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.conversation import ConversationModel
from app.models.message import MessageModel
from app.providers.registry import get_provider, resolve_model

CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002"
MAX_HISTORY_MESSAGES = 20

CUSTOMER_SERVICE_PROMPT = """
你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。
"""


class CustomerChatService:

    def __init__(self, db: AsyncSession, model_id: str | None = None):
        self.db = db
        self.model_id = model_id

    async def _get_or_create_conversation(self, session_id: str | None) -> ConversationModel:
        if session_id:
            result = await self.db.execute(
                select(ConversationModel)
                .where(
                    ConversationModel.session_id == session_id,
                    ConversationModel.type == "customer_service",
                )
            )
            conversation = result.scalars().first()
            if conversation:
                return conversation

        conversation = ConversationModel(
            id=str(uuid.uuid4()),
            title=f"客服会话",
            user_id=CUSTOMER_USER_ID,
            type="customer_service",
            session_id=session_id,
        )
        self.db.add(conversation)
        await self.db.commit()
        await self.db.refresh(conversation)
        return conversation

    async def stream_chat(self, session_id: str | None, user_message: str):
        conversation = await self._get_or_create_conversation(session_id)

        provider_name, resolved_model = resolve_model(self.model_id)
        provider = get_provider(provider_name)

        # 加载历史消息
        result = await self.db.execute(
            select(MessageModel)
            .where(MessageModel.conversation_id == conversation.id)
            .order_by(MessageModel.created_at.desc())
            .limit(MAX_HISTORY_MESSAGES)
        )
        history = list(reversed(result.scalars().all()))

        # 保存用户消息
        user_msg = MessageModel(
            id=str(uuid.uuid4()),
            conversation_id=conversation.id,
            role="user",
            content=user_message,
            model=resolved_model,
        )
        self.db.add(user_msg)
        await self.db.commit()

        # 构建 LLM 消息列表（历史 + 当前）
        chat_messages = [
            {"role": msg.role, "content": msg.content} for msg in history
        ]
        chat_messages.append({"role": "user", "content": user_message})

        assistant_msg_id = str(uuid.uuid4())
        full_content = ""

        # 返回 meta（含 session_id，供前端保存）
        yield {
            "type": "meta",
            "message_id": assistant_msg_id,
            "session_id": conversation.session_id,
            "model": resolved_model,
            "provider": provider_name,
        }

        # 流式调用 LLM
        async for chunk in provider.stream_chat(
            messages=chat_messages,
            model=resolved_model,
            system_prompt=CUSTOMER_SERVICE_PROMPT,
        ):
            if chunk["type"] == "token":
                full_content += chunk["content"]
                yield {
                    "type": "token",
                    "content": chunk["content"],
                    "message_id": assistant_msg_id,
                }
            elif chunk["type"] == "done":
                prompt_tokens = chunk.get("usage", {}).get("prompt_tokens", 0)
                completion_tokens = chunk.get("usage", {}).get("completion_tokens", 0)
                yield {
                    "type": "done",
                    "message_id": assistant_msg_id,
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    },
                }

        # 保存 assistant 消息
        assistant_msg = MessageModel(
            id=assistant_msg_id,
            conversation_id=conversation.id,
            role="assistant",
            content=full_content,
            model=resolved_model,
        )
        self.db.add(assistant_msg)
        await self.db.commit()