"""ORM 基类 + 时间戳 Mixin。

概念：
1. DeclarativeBase —— 所有模型的"根"，SQLAlchemy 用它统一管理所有表的元数据。
   类比 TypeScript：Prisma schema 的隐式基类体系，写 model User {} 时自动继承。

2. TimestampMixin —— 给表自动加上 created_at / updated_at 字段，每个模型不需要重复定义。
   类比 TypeScript：Prisma 里可以用 @@map 或通过 middleware 注入，但 SQLAlchemy
   的 Mixin 是把逻辑切成独立 class 再混入，复用性更强。
"""

from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。继承它 = 这个表被 SQLAlchemy 管理。"""
    pass


class TimestampMixin:
    """混入后自动拥有 created_at / updated_at 两个时间戳字段。

    created_at 插入时自动填当前时间，不会在更新时改变。
    updated_at 插入和每次更新时都自动刷新为当前时间。
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=func.now(), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=func.now(), onupdate=func.now(), server_default=func.now()
    )
