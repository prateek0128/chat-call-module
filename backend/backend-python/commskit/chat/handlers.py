"""Chat WebSocket handlers (PROTOCOL.md sections 3 and 9)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from typing import TYPE_CHECKING, Any, Mapping

from fastapi import WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.adapters import delete_media
from commskit.core.media import detect_media_type
from commskit.core.ratelimit import RateLimit, retry_after_seconds
from commskit.core.util import LRU, iso, now_iso

from .dto import message_dto
from .service import DELETED_TYPE, RESERVED_TYPES, SYSTEM_TYPE, ChatActionError, ChatRow, ChatService

if TYPE_CHECKING:
    from .feature import ChatFeature

logger = logging.getLogger("commskit.chat")

ATTACHMENT_PREVIEW = "\U0001F4CE Attachment"  # "📎 Attachment"


def _error(error: str, **extra: Any) -> dict[str, Any]:
    return {"type": "error", "error": error, **extra}


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class ChatHandlers:
    def __init__(self, feature: "ChatFeature") -> None:
        self.feature = feature
        self.hub = feature.hub
        self.config = feature.config
        # (user_a, user_b) sorted -> chat_id; keeps typing indicators off the DB.
        self._pair_chat_ids: LRU[tuple[str, str], int] = LRU(20000)

    @property
    def policy(self) -> Any:
        # Read on every use: integrations (e.g. link_moderation) may wrap feature.policy after install.
        return self.feature.policy

    def register(self) -> None:
        on = self.hub.on
        on("req_users", self.req_users)
        on("get_messages", self.get_messages)
        on("send_message", self.send_message)
        on("mark_read", self.mark_read)
        on("typing", self.typing)
        on("media_upload", self.media_upload)
        on("delete_message", self.delete_message)
        on("clear_chat", self.clear_chat)

    async def _reply(self, user_id: str, payload: dict[str, Any]) -> None:
        await self.hub.send(user_id, payload)

    async def _failed(self, user_id: str, message: Any, exc: BaseException, error: str) -> None:
        logger.exception("%s failed", message.get("type") if isinstance(message, dict) else "chat handler")
        await self.hub.report_handler_error(user_id, message, exc)
        await self._reply(user_id, _error(error))

    async def _rate_limited(self, user_id: str, action: str, limit: RateLimit | None) -> float:
        """Seconds to wait (0 = allowed). Takes a token when allowed."""
        if limit is None:
            return 0.0
        return await self.hub.rate_limiter.hit(f"{action}:{user_id}", limit)

    # ------------------------------------------------------------- lists

    async def req_users(self, user_id: str, message: dict, session: AsyncSession) -> None:
        try:
            convs = [c for c in await ChatService(session).get_conversations(user_id) if c["other_user_id"] != user_id]
            other_ids = [c["other_user_id"] for c in convs]
            profiles = await self.hub.profiles(other_ids)
            online = await self.hub.connections.get_online_users(other_ids) if other_ids else set()
            blocks = await self.policy.block_status(session, user_id, other_ids) if other_ids else {}

            users = []
            for conv in convs:
                other = conv["other_user_id"]
                profile = profiles.get(other)
                last = conv["last_message"]
                is_blocked, blocked_by_other = blocks.get(other, (False, False))
                users.append({
                    "user_id": other,
                    "username": (profile.name if profile and profile.name else other),
                    "avatar": profile.avatar if profile else None,
                    "status": "online" if other in online else "offline",
                    "updated_at": last["timestamp"] if last else None,
                    "unread_count": conv["unread_count"],
                    "last_message": last,
                    "chat_id": conv["chat_id"],
                    "is_blocked": bool(is_blocked),
                    "blocked_by_other": bool(blocked_by_other),
                })
            users.sort(key=lambda u: (u["updated_at"] or "", str(u["user_id"])), reverse=True)
            await self._reply(user_id, {"type": "res_users", "users": users})
        except Exception as exc:
            logger.exception("req_users failed")
            await self.hub.report_handler_error(user_id, message, exc)
            await self._reply(user_id, {"type": "req_users_error", "error": f"Failed to retrieve users: {exc}"})

    async def get_messages(self, user_id: str, message: dict, session: AsyncSession) -> None:
        try:
            service = ChatService(session)
            cfg = self.config
            limit = max(1, min(int(message.get("limit", cfg.default_page_size)), cfg.max_page_size))
            offset = max(0, int(message.get("offset", 0)))

            chat_id = message.get("chat_id")
            if chat_id:
                chat = await service.get_chat_for_user(int(chat_id), user_id)
                if chat is None:
                    await self._reply(user_id, _error("Chat not found"))
                    return
                other_id = chat.other(user_id)
            else:
                other_id = message.get("candidate_user_id")
                if not other_id:
                    await self._reply(user_id, _error("Missing required fields: chat_id or candidate_user_id"))
                    return
                other_id = str(other_id)
                chat = await service.get_chat_between(user_id, other_id)

            rows = await service.get_messages_page(chat.id, limit=limit + 1, offset=offset, viewer_id=user_id) if chat else []
            has_more = len(rows) > limit
            rows = rows[:limit]
            if rows and offset == 0:
                last = rows[0]
            else:
                last = await service.get_last_message(chat.id, viewer_id=user_id) if chat else None

            profile = await self.hub.profile(other_id)
            blocks = await self.policy.block_status(session, user_id, [other_id])
            is_blocked, blocked_by_other = blocks.get(other_id, (False, False))
            info: dict[str, Any] = {
                "user_id": other_id,
                "username": profile.name if profile and profile.name else other_id,
                "avatar": profile.avatar if profile else None,
                "status": "online" if await self.hub.connections.is_online(other_id) else "offline",
                "last_seen": iso(last.created_at) if last else None,
                **(await self.policy.extra_conversation_info(session, user_id, other_id)),
                "is_blocked": bool(is_blocked),
                "blocked_by_other": bool(blocked_by_other),
            }
            previews = await service.get_reply_previews([m.reply_to_id for m in rows if m.reply_to_id])
            messages = [
                message_dto(m, user_id, reply_to=previews.get(m.reply_to_id) if m.reply_to_id else None)
                for m in rows
            ]
            await self._reply(user_id, {
                "type": "res_messages",
                "messages": messages,
                "offset": offset,
                "has_more": has_more,
                "info": info,
            })
        except Exception as exc:
            await self._failed(user_id, message, exc, f"Failed to retrieve messages: {exc}")

    # ----------------------------------------------------------- sending

    async def _allowed(self, session: AsyncSession, sender: str, recipient: str) -> bool:
        if sender == recipient:
            await self._reply(sender, _error("Cannot send a message to yourself."))
            return False
        if not await self.policy.can_message(session, sender, recipient):
            await self._reply(sender, _error(self.policy.refusal_message))
            return False
        return True

    async def send_text(
        self,
        session: AsyncSession,
        sender: str,
        recipient: str,
        content: Any,
        *,
        message_type: str = "text",
        reply_to_id: Any = None,
        check_policy: bool = True,
        rate_limit: bool = True,
    ) -> dict[str, Any]:
        """Store + deliver a message (WS ``send_message``, ``POST /chats/send``, ``send_message_as``).

        Returns the MessageDto as the sender sees it. Raises ``ChatActionError`` when refused."""
        if sender == recipient:
            raise ChatActionError("Cannot send a message to yourself.", status=400)
        text = content if isinstance(content, str) else str(content)
        max_len = self.config.max_text_length
        if max_len and len(text) > max_len:
            raise ChatActionError(f"Message is too long (max {max_len} characters).", "too_long", status=422,
                                  max=max_len)
        if rate_limit:
            wait = await self._rate_limited(sender, "chat.message", self.config.message_rate)
            if wait:
                seconds = retry_after_seconds(wait)
                raise ChatActionError(f"Too many messages. Try again in {seconds} s.", "rate_limited", status=429,
                                      retry_after=seconds)
        if check_policy and not await self.policy.can_message(session, sender, recipient):
            raise ChatActionError(self.policy.refusal_message, status=403)
        if message_type in RESERVED_TYPES:
            message_type = "text"

        service = ChatService(session)
        chat = await service.get_or_create_chat(sender, recipient)
        row = await service.send_message(chat.id, sender, text, message_type, reply_to_id=reply_to_id)
        reply_to = (await service.get_reply_previews([row.reply_to_id])).get(row.reply_to_id) if row.reply_to_id else None
        preview = text[: self.config.push_preview_chars] if message_type == "text" else ATTACHMENT_PREVIEW
        return await self._deliver(session, row, recipient, reply_to, recipient_content=text,
                                   sender_content=text, preview=preview)

    async def send_message(self, user_id: str, message: dict, session: AsyncSession) -> None:
        try:
            recipient = message.get("candidate_user_id")
            content = message.get("content")
            if not recipient or not content:
                await self._reply(user_id, _error("Missing required fields: candidate_user_id, content"))
                return
            await self.send_text(session, user_id, str(recipient), content,
                                 message_type=str(message.get("message_type") or "text"),
                                 reply_to_id=message.get("reply_to_id"))
        except ChatActionError as exc:
            await self._reply(user_id, exc.frame())
        except Exception as exc:
            await self._failed(user_id, message, exc, f"Failed to send message: {exc}")

    async def _deliver(
        self, session: AsyncSession, row: Any, recipient: str, reply_to: Any,
        recipient_content: Any, sender_content: Any, preview: str,
    ) -> dict[str, Any]:
        """new_message -> recipient, mark delivered, offline push, message_sent -> sender."""
        sender = row.sender_id
        delivered = await self.hub.send(recipient, {
            "type": "new_message",
            "message": message_dto(row, recipient, reply_to, content=recipient_content,
                                   is_read=False, is_delivered=True),
        })
        if delivered:
            await ChatService(session).mark_delivered([row.id])
        await self.notify_offline(recipient, sender, row.chat_id, preview)

        sent = message_dto(row, sender, reply_to, content=sender_content, is_read=False, is_delivered=delivered)
        await self.hub.send(sender, {"type": "message_sent", "message": sent})
        await self.hub.events.emit("chat.message_sent", sent)
        return sent

    async def notify_offline(
        self, recipient: str, sender: str, chat_id: int, preview: str,
        title: str | None = None, extra: Mapping[str, Any] | None = None,
    ) -> None:
        """Push when the recipient has no foreground socket anywhere."""
        if await self.hub.connections.is_online(recipient):
            return
        if title is None:
            title = await self.hub.display_name(sender, default="New message")
        data = dict(extra or {})
        data.update({
            "type": "chat",
            "cid": f"messaging:{sender}",  # legacy routing key used by installed apps
            "chat_id": chat_id,
            "sender_id": sender,
        })
        self.hub.spawn(self.hub.push(recipient, title, preview, data, channel=self.config.push_channel))

    # Kept for hosts that subclassed / patched the old private name.
    _notify_offline = notify_offline

    async def media_upload(self, user_id: str, message: dict, session: AsyncSession) -> None:
        recipient = message.get("target_user_id")
        file_name = message.get("file_name")
        file_data = message.get("file_data")
        if not recipient or not file_name or not file_data:
            await self._reply(user_id, _error("Missing required fields: target_user_id, file_name, file_data"))
            return
        recipient = str(recipient)
        max_bytes = self.config.max_upload_bytes
        too_large = _error(f"File too large. Maximum allowed size is {max_bytes // (1024 * 1024)} MB.")
        try:
            if not await self._allowed(session, user_id, recipient):
                return
            if not isinstance(file_data, str):
                await self._reply(user_id, _error("file_data must be a base64 string"))
                return
            # Reject before decoding so oversized payloads never hit memory twice.
            if len(file_data) > max_bytes * 4 // 3 + 4:
                await self._reply(user_id, too_large)
                return
            wait = await self._rate_limited(user_id, "chat.upload", self.config.upload_rate)
            if wait:
                seconds = retry_after_seconds(wait)
                await self._reply(user_id, _error(f"Too many uploads. Try again in {seconds} s.",
                                                  code="rate_limited", retry_after=seconds))
                return
            try:
                # Decoding 10 MB takes a while: keep it off the event loop.
                content_bytes = await asyncio.to_thread(base64.b64decode, file_data)
            except (binascii.Error, ValueError):
                await self._reply(user_id, _error("Invalid base64 file_data"))
                return
            if len(content_bytes) > max_bytes:
                await self._reply(user_id, too_large)
                return

            media_type = detect_media_type(str(file_name), message.get("media_type"))
            if media_type is None:
                await self._reply(user_id, _error(f"Unsupported file type: {file_name}"))
                return

            service = ChatService(session)
            # Always the chat between these two users; never trust a client chat_id.
            chat = await service.get_or_create_chat(user_id, recipient)
            try:
                media = await self.feature.storage.upload(chat.id, str(file_name), content_bytes, media_type)
            except ValueError as exc:
                await self._reply(user_id, _error(str(exc)))
                return
            if message.get("file_type") and not media.file_type:
                media.file_type = str(message["file_type"])

            content = f"[{media.media_type.upper()}] {file_name}"
            row = await service.send_message(
                chat.id, user_id, content, message_type=media.media_type, media=media,
                reply_to_id=message.get("reply_to_id"),
            )
            reply_to = (await service.get_reply_previews([row.reply_to_id])).get(row.reply_to_id) if row.reply_to_id else None
            await self._reply(user_id, {
                "type": "media_upload_success",
                "message": message_dto(row, user_id, reply_to, content=None, is_read=False, is_delivered=True),
            })
            await self._deliver(session, row, recipient, reply_to, recipient_content=content,
                                sender_content=None, preview=ATTACHMENT_PREVIEW)
        except Exception as exc:
            await self._failed(user_id, message, exc, f"Server error: {exc}")

    # ---------------------------------------------------- receipts/typing

    async def resolve_chat(
        self, service: ChatService, user_id: str, chat_id: Any, candidate_user_id: Any,
    ) -> ChatRow | None:
        """``chat_id`` wins; otherwise the chat with ``candidate_user_id``. None if not a participant."""
        cid = _int_or_none(chat_id)
        if cid is not None:
            return await service.get_chat_for_user(cid, user_id)
        if candidate_user_id not in (None, "") and str(candidate_user_id) != user_id:
            return await service.get_chat_between(user_id, str(candidate_user_id))
        return None

    async def mark_read(self, user_id: str, message: dict, session: AsyncSession) -> None:
        chat_id, candidate = message.get("chat_id"), message.get("candidate_user_id")
        if not chat_id and not candidate:
            await self._reply(user_id, _error("Missing chat_id"))
            return
        service = ChatService(session)
        chat = await self.resolve_chat(service, user_id, chat_id, candidate)
        if chat is None:
            await self._reply(user_id, _error("Chat not found"))
            return
        await service.mark_messages_as_read(chat.id, user_id)
        await self.notify_read(chat.id, user_id, chat.other(user_id))

    async def notify_read(self, chat_id: int, reader: str, other: str) -> None:
        # Reader's own sockets clear the badge; the other side sees blue ticks.
        await self.hub.send(reader, {"type": "chat_read", "chat_id": chat_id})
        await self.hub.send(other, {"type": "messages_read", "chat_id": chat_id, "read_by": reader})

    async def typing(self, user_id: str, message: dict, session: AsyncSession) -> None:
        target = message.get("target_user_id")
        if not target or str(target) == user_id:
            return
        target = str(target)
        is_typing = bool(message.get("is_typing", False))
        # Only "started typing" counts against the limit, so a stop frame always gets through.
        if is_typing and await self._rate_limited(user_id, "chat.typing", self.config.typing_rate):
            return
        if not await self.policy.can_message(session, user_id, target):
            return
        pair = (min(user_id, target), max(user_id, target))
        chat_id = self._pair_chat_ids.get(pair)
        if chat_id is None:
            chat = await ChatService(session).get_chat_between(user_id, target)
            if chat is None:
                return
            chat_id = chat.id
            self._pair_chat_ids.put(pair, chat_id)
        await self.hub.send(target, {
            "type": "typing_status",
            "user_id": user_id,
            "chat_id": chat_id,
            "is_typing": is_typing,
            "timestamp": now_iso(),
        })

    # ------------------------------------------------------ delete / clear

    async def delete_message(self, user_id: str, message: dict, session: AsyncSession) -> None:
        message_id = _int_or_none(message.get("message_id"))
        if message_id is None:
            await self._reply(user_id, _error("Missing required fields: message_id", code="not_found"))
            return
        try:
            await self.delete_for(session, user_id, message_id, bool(message.get("for_everyone", False)))
        except ChatActionError as exc:
            await self._reply(user_id, exc.frame())
        except Exception as exc:
            await self._failed(user_id, message, exc, f"Failed to delete message: {exc}")

    async def delete_for(self, session: AsyncSession, user_id: str, message_id: int, for_everyone: bool) -> dict[str, Any]:
        """Delete for me / unsend for everyone. Sends ``message_deleted``; raises ``ChatActionError``."""
        service = ChatService(session)
        row = await service.get_message(message_id)
        chat = await service.get_chat_for_user(row.chat_id, user_id) if row is not None else None
        if row is None or chat is None:
            raise ChatActionError("Message not found", "not_found", status=404)
        payload = {"type": "message_deleted", "chat_id": row.chat_id, "message_id": row.id,
                   "for_everyone": for_everyone}
        if not for_everyone:
            await service.hide_message(user_id, row.id)
            await self.hub.send(user_id, payload)
            await self.hub.events.emit("chat.message_deleted", dict(payload, user_id=user_id))
            return payload

        window = int(self.config.unsend_window_seconds)
        if window < 0:
            raise ChatActionError("Deleting for everyone is disabled", "not_allowed", status=403)
        if row.sender_id != user_id:
            raise ChatActionError("Only the sender can delete a message for everyone", "not_allowed", status=403)
        if row.call_id or row.message_type == SYSTEM_TYPE:
            raise ChatActionError("This message can't be deleted for everyone", "not_allowed", status=403)
        if row.message_type != DELETED_TYPE:  # unsending twice just repeats the event
            _, urls = await service.unsend_message(row.id, window)
            if urls:
                self.hub.spawn(delete_media(self.feature.storage, *urls))
        await self.hub.send(user_id, payload)
        await self.hub.send(chat.other(user_id), payload)
        await self.hub.events.emit("chat.message_deleted", dict(payload, user_id=user_id))
        return payload

    async def clear_chat(self, user_id: str, message: dict, session: AsyncSession) -> None:
        chat_id, candidate = message.get("chat_id"), message.get("candidate_user_id")
        try:
            if not chat_id and not candidate:
                raise ChatActionError("Missing required fields: chat_id or candidate_user_id", "not_found", status=404)
            await self.clear_for(session, user_id, chat_id, candidate)
        except ChatActionError as exc:
            await self._reply(user_id, exc.frame())
        except Exception as exc:
            await self._failed(user_id, message, exc, f"Failed to clear chat: {exc}")

    async def clear_for(self, session: AsyncSession, user_id: str, chat_id: Any, candidate: Any) -> dict[str, Any]:
        service = ChatService(session)
        chat = await self.resolve_chat(service, user_id, chat_id, candidate)
        if chat is None:
            raise ChatActionError("Chat not found", "not_found", status=404)
        cleared_at = await service.clear_chat(user_id, chat.id)
        payload = {"type": "chat_cleared", "chat_id": chat.id, "cleared_at": iso(cleared_at)}
        await self.hub.send(user_id, payload)
        return payload

    # ----------------------------------------------------------- connect

    async def on_connect(self, user_id: str, websocket: WebSocket) -> None:
        """Flush delivery receipts for messages that arrived while the user was offline."""
        async with self.hub.session_factory() as session:
            rows = await ChatService(session).mark_delivered_for_recipient(user_id)
        grouped: dict[tuple[int, str], list[int]] = {}
        for chat_id, sender_id, message_id in rows:
            grouped.setdefault((chat_id, sender_id), []).append(message_id)
        for (chat_id, sender_id), ids in grouped.items():
            await self.hub.send(sender_id, {
                "type": "delivery_status",
                "chat_id": chat_id,
                "message_ids": sorted(ids),
                "status": "delivered",
                "timestamp": now_iso(),
            })
