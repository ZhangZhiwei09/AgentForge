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

SYSTEM_PROMPT_EXTRACT = """你是一个记忆提取助手。分析以下对话，提取出关于用户的新事实、偏好或重要信息。

返回一个 JSON 数组格式的记忆列表。每条记忆包含以下字段：
- "type": 记忆类型，可选值："semantic"（事实性知识）、"preference"（喜好/厌恶）、"episodic"（过往事件）
- "content": 对事实的简洁陈述
- "importance": 0.0 到 1.0 之间的浮点数，表示这条记忆的重要程度（1.0 = 极其重要，0.0 = 无关紧要）

如果对话只是普通的寒暄闲聊，没有实质性的新信息，返回空数组 []。

示例：
User: "我在谷歌工作，非常喜欢 Python"
Assistant: "太棒了！"
Output: [{"type": "semantic", "content": "用户在谷歌工作", "importance": 0.8}, {"type": "preference", "content": "用户喜欢 Python", "importance": 0.7}]"""


class MemoryEngine:
    """记忆引擎：使用 Milvus + PostgreSQL 存储和检索用户记忆。"""

    def __init__(self, db: AsyncSession):
        self._db = db
        self._milvus_conn = None
        self._collection = None

    def _get_collection(self):
        """懒初始化 Milvus 连接和集合。"""
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
        """获取文本的向量嵌入。如未配置 Embedding Provider 则返回 None。"""
        from app.services.embeddings.registry import get_default_embedding_provider

        try:
            provider = get_default_embedding_provider()
            if provider is None:
                return None
            return await provider.embed_single(text)
        except Exception as e:
            logger.warning(f"向量嵌入失败: {e}")
            return None

    async def store(self, memory: MemoryCreate, user_id: str) -> MemoryOut:
        """存储一条记忆：向量化内容 → 存入 Milvus → 元数据持久化到 PostgreSQL。"""
        memory_id = str(uuid.uuid4())

        # 获取向量嵌入
        try:
            vector = await self._embed(memory.content)
        except Exception as e:
            logger.warning(f"向量嵌入失败: {e}，将不携带向量存储")
            vector = None

        # 插入 Milvus
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
                logger.warning(f"Milvus 插入失败: {e}")

        # 保存到 PostgreSQL
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
        """语义搜索与查询相关的记忆。"""
        # 先从 PostgreSQL 获取记忆（向量搜索不可用时的降级方案）
        result = await self._db.execute(
            select(MemoryModel)
            .where(MemoryModel.user_id == user_id)
            .order_by(MemoryModel.importance.desc(), MemoryModel.created_at.desc())
            .limit(top_k)
        )
        memories = result.scalars().all()

        # 尝试向量搜索
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

                    # 把没有向量匹配分数的也加上
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
            logger.warning(f"向量搜索失败，降级到 PostgreSQL: {e}")

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
        """用 LLM 从对话中提取关键信息并存储为记忆。"""
        if not messages or len(messages) < 2:
            return []

        from openai import AsyncOpenAI

        # 优先用 OpenAI 做提取，否则用 DeepSeek
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
            for m in messages[-6:]  # 取最近 3 轮对话
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
            # 处理可能的 markdown 代码块包裹
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
                logger.info(f"从对话中提取了 {len(results)} 条记忆")
            return results

        except Exception as e:
            logger.warning(f"记忆提取失败: {e}")
            return []

    async def list(
        self, user_id: str, type: str | None = None
    ) -> list[MemoryOut]:
        """列出用户的所有记忆，可按类型筛选。"""
        query = select(MemoryModel).where(MemoryModel.user_id == user_id)
        if type:
            query = query.where(MemoryModel.type == MemoryType(type))
        query = query.order_by(MemoryModel.importance.desc(), MemoryModel.created_at.desc())

        result = await self._db.execute(query)
        memories = result.scalars().all()
        return [MemoryOut.model_validate(m) for m in memories]

    async def delete(self, memory_id: str) -> bool:
        """删除一条记忆，同时从 PostgreSQL 和 Milvus 中移除。"""
        db_memory = await self._db.get(MemoryModel, memory_id)
        if not db_memory:
            return False

        # 从 Milvus 中删除
        if db_memory.embedding_id is not None:
            try:
                collection = self._get_collection()
                collection.delete(f"id in [{db_memory.embedding_id}]")
            except Exception as e:
                logger.warning(f"Milvus 删除失败: {e}")

        await self._db.delete(db_memory)
        await self._db.commit()
        return True
