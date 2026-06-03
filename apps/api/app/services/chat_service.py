import time
import uuid
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.conversation import ConversationModel
from app.models.message import MessageModel
from app.providers.registry import get_provider, resolve_model
from app.services.memory_engine import MemoryEngine

logger = logging.getLogger(__name__)

MEMORY_PROMPT_PREFIX = "\n\n# User Context (from memory)\nThe following is what you know about the user from past conversations:\n"


class ChatService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def _inject_memories(self, user_message: str, user_id: str, system_prompt: str) -> tuple[str, list]:
        """Search relevant memories and inject them into the system prompt."""
        try:
            engine = MemoryEngine(self.db)
            memories = await engine.search(query=user_message, user_id=user_id, top_k=5)
            relevant = [m for m in memories if m.score > 0.3]
            if relevant:
                memory_text = "\n".join(f"- {m.content}" for m in relevant)
                enhanced_prompt = system_prompt + MEMORY_PROMPT_PREFIX + memory_text
                return enhanced_prompt, [m.content for m in relevant]
        except Exception as e:
            logger.warning(f"Memory injection failed: {e}")
        return system_prompt, []

    async def stream_chat(
        self,
        conversation_id: str,
        user_message: str,
        model_id: str | None = None,
        system_prompt: str = "",
    ):
        provider_name, resolved_model = resolve_model(model_id)
        provider = get_provider(provider_name)

        conversation = await self.db.get(ConversationModel, conversation_id)
        if not conversation:
            raise ValueError(f"Conversation '{conversation_id}' not found")

        user_id = conversation.user_id

        # Phase 1: Retrieve relevant memories and enhance system prompt
        enhanced_prompt, injected_memories = await self._inject_memories(
            user_message, user_id, system_prompt
        )

        user_msg = MessageModel(
            id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            role="user",
            content=user_message,
            model=resolved_model,
        )
        self.db.add(user_msg)
        await self.db.commit()

        messages = await self.db.execute(
            select(MessageModel)
            .where(MessageModel.conversation_id == conversation_id)
            .order_by(MessageModel.created_at)
        )
        history = messages.scalars().all()

        chat_messages = [
            {"role": msg.role, "content": msg.content} for msg in history
        ]

        assistant_msg_id = str(uuid.uuid4())
        full_content = ""
        first_token_ts = None
        start_ts = time.time()
        prompt_tokens = 0
        completion_tokens = 0
        memory_count = len(injected_memories)

        yield {
            "type": "meta",
            "message_id": assistant_msg_id,
            "model": resolved_model,
            "provider": provider_name,
            "memory_count": memory_count,
        }

        async for chunk in provider.stream_chat(
            messages=chat_messages,
            model=resolved_model,
            system_prompt=enhanced_prompt,
        ):
            if chunk["type"] == "token":
                if first_token_ts is None:
                    first_token_ts = time.time()
                full_content += chunk["content"]
                yield {
                    "type": "token",
                    "content": chunk["content"],
                    "message_id": assistant_msg_id,
                    "model": resolved_model,
                }
            elif chunk["type"] == "done":
                prompt_tokens = chunk["usage"]["prompt_tokens"]
                completion_tokens = chunk["usage"]["completion_tokens"]
                latency_ms = int((time.time() - start_ts) * 1000)
                first_token_ms = int(((first_token_ts or start_ts) - start_ts) * 1000)

        assistant_msg = MessageModel(
            id=assistant_msg_id,
            conversation_id=conversation_id,
            role="assistant",
            content=full_content,
            model=resolved_model,
        )
        self.db.add(assistant_msg)

        if conversation.title == "New Conversation":
            title_line = user_message.strip().split("\n")[0]
            conversation.title = title_line[:80] if len(title_line) > 80 else title_line

        await self.db.commit()

        # Phase 2: Extract and store new memories
        new_memory_count = 0
        try:
            engine = MemoryEngine(self.db)
            extracted = await engine.extract_and_store(
                messages=chat_messages,
                user_id=user_id,
                conversation_id=conversation_id,
                provider_name=provider_name,
            )
            new_memory_count = len(extracted)
        except Exception as e:
            logger.warning(f"Memory extraction failed: {e}")

        yield {
            "type": "done",
            "message_id": assistant_msg_id,
            "model": resolved_model,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "latency_ms": latency_ms,
                "first_token_ms": first_token_ms,
            },
            "memory": {
                "injected": memory_count,
                "extracted": new_memory_count,
            },
        }
