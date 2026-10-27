"""ChatService: persistence for 1:1 chats (ported from matrimonial-backend-v2).

All queries are portable (PostgreSQL + SQLite). Methods return plain rows
(``ChatRow`` / ``MessageRow``) so callers can keep using them after commits.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, asc, case, delete, desc, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.adapters import MediaInfo
from commskit.core.db import db_now
from commskit.core.util import iso, to_naive_utc

from .dto import MessageRow
from .models import Chat, ChatCleared, Message, MessageHidden

DELETED_TYPE = "deleted"
SYSTEM_TYPE = "system"
# Message types only the server may create (a client sending one gets "text").
RESERVED_TYPES = frozenset({DELETED_TYPE, SYSTEM_TYPE})


@dataclass
class ChatRow:
    id: int
    user1_id: str
    user2_id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def of(cls, chat: Chat) -> "ChatRow":
        return cls(chat.id, chat.user1_id, chat.user2_id, chat.created_at, chat.updated_at)

    def other(self, user_id: str) -> str:
        return self.user2_id if self.user1_id == user_id else self.user1_id


def _last_message_summary(m: Message) -> dict[str, Any]:
    return {
        "content": m.content,
        "sender_id": m.sender_id,
        "timestamp": iso(m.created_at),
        "message_type": m.message_type,
        "file_url": m.file_url,
        "file_size": m.file_size,
        "file_type": m.file_type,
        "file_name": m.file_name,
        # Additive vs. the legacy server: lets the conversation list show ticks.
        "is_read": bool(m.is_read),
        "is_delivered": bool(m.is_delivered),
    }


def _participant(user_id: str) -> Any:
    return or_(Chat.user1_id == user_id, Chat.user2_id == user_id)


def _not_deleted() -> Any:
    return or_(Message.message_type.is_(None), Message.message_type != DELETED_TYPE)


def visible_to(user_id: str) -> Any:
    """Messages ``user_id`` still sees: not hidden (delete for me) and newer than their clear-chat mark."""
    cleared = (
        select(ChatCleared.up_to_message_id)
        .where(ChatCleared.user_id == user_id, ChatCleared.chat_id == Message.chat_id)
        .scalar_subquery()
    )
    hidden = exists().where(MessageHidden.user_id == user_id, MessageHidden.message_id == Message.id)
    return and_(Message.id > func.coalesce(cleared, 0), ~hidden)


class ChatActionError(Exception):
    """Refused chat action (PROTOCOL.md section 9). ``code``: not_found | not_allowed | window_expired |
    rate_limited | too_long (``extra`` carries ``retry_after`` / ``max``), or None for policy refusals."""

    def __init__(self, error: str, code: str | None = None, status: int = 400, **extra: Any) -> None:
        super().__init__(error)
        self.error = error
        self.code = code
        self.status = status
        self.extra = extra

    def frame(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": "error", "error": self.error}
        if self.code:
            payload["code"] = self.code
        payload.update(self.extra)
        return payload


class ChatService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ---------------------------------------------------------------- chats

    async def get_chat_between(self, user_a: str, user_b: str) -> ChatRow | None:
        user1_id, user2_id = sorted([user_a, user_b])
        result = await self.session.execute(
            select(Chat).where(Chat.user1_id == user1_id, Chat.user2_id == user2_id)
        )
        chat = result.scalar_one_or_none()
        return ChatRow.of(chat) if chat else None

    async def get_or_create_chat(self, user_a: str, user_b: str) -> ChatRow:
        """Idempotent per pair; survives a concurrent create (unique constraint)."""
        existing = await self.get_chat_between(user_a, user_b)
        if existing:
            return existing
        try:
            chat = Chat(user1_id=user_a, user2_id=user_b, updated_at=func.now())
            self.session.add(chat)
            await self.session.commit()
        except IntegrityError:
            await self.session.rollback()
        found = await self.get_chat_between(user_a, user_b)
        if found is None:
            raise RuntimeError("Could not create chat")
        return found

    async def get_chat_for_user(self, chat_id: int, user_id: str) -> ChatRow | None:
        """Chat only if ``user_id`` is a participant."""
        result = await self.session.execute(
            select(Chat).where(Chat.id == chat_id, _participant(user_id))
        )
        chat = result.scalar_one_or_none()
        return ChatRow.of(chat) if chat else None

    async def partner_ids(self, user_id: str) -> list[str]:
        result = await self.session.execute(
            select(case((Chat.user1_id == user_id, Chat.user2_id), else_=Chat.user1_id)).where(
                _participant(user_id)
            )
        )
        return [str(uid) for uid in result.scalars().all()]

    async def get_conversations(self, user_id: str) -> list[dict[str, Any]]:
        """Chat summaries, newest first: {chat_id, other_user_id, updated_at, last_message, unread_count}.

        Portable "last message per chat" via MAX(id) (ids grow with time) instead
        of PostgreSQL's DISTINCT ON.
        """
        user_chats = (
            select(
                Chat.id.label("chat_id"),
                Chat.updated_at.label("updated_at"),
                case((Chat.user1_id == user_id, Chat.user2_id), else_=Chat.user1_id).label("other_user_id"),
            )
            .where(_participant(user_id))
            .subquery()
        )
        chat_ids = select(user_chats.c.chat_id)
        last_ids = (
            select(Message.chat_id.label("chat_id"), func.max(Message.id).label("last_id"))
            .where(Message.chat_id.in_(chat_ids), visible_to(user_id))
            .group_by(Message.chat_id)
            .subquery()
        )
        unread = (
            select(Message.chat_id.label("chat_id"), func.count(Message.id).label("unread_count"))
            .where(Message.chat_id.in_(chat_ids), Message.sender_id != user_id, Message.is_read.is_not(True),
                   _not_deleted(), visible_to(user_id))
            .group_by(Message.chat_id)
            .subquery()
        )
        result = await self.session.execute(
            select(
                user_chats.c.chat_id,
                user_chats.c.updated_at,
                user_chats.c.other_user_id,
                Message,
                func.coalesce(unread.c.unread_count, 0),
            )
            .select_from(user_chats)
            .outerjoin(last_ids, last_ids.c.chat_id == user_chats.c.chat_id)
            .outerjoin(Message, Message.id == last_ids.c.last_id)
            .outerjoin(unread, unread.c.chat_id == user_chats.c.chat_id)
            .order_by(desc(user_chats.c.updated_at), desc(user_chats.c.chat_id))
        )
        return [
            {
                "chat_id": chat_id,
                "other_user_id": other_id,
                "updated_at": iso(updated_at),
                "last_message": _last_message_summary(msg) if msg is not None else None,
                "unread_count": int(unread_count or 0),
            }
            for chat_id, updated_at, other_id, msg, unread_count in result.all()
        ]

    # ------------------------------------------------------------- messages

    async def send_message(
        self,
        chat_id: int,
        sender_id: str,
        content: str | None,
        message_type: str = "text",
        media: MediaInfo | None = None,
        call_id: str | None = None,
        reply_to_id: Any = None,
    ) -> MessageRow:
        message = Message(
            chat_id=chat_id,
            sender_id=sender_id,
            content=content,
            message_type=message_type,
            reply_to_id=await self._valid_reply_target(chat_id, reply_to_id),
            is_read=False,
            is_delivered=False,
        )
        if media is not None:
            message.file_url = media.file_url
            message.file_name = media.file_name
            message.file_size = media.file_size
            message.file_type = media.file_type
            message.thumbnail_url = media.thumbnail_url
            message.duration = media.duration
        if call_id:
            message.call_id = call_id
            message.is_call = True
        try:
            self.session.add(message)
            await self.session.execute(update(Chat).where(Chat.id == chat_id).values(updated_at=func.now()))
            await self.session.commit()
            await self.session.refresh(message)
        except Exception:
            await self.session.rollback()
            raise
        return MessageRow.of(message)

    async def _valid_reply_target(self, chat_id: int, reply_to_id: Any) -> int | None:
        """Only messages from the same chat can be quoted."""
        try:
            reply_to_id = int(reply_to_id) if reply_to_id is not None else None
        except (TypeError, ValueError):
            return None
        if reply_to_id is None:
            return None
        result = await self.session.execute(
            select(Message.id).where(Message.id == reply_to_id, Message.chat_id == chat_id)
        )
        return result.scalar_one_or_none()

    async def get_reply_previews(self, message_ids: list[int | None]) -> dict[int, dict[str, Any]]:
        ids = [i for i in set(message_ids) if i is not None]
        if not ids:
            return {}
        result = await self.session.execute(
            select(Message.id, Message.sender_id, Message.content, Message.message_type, Message.file_name)
            .where(Message.id.in_(ids))
        )
        return {
            row.id: {
                "id": row.id,
                "sender_id": row.sender_id,
                "content": row.content,
                "message_type": row.message_type,
                "file_name": row.file_name,
            }
            for row in result.all()
        }

    async def get_messages_page(
        self, chat_id: int, limit: int = 50, offset: int = 0, viewer_id: str | None = None,
    ) -> list[MessageRow]:
        """Newest first. With ``viewer_id``, that user's hidden / cleared messages are left out."""
        query = select(Message).where(Message.chat_id == chat_id)
        if viewer_id is not None:
            query = query.where(visible_to(viewer_id))
        result = await self.session.execute(
            query.order_by(desc(Message.created_at), desc(Message.id)).limit(limit).offset(offset)
        )
        return [MessageRow.of(m) for m in result.scalars().all()]

    async def get_last_message(self, chat_id: int, viewer_id: str | None = None) -> MessageRow | None:
        page = await self.get_messages_page(chat_id, limit=1, viewer_id=viewer_id)
        return page[0] if page else None

    async def get_message(self, message_id: int) -> MessageRow | None:
        result = await self.session.execute(
            select(Message).where(Message.id == message_id).execution_options(populate_existing=True)
        )
        message = result.scalar_one_or_none()
        return MessageRow.of(message) if message else None

    async def mark_messages_as_read(self, chat_id: int, user_id: str) -> None:
        """Read receipts are per chat: everything the other person sent becomes read + delivered."""
        await self.session.execute(
            update(Message)
            .where(and_(Message.chat_id == chat_id, Message.sender_id != user_id, Message.is_read.is_not(True)))
            .values(is_read=True, is_delivered=True)
            .execution_options(synchronize_session=False)
        )
        await self.session.commit()

    async def mark_delivered(self, message_ids: list[int]) -> None:
        if not message_ids:
            return
        await self.session.execute(
            update(Message)
            .where(Message.id.in_(message_ids))
            .values(is_delivered=True)
            .execution_options(synchronize_session=False)
        )
        await self.session.commit()

    async def mark_delivered_for_recipient(self, user_id: str) -> list[tuple[int, str, int]]:
        """Mark everything sent to ``user_id`` delivered; returns (chat_id, sender_id, message_id)."""
        chat_ids = select(Chat.id).where(_participant(user_id))
        result = await self.session.execute(
            select(Message.chat_id, Message.sender_id, Message.id, Message.message_type).where(
                Message.chat_id.in_(chat_ids),
                Message.sender_id != user_id,
                Message.is_delivered.is_not(True),
            )
        )
        rows = result.all()
        if rows:
            await self.mark_delivered([int(r[2]) for r in rows])
        # System messages are stored under the user they are about, who never sees them: no receipt.
        return [(int(c), str(s), int(i)) for c, s, i, t in rows if t != SYSTEM_TYPE]

    async def get_unread_count(self, user_id: str) -> int:
        result = await self.session.execute(
            select(func.count(Message.id))
            .join(Chat, Message.chat_id == Chat.id)
            .where(_participant(user_id), Message.sender_id != user_id, Message.is_read.is_not(True),
                   _not_deleted(), visible_to(user_id))
        )
        return int(result.scalar() or 0)

    # ------------------------------------------------- delete / unsend / clear

    async def hide_message(self, user_id: str, message_id: int) -> None:
        """Delete for me (idempotent). Does not check access; callers do."""
        existing = await self.session.execute(
            select(MessageHidden.id).where(MessageHidden.user_id == user_id, MessageHidden.message_id == message_id)
        )
        if existing.scalar_one_or_none() is not None:
            return
        self.session.add(MessageHidden(user_id=user_id, message_id=message_id))
        try:
            await self.session.commit()
        except IntegrityError:
            await self.session.rollback()

    async def unsend_message(self, message_id: int, window_seconds: int) -> tuple[MessageRow, list[str]]:
        """Rewrite the row as ``deleted`` for everyone; returns the new row and the media URLs to delete.

        ``window_seconds`` > 0: raises ``ChatActionError("window_expired")`` for older messages."""
        message = await self.get_message(message_id)
        if message is None:
            raise ChatActionError("Message not found", "not_found", status=404)
        if window_seconds > 0 and message.created_at is not None:
            age = (to_naive_utc(await db_now(self.session)) - to_naive_utc(message.created_at)).total_seconds()
            if age > window_seconds:
                raise ChatActionError("This message can no longer be deleted for everyone", "window_expired",
                                      status=403)
        urls = [u for u in (message.file_url, message.thumbnail_url) if u]
        await self.session.execute(
            update(Message).where(Message.id == message_id).values(
                message_type=DELETED_TYPE, content=None, file_url=None, file_name=None, file_size=None,
                file_type=None, thumbnail_url=None, duration=None,
            ).execution_options(synchronize_session=False)
        )
        await self.session.commit()
        row = await self.get_message(message_id)
        assert row is not None
        return row, urls

    async def clear_chat(self, user_id: str, chat_id: int) -> datetime:
        """Hide every message of the chat, up to now, for ``user_id`` only. Returns ``cleared_at``."""
        up_to = int((await self.session.execute(
            select(func.max(Message.id)).where(Message.chat_id == chat_id)
        )).scalar() or 0)
        now = await db_now(self.session)
        row = (await self.session.execute(
            select(ChatCleared).where(ChatCleared.user_id == user_id, ChatCleared.chat_id == chat_id)
        )).scalar_one_or_none()
        if row is None:
            self.session.add(ChatCleared(user_id=user_id, chat_id=chat_id, cleared_at=now, up_to_message_id=up_to))
        else:
            row.cleared_at = now
            row.up_to_message_id = max(int(row.up_to_message_id or 0), up_to)
        # Single-message hides at or below the mark are redundant now.
        await self.session.execute(
            delete(MessageHidden).where(
                MessageHidden.user_id == user_id,
                MessageHidden.message_id.in_(select(Message.id).where(Message.chat_id == chat_id, Message.id <= up_to)),
            ).execution_options(synchronize_session=False)
        )
        await self.session.commit()
        return now

    # --------------------------------------------------------- moderation

    async def messages_around(
        self, chat_id: int, message_id: int | None, before: int = 20, after: int = 20,
    ) -> list[MessageRow]:
        """Newest first: up to ``before`` older messages, the message itself, up to ``after`` newer ones.
        Without a ``message_id`` from this chat: the latest ``before + after + 1`` messages.
        Ignores hides / clears (moderators see the whole conversation)."""
        before, after = max(0, before), max(0, after)
        anchor = None
        if message_id is not None:
            anchor = (await self.session.execute(
                select(Message.id).where(Message.id == message_id, Message.chat_id == chat_id)
            )).scalar_one_or_none()
        if anchor is None:
            return await self.get_messages_page(chat_id, limit=before + after + 1)
        older = (await self.session.execute(
            select(Message).where(Message.chat_id == chat_id, Message.id <= anchor)
            .order_by(desc(Message.id)).limit(before + 1)
        )).scalars().all()
        newer = (await self.session.execute(
            select(Message).where(Message.chat_id == chat_id, Message.id > anchor)
            .order_by(asc(Message.id)).limit(after)
        )).scalars().all() if after else []
        return [MessageRow.of(m) for m in reversed(newer)] + [MessageRow.of(m) for m in older]

    # ---------------------------------------------------------- deletion

    async def delete_user_data(self, user_id: str) -> tuple[dict[str, int], list[str]]:
        """Delete every chat ``user_id`` is in, with all its messages (a 1:1 chat has one shared copy,
        so the partner loses that conversation too), hides and clears.

        Returns ``({"chats", "messages"}, media URLs to delete)``. Commits."""
        chat_ids = [int(c) for c in (await self.session.execute(
            select(Chat.id).where(_participant(user_id))
        )).scalars().all()]
        counts = {"chats": len(chat_ids), "messages": 0}
        urls: list[str] = []
        quiet = {"synchronize_session": False}
        if chat_ids:
            for file_url, thumb in (await self.session.execute(
                select(Message.file_url, Message.thumbnail_url).where(Message.chat_id.in_(chat_ids))
            )).all():
                urls.extend(u for u in (file_url, thumb) if u)
            message_ids = select(Message.id).where(Message.chat_id.in_(chat_ids))
            await self.session.execute(
                delete(MessageHidden).where(MessageHidden.message_id.in_(message_ids)).execution_options(**quiet))
            await self.session.execute(
                delete(ChatCleared).where(ChatCleared.chat_id.in_(chat_ids)).execution_options(**quiet))
            # Replies only point inside the same chat; unlink first for databases without FK cascades.
            await self.session.execute(
                update(Message).where(Message.chat_id.in_(chat_ids)).values(reply_to_id=None)
                .execution_options(**quiet))
            result = await self.session.execute(
                delete(Message).where(Message.chat_id.in_(chat_ids)).execution_options(**quiet))
            counts["messages"] = int(result.rowcount or 0)
            await self.session.execute(delete(Chat).where(Chat.id.in_(chat_ids)).execution_options(**quiet))
        await self.session.execute(delete(MessageHidden).where(MessageHidden.user_id == user_id).execution_options(**quiet))
        await self.session.execute(delete(ChatCleared).where(ChatCleared.user_id == user_id).execution_options(**quiet))
        await self.session.commit()
        return counts, urls

    # ---------------------------------------------------------- call entries

    async def rewrite_call_message(self, call_id: str, content: str) -> int | None:
        """Set a call entry's text; returns its message id. Does NOT commit."""
        result = await self.session.execute(select(Message.id).where(Message.call_id == call_id))
        message_id = result.scalar_one_or_none()
        if message_id is None:
            return None
        await self.session.execute(
            update(Message)
            .where(Message.id == message_id)
            .values(content=content)
            .execution_options(synchronize_session=False)
        )
        return int(message_id)
