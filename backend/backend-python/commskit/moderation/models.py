"""Moderation tables: ``comms_blocks`` and ``comms_reports`` (no FK to a users table)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from commskit.core.db import CommsBase
from commskit.core.util import utcnow


class Block(CommsBase):
    __tablename__ = "comms_blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="uq_comms_blocks_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    blocker_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    blocked_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Report(CommsBase):
    """A report. reporter_id / reported_id become NULL when that account is deleted
    (delete_user_data), so the moderation history survives without personal ids."""

    __tablename__ = "comms_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reporter_id: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    reported_id: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")  # open|resolved|dismissed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
