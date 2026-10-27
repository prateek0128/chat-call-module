"""Chat tables. Same table/column names as matrimonial-backend-v2.

No ORM foreign key to a users table, so the kit doesn't depend on the host's
user model (existing DB-level constraints are untouched).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from commskit.core.db import CommsBase


class Chat(CommsBase):
    """Strict 1:1 conversation; ``user1_id < user2_id`` always."""

    __tablename__ = "chats"
    __table_args__ = (
        CheckConstraint("user1_id < user2_id", name="check_user_order"),
        UniqueConstraint("user1_id", "user2_id", name="unique_chat_users"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user1_id: Mapped[str] = mapped_column(String(50), nullable=False)
    user2_id: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())

    def __init__(self, user1_id: str, user2_id: str, **kwargs: Any) -> None:
        if user1_id > user2_id:
            user1_id, user2_id = user2_id, user1_id
        super().__init__(user1_id=user1_id, user2_id=user2_id, **kwargs)

    def other(self, user_id: str) -> str:
        return self.user2_id if self.user1_id == user_id else self.user1_id


class Message(CommsBase):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    chat_id: Mapped[int] = mapped_column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    sender_id: Mapped[str] = mapped_column(String(50), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_type: Mapped[str | None] = mapped_column(String(20), default="text")

    file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    file_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    duration: Mapped[int | None] = mapped_column(Integer, nullable=True)

    is_read: Mapped[bool | None] = mapped_column(Boolean, default=False)
    is_delivered: Mapped[bool | None] = mapped_column(Boolean, default=False)

    # Set for call-log entries. The DB may hold an FK to calls.call_id; the kit
    # keeps it a plain column so chat never depends on the call feature.
    is_call: Mapped[bool | None] = mapped_column(Boolean, default=False)
    call_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    reply_to_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())


class MessageHidden(CommsBase):
    """"Delete for me": ``user_id`` no longer sees ``message_id`` (kit table, PROTOCOL.md section 9)."""

    __tablename__ = "comms_message_hidden"
    __table_args__ = (UniqueConstraint("user_id", "message_id", name="uq_comms_message_hidden"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    message_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChatCleared(CommsBase):
    """"Clear chat": ``user_id`` no longer sees messages of ``chat_id`` up to ``up_to_message_id``.

    ``cleared_at`` is what clients get; the id watermark is what queries use (exact even when
    several messages share a timestamp)."""

    __tablename__ = "comms_chat_cleared"
    __table_args__ = (UniqueConstraint("user_id", "chat_id", name="uq_comms_chat_cleared"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    chat_id: Mapped[int] = mapped_column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    cleared_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    up_to_message_id: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
