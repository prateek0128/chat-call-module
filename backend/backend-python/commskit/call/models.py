"""Call table (``calls``), same columns as the original app's ``calls`` table.

``chat_id`` is nullable here so calls work without the chat feature. An existing
database may have it NOT NULL; that is fine while chat is linked (it is always set).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from commskit.core.db import CommsBase


class Call(CommsBase):
    __tablename__ = "calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    call_id: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    chat_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    caller_id: Mapped[str] = mapped_column(String(50), nullable=False)
    receiver_id: Mapped[str] = mapped_column(String(50), nullable=False)
    recording_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    call_status: Mapped[str] = mapped_column(String(20), nullable=False)  # ringing|answered|ended|missed|rejected
    is_video_call: Mapped[bool | None] = mapped_column(Boolean, default=False)
    offer_sdp: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_sdp: Mapped[str | None] = mapped_column(Text, nullable=True)
    ice_candidates: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())
    duration: Mapped[int | None] = mapped_column(Integer, nullable=True)
    missed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_reason: Mapped[str | None] = mapped_column(String(255))
