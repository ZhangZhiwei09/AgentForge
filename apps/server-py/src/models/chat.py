"""会话 / 消息 / 记忆 —— SQLAlchemy ORM 模型。

对应 Prisma schema:
    Conversation  → conversations 表
    Message       → messages 表（增强 type + metadata）
    ConversationMemory → conversation_memory 表（新建）

设计要点:
    1. conversation_id 是唯一标识，前端直接使用，不再通过 session_id 间接查找
    2. Message.type 区分 text / tool_call / tool_result，支撑 Agent 工具调用链
    3. ConversationMemory 独立存储摘要，不耦合 customerMeta，可扩展 memory_type
"""

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSON  # PostgreSQL jsonb
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base


class Conversation(Base):
    """会话 —— 对应用户的一次对话。

    对应表: conversations
    """

    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), default="新对话")
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    type: Mapped[str] = mapped_column(String(32), default="agent_chat", server_default="agent_chat")
    session_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    intent: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    rating: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    status: Mapped[Optional[str]] = mapped_column(String(20), default="active", server_default="active")
    customer_meta: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # 关联
    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", lazy="selectin", cascade="all, delete-orphan"
    )
    memory: Mapped[Optional["ConversationMemory"]] = relationship(
        back_populates="conversation", lazy="selectin", uselist=False, cascade="all, delete-orphan"
    )


class Message(Base):
    """消息 —— 会话中的单条消息。

    对应表: messages

    增强字段:
        type: text | tool_call | tool_result 区分消息类型
        metadata: 存储 tool_name, tool_args, tokens, 前端渲染提示等
    """

    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    type: Mapped[str] = mapped_column(
        String(20), default="text", server_default="text"
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    msg_metadata: Mapped[Optional[dict[str, Any]]] = mapped_column("metadata", JSON, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # 关联
    conversation: Mapped["Conversation"] = relationship(back_populates="messages")


class ConversationMemory(Base):
    """会话长期记忆 —— 存储 LLM 生成的对话摘要。

    对应表: conversation_memory（新建）

    设计理由:
        - 独立表而非 customerMeta JSON：结构清晰，可索引，不与其他业务字段混合
        - covered_until_message_id 而非 index：消息删除时 index 漂移，message_id 不可变
        - memory_type 预留给未来扩展：summary | entity | preference | fact

    压缩策略:
        消息数 > COMPRESSION_THRESHOLD 时异步触发；
        首次压缩：取旧消息 → LLM → 生成摘要；
        增量压缩：已有摘要 + 新消息 → LLM → 合并摘要。
    """

    __tablename__ = "conversation_memory"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    covered_until_message_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    memory_type: Mapped[str] = mapped_column(
        String(20), default="summary", server_default="summary"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # 关联
    conversation: Mapped["Conversation"] = relationship(back_populates="memory")
