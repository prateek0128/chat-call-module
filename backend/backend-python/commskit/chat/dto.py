"""MessageDto wire shape (PROTOCOL.md section 3)."""

from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime
from typing import Any, Mapping

from commskit.core.util import iso


@dataclass
class MessageRow:
    """Plain copy of a ``Message`` row; safe to use after the session commits again."""

    id: int
    chat_id: int
    sender_id: str
    content: str | None = None
    message_type: str | None = "text"
    file_url: str | None = None
    file_name: str | None = None
    file_size: int | None = None
    file_type: str | None = None
    thumbnail_url: str | None = None
    duration: int | None = None
    is_read: bool | None = False
    is_delivered: bool | None = False
    call_id: str | None = None
    reply_to_id: int | None = None
    created_at: datetime | None = None

    @classmethod
    def of(cls, message: Any) -> "MessageRow":
        return cls(**{f.name: getattr(message, f.name) for f in fields(cls)})


def message_dto(
    message: Any,
    viewer_id: str,
    reply_to: Mapping[str, Any] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """``sender_type`` is relative to ``viewer_id``: "user" = me, "other" = them; "system" for
    ``message_type == "system"`` (PROTOCOL.md section 9)."""
    if message.message_type == "system":
        sender_type = "system"
    else:
        sender_type = "user" if message.sender_id == viewer_id else "other"
    dto: dict[str, Any] = {
        "id": message.id,
        "chat_id": message.chat_id,
        "sender_id": message.sender_id,
        "sender_type": sender_type,
        "content": message.content,
        "message_type": message.message_type,
        "timestamp": iso(message.created_at),
        "file_url": message.file_url,
        "file_name": message.file_name,
        "file_size": message.file_size,
        "file_type": message.file_type,
        "thumbnail_url": message.thumbnail_url,
        "duration": int(message.duration) if message.duration else message.duration,
        "is_read": bool(message.is_read),
        "is_delivered": bool(message.is_delivered),
        "call_id": message.call_id,
        "reply_to": dict(reply_to) if reply_to else None,
    }
    dto.update(overrides)
    return dto
