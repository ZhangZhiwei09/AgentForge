"""intent_samples ORM 模型 —— 路由 L2 语义层的意图样本表。

镜像 TS prisma schema（packages/database/prisma/schema.prisma 的 intent_samples）。
存每个路由（SAFETY/CHAT/TASK/HUMAN/DIAGNOSIS）的典型用户问法 + embedding，
供 L2 语义分类（pgvector k-NN 加权投票）检索。

embedding 维度对齐本地 Ollama bge-m3（1024d）。与 TS 一致（bge-m3, vector(1024)）。
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, TimestampMixin


class IntentSample(Base, TimestampMixin):
    """路由意图样本。

    对应表: intent_samples
    """

    __tablename__ = "intent_samples"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    route: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    text: Mapped[str] = mapped_column(String(2000), nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(1024), nullable=True
    )
    source: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)
    active: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False, index=True
    )
    usage_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
