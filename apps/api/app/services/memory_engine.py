import json
import asyncio
import logging
import uuid
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.config import settings
from app.models.memory import MemoryModel, MemoryType
from app.schemas.memory import MemoryCreate, MemoryOut, MemorySearchResult

logger = logging.getLogger(__name__)

MILVUS_COLLECTION = "agentforge_memories"
EMBEDDING_DIM = 1536
EMBEDDING_MODEL = "text-embedding-ada-002"

SYSTEM_PROMPT_EXTRACT = """You are a memory extraction assistant. Analyze the conversation below and extract any new facts, preferences, or important information about the user.

Return a JSON array of memories. Each memory should have:
- "type": one of "semantic" (factual knowledge), "preference" (likes/dislikes), "episodic" (past event)
- "content": a concise statement of the fact
- "importance": a float 0.0-1.0 indicating how important this memory is (1.0 = critical, 0.0 = trivial)

If the conversation is just casual small talk with no substantive new information, return an empty array [].

Example:
User: "I work at Google and love Python"
Assistant: "That's great!"
Output: [{"type": "semantic", "content": "User works at Google", "importance": 0.8}, {"type": "preference", "content": "User likes Python", "importance": 0.7}]"""


class MemoryEngine:
    """Memory Engine for storing and retrieving user memories using Milvus + PostgreSQL."""

    def __init__(self, db: AsyncSession):
        self._db = db
        self._milvus_conn = None
        self._collection = None
        self._openai_client = None

    def _get_collection(self):
        """Lazy-init Milvus connection and collection."""
        if self._collection is not None:
            return self._collection

        from pymilvus import connections, Collection, FieldSchema, CollectionSchema, DataType

        connections.connect(
            alias="default",
            host=settings.milvus_host,
            port=settings.milvus_port,
        )

        from pymilvus import utility
        if utility.has_collection(MILVUS_COLLECTION):
            self._collection = Collection(MILVUS_COLLECTION)
        else:
            fields = [
                FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
                FieldSchema(name="memory_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="user_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
                FieldSchema(name="content", dtype=DataType.VARCHAR, max_length=4096),
            ]
            schema = CollectionSchema(fields, description="AgentForge memory embeddings")
            self._collection = Collection(MILVUS_COLLECTION, schema)

            index_params = {
                "metric_type": "COSINE",
                "index_type": "IVF_FLAT",
                "params": {"nlist": 128},
            }
            self._collection.create_index(field_name="embedding", index_params=index_params)

        self._collection.load()
        return self._collection

    async def _embed(self, text: str) -> list[float] | None:
        """Get embedding vector for text. Returns None if no embedding API is available."""
        import openai

        if self._openai_client is None:
            # Use OpenAI for embeddings if key is configured, otherwise skip silently
            if settings.openai_api_key:
                self._openai_client = openai.AsyncOpenAI(
                    api_key=settings.openai_api_key,
                    base_url=settings.openai_base_url,
                )
            else:
                return None

        response = await self._openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=text,
        )
        return response.data[0].embedding

    async def store(self, memory: MemoryCreate, user_id: str) -> MemoryOut:
        """Store a memory: embed content, save to Milvus, persist metadata to PG."""
        memory_id = str(uuid.uuid4())

        # Get embedding
        try:
            vector = await self._embed(memory.content)
        except Exception as e:
            logger.warning(f"Embedding failed: {e}, storing without vector")
            vector = None

        # Insert into Milvus
        embedding_id = None
        if vector is not None:
            try:
                collection = self._get_collection()
                mr = collection.insert([
                    [memory_id],
                    [user_id],
                    [vector],
                    [memory.content[:4096]],
                ])
                collection.flush()
                embedding_id = mr.primary_keys[0]
            except Exception as e:
                logger.warning(f"Milvus insert failed: {e}")

        # Save to PostgreSQL
        db_memory = MemoryModel(
            id=memory_id,
            user_id=user_id,
            type=MemoryType(memory.type),
            content=memory.content,
            importance=memory.importance,
            embedding_id=embedding_id,
            meta_info=memory.meta_info,
            conversation_id=memory.conversation_id,
        )
        self._db.add(db_memory)
        await self._db.commit()
        await self._db.refresh(db_memory)

        return MemoryOut.model_validate(db_memory)

    async def search(
        self, query: str, user_id: str, top_k: int = 5
    ) -> list[MemorySearchResult]:
        """Semantic search for memories relevant to the query."""
        # Get memories from PG first (fallback if no vector search)
        result = await self._db.execute(
            select(MemoryModel)
            .where(MemoryModel.user_id == user_id)
            .order_by(MemoryModel.importance.desc(), MemoryModel.created_at.desc())
            .limit(top_k)
        )
        memories = result.scalars().all()

        # Try vector search
        try:
            vector = await self._embed(query)
            if vector is not None:
                collection = self._get_collection()

                search_params = {"metric_type": "COSINE", "params": {"nprobe": 16}}
                results = collection.search(
                    data=[vector],
                    anns_field="embedding",
                    param=search_params,
                    limit=top_k,
                    expr=f'user_id == "{user_id}"',
                    output_fields=["memory_id"],
                )

                if results and results[0]:
                    scored = {}
                    for hit in results[0]:
                        scored[hit.entity.get("memory_id")] = hit.score

                    scored_memories = []
                    memory_map = {m.id: m for m in memories}
                    for mid, score in scored.items():
                        if mid in memory_map:
                            m = memory_map[mid]
                            scored_memories.append(
                                MemorySearchResult(
                                    id=m.id,
                                    user_id=m.user_id,
                                    type=m.type.value,
                                    content=m.content,
                                    importance=m.importance,
                                    metadata=m.meta_info,
                                    conversation_id=m.conversation_id,
                                    created_at=m.created_at,
                                    updated_at=m.updated_at,
                                    score=score,
                                )
                            )

                    # Add remaining without scores
                    scored_ids = set(scored.keys())
                    for m in memories:
                        if m.id not in scored_ids:
                            scored_memories.append(
                                MemorySearchResult(
                                    id=m.id,
                                    user_id=m.user_id,
                                    type=m.type.value,
                                    content=m.content,
                                    importance=m.importance,
                                    metadata=m.meta_info,
                                    conversation_id=m.conversation_id,
                                    created_at=m.created_at,
                                    updated_at=m.updated_at,
                                    score=0.0,
                                )
                            )

                    scored_memories.sort(key=lambda x: x.score, reverse=True)
                    return scored_memories[:top_k]

        except Exception as e:
            logger.warning(f"Vector search failed, falling back to PG: {e}")

        return [
            MemorySearchResult(
                id=m.id,
                user_id=m.user_id,
                type=m.type.value,
                content=m.content,
                importance=m.importance,
                metadata=m.meta_info,
                conversation_id=m.conversation_id,
                created_at=m.created_at,
                updated_at=m.updated_at,
                score=float(m.importance),
            )
            for m in memories
        ]

    async def extract_and_store(
        self,
        messages: list[dict],
        user_id: str,
        conversation_id: str,
        provider_name: str = "",
    ) -> list[MemoryOut]:
        """Use LLM to extract key facts from a conversation and store them."""
        if not messages or len(messages) < 2:
            return []

        from openai import AsyncOpenAI

        # Use provider's API for extraction
        if provider_name == "openai" and settings.openai_api_key:
            client = AsyncOpenAI(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
            )
            model = "gpt-4o-mini"
        else:
            client = AsyncOpenAI(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
            )
            model = "deepseek-chat"

        conv_text = "\n".join(
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
            for m in messages[-6:]  # Last 3 turns
        )

        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT_EXTRACT},
                    {"role": "user", "content": f"Extract memories from:\n\n{conv_text}"},
                ],
                temperature=0.1,
                max_tokens=500,
            )

            content = response.choices[0].message.content.strip()
            # Handle potential markdown code blocks
            if content.startswith("```"):
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]
                content = content.strip()

            items = json.loads(content)
            if not isinstance(items, list):
                return []

            results = []
            for item in items:
                if not isinstance(item, dict) or "content" not in item:
                    continue
                memory = MemoryCreate(
                    type=item.get("type", "semantic"),
                    content=item["content"],
                    importance=float(item.get("importance", 0.5)),
                    conversation_id=conversation_id,
                )
                result = await self.store(memory, user_id)
                results.append(result)

            if results:
                logger.info(f"Extracted {len(results)} memories from conversation")
            return results

        except Exception as e:
            logger.warning(f"Memory extraction failed: {e}")
            return []

    async def list(
        self, user_id: str, type: str | None = None
    ) -> list[MemoryOut]:
        """List all memories for a user, optionally filtered by type."""
        query = select(MemoryModel).where(MemoryModel.user_id == user_id)
        if type:
            query = query.where(MemoryModel.type == MemoryType(type))
        query = query.order_by(MemoryModel.importance.desc(), MemoryModel.created_at.desc())

        result = await self._db.execute(query)
        memories = result.scalars().all()
        return [MemoryOut.model_validate(m) for m in memories]

    async def delete(self, memory_id: str) -> bool:
        """Delete a memory from both PG and Milvus."""
        db_memory = await self._db.get(MemoryModel, memory_id)
        if not db_memory:
            return False

        # Remove from Milvus
        if db_memory.embedding_id is not None:
            try:
                collection = self._get_collection()
                collection.delete(f"id in [{db_memory.embedding_id}]")
            except Exception as e:
                logger.warning(f"Milvus delete failed: {e}")

        await self._db.delete(db_memory)
        await self._db.commit()
        return True
