"""ChatFeature(...).install(hub)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping

from commskit.core.adapters import DeviceRegistry, LocalDiskStorage, MediaStorage, delete_media
from commskit.core.ratelimit import RateLimit

from .dto import message_dto
from .handlers import ChatHandlers
from .policy import AllowAllChatPolicy, ChatPolicy
from .router import build_chat_router
from .service import SYSTEM_TYPE, ChatService

if TYPE_CHECKING:
    from commskit.core.hub import CommsHub


@dataclass
class ChatConfig:
    max_upload_bytes: int = 10 * 1024 * 1024
    default_page_size: int = 10
    max_page_size: int = 100
    push_preview_chars: int = 120
    push_channel: str = "messages"  # Android channel created natively by the app

    # PROTOCOL.md section 9 "Limits". None disables a limit; max_text_length 0 = unlimited.
    max_text_length: int = 4000
    message_rate: RateLimit | None = RateLimit(20, 10)  # send_message, POST /chats/send
    upload_rate: RateLimit | None = RateLimit(5, 60)  # media_upload
    typing_rate: RateLimit | None = RateLimit(5, 5)  # typing (is_typing=true); dropped silently

    # Unsend ("delete for everyone"): seconds after sending; 0 = no limit, -1 = disabled.
    unsend_window_seconds: int = 3600

    # System messages without about_user_id go into a chat with this id (None: about_user_id required).
    system_sender_id: str | None = None
    # Push title for system messages (None: the about-user's name, else "Notification").
    system_push_title: str | None = None


class ChatFeature:
    """1:1 chat. ``devices`` (optional) enables the push-token REST routes."""

    name = "chat"

    def __init__(
        self,
        policy: ChatPolicy | None = None,
        storage: MediaStorage | None = None,
        devices: DeviceRegistry | None = None,
        config: ChatConfig | None = None,
    ) -> None:
        self.policy: ChatPolicy = policy or AllowAllChatPolicy()
        self.storage: MediaStorage = storage or LocalDiskStorage()
        self.devices = devices
        self.config = config or ChatConfig()
        self._hub: "CommsHub | None" = None
        self.handlers: ChatHandlers

    @property
    def hub(self) -> "CommsHub":
        if self._hub is None:
            raise RuntimeError("ChatFeature is not installed; call .install(hub) first")
        return self._hub

    def install(self, hub: "CommsHub") -> "ChatFeature":
        hub.register_feature(self.name, self)
        self._hub = hub
        self.handlers = ChatHandlers(self)
        self.handlers.register()
        hub.on_connect(self.handlers.on_connect)
        hub.connections.set_partners_lookup(self.partner_ids)
        hub.include_router(build_chat_router(self))
        return self

    async def partner_ids(self, user_id: str) -> list[str]:
        """Conversation partners (receivers of this user's ``user_status``)."""
        async with self.hub.session_factory() as session:
            return await ChatService(session).partner_ids(user_id)

    # ------------------------------------------------------- server-side API

    async def send_message_as(
        self,
        sender_id: str,
        to_user_id: str,
        content: str,
        reply_to_id: int | None = None,
        *,
        enforce_policy: bool = False,
    ) -> dict[str, Any]:
        """Send a text message as ``sender_id`` from trusted server code (bots, admin tools, tests).

        Same storage, events and push as WS ``send_message``; no rate limit. The chat policy is only
        checked with ``enforce_policy=True``. Returns the MessageDto as the sender sees it; raises
        ``ChatActionError`` (self-message, too long, policy)."""
        async with self.hub.session_factory() as session:
            return await self.handlers.send_text(
                session, str(sender_id), str(to_user_id), content, reply_to_id=reply_to_id,
                check_policy=enforce_policy, rate_limit=False,
            )

    async def send_system_message(
        self,
        to_user_id: str,
        content: str,
        *,
        about_user_id: str | None = None,
        data: Mapping[str, Any] | None = None,
        push: bool = True,
    ) -> dict[str, Any]:
        """A ``message_type: "system"`` message shown to ``to_user_id`` only (e.g. "You matched with Asha").

        It goes into the chat between ``to_user_id`` and ``about_user_id`` (created if needed), stored
        with ``sender_id = about_user_id`` and hidden for ``about_user_id``. Without ``about_user_id``,
        ``ChatConfig.system_sender_id`` is used as the chat partner (``ValueError`` if neither is set).
        ``data`` is added to the live frame (``message.data``) and to the push data; it is not stored.
        Returns the MessageDto as ``to_user_id`` sees it."""
        to_user_id = str(to_user_id)
        sender = str(about_user_id) if about_user_id not in (None, "") else self.config.system_sender_id
        if not sender:
            raise ValueError("send_system_message needs about_user_id (or ChatConfig.system_sender_id)")
        if sender == to_user_id:
            raise ValueError("about_user_id must differ from to_user_id")
        text = str(content)
        hub = self.hub
        async with hub.session_factory() as session:
            service = ChatService(session)
            chat = await service.get_or_create_chat(to_user_id, sender)
            row = await service.send_message(chat.id, sender, text, SYSTEM_TYPE)
            if about_user_id not in (None, ""):
                await service.hide_message(sender, row.id)
            dto = message_dto(row, to_user_id, None, is_read=False, is_delivered=True)
            if data:
                dto["data"] = dict(data)
            delivered = await hub.send(to_user_id, {"type": "new_message", "message": dto})
            if delivered:
                await service.mark_delivered([row.id])
        if push:
            title = self.config.system_push_title
            if title is None:
                title = await hub.display_name(sender, default="Notification") if about_user_id else "Notification"
            await self.handlers.notify_offline(
                to_user_id, sender, row.chat_id, text[: self.config.push_preview_chars], title=title,
                extra={**dict(data or {}), "system": True},
            )
        dto["is_delivered"] = delivered
        await hub.events.emit("chat.system_message_sent", dict(dto))
        return dto

    async def delete_user_data(self, user_id: str) -> dict[str, int]:
        """Account deletion: every chat ``user_id`` is in, all its messages (the partner's view of the
        conversation goes too: a 1:1 chat has one copy), hides / clears, and the stored media
        (through ``MediaStorage.delete`` when the storage has it). Returns counts."""
        user_id = str(user_id)
        async with self.hub.session_factory() as session:
            counts, urls = await ChatService(session).delete_user_data(user_id)
        counts["media"] = await delete_media(self.storage, *urls)
        self.handlers._pair_chat_ids.discard_where(lambda pair: user_id in pair)
        return counts
