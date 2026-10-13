"""Persistent support tickets used by the business tool."""

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, TimestampMixin


class SupportTicket(Base, TimestampMixin):
    __tablename__ = "support_tickets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    ticket_id: Mapped[str] = mapped_column(String(64), unique=True)
    summary: Mapped[str] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(String(20), default="normal", server_default="normal")
    category: Mapped[str] = mapped_column(String(100), default="通用")
    status: Mapped[str] = mapped_column(String(20), default="open", server_default="open")
