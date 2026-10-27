"""Moderation wiring: the block list in front of the chat / call policies, and live
calls between a pair end when one blocks the other.

``commskit.moderation`` never imports chat or call; it emits ``moderation.blocked`` on
the hub's event bus and exposes policy wrappers. This module connects the two sides.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from commskit.moderation import ModerationFeature
from commskit.moderation.policy import ModerationCallPolicy, ModerationChatPolicy

if TYPE_CHECKING:
    from commskit.call import CallFeature
    from commskit.chat import ChatFeature

BLOCKED_END_REASON = "blocked"


@dataclass
class ModerationLink:
    moderation: ModerationFeature
    chat: "ChatFeature | None" = None
    call: "CallFeature | None" = None

    async def end_calls_on_block(self, blocker_id: str, blocked_id: str) -> None:
        """``moderation.blocked`` listener."""
        if self.call is not None:
            await self.call.lifecycle.end_calls_between(blocker_id, blocked_id, BLOCKED_END_REASON, ended_by=blocker_id)

    async def report_messages(
        self, reporter_id: str | None, reported_id: str | None, message_id: int | None, before: int, after: int,
    ) -> list[dict[str, Any]]:
        """``ModerationFeature.context_provider``: MessageDtos (as the reporter sees them, newest first)
        around ``message_id`` in the pair's chat, or the latest ones. Hides / clears are ignored."""
        if self.chat is None or not reporter_id or not reported_id:
            return []
        from commskit.chat import ChatService, message_dto

        async with self.chat.hub.session_factory() as session:
            service = ChatService(session)
            chat = await service.get_chat_between(reporter_id, reported_id)
            if chat is None:
                return []
            rows = await service.messages_around(chat.id, message_id, before, after)
            previews = await service.get_reply_previews([m.reply_to_id for m in rows if m.reply_to_id])
        return [message_dto(m, reporter_id, previews.get(m.reply_to_id) if m.reply_to_id else None) for m in rows]


def link_moderation(
    moderation: ModerationFeature,
    chat: "ChatFeature | None" = None,
    call: "CallFeature | None" = None,
) -> ModerationLink:
    """Install-time wiring; all given features must be installed on the same hub.

    - ``chat.policy`` becomes ``moderation.chat_policy(<previous policy>)``: a blocked pair
      cannot ``send_message`` / ``media_upload`` (error) or ``typing`` (dropped), and
      ``res_users`` / ``res_messages.info`` carry ``is_blocked`` / ``blocked_by_other``.
    - ``call.policy`` becomes ``moderation.call_policy(<previous policy>)``: ``call_initiate``
      to/from a blocked user gets ``{"type":"error","context":"call",...}`` before the host
      policy runs (no credits charged).
    - on block, live calls between the pair end with ``end_reason: "blocked"``.
    - with chat: ``moderation.context_provider`` (unless the host set one) reads the chat tables
      for the admin ``/moderation/admin/reports/{id}/context`` route.

    Policies already wrapped (e.g. ``ChatFeature(policy=moderation.chat_policy(...))``) are
    not wrapped twice.
    """
    hub = moderation.hub
    for feature in (chat, call):
        if feature is not None and feature.hub is not hub:
            raise ValueError("moderation, chat and call must be installed on the same CommsHub")
    if getattr(moderation, "_link", None) is not None:
        raise RuntimeError("moderation is already linked")

    if chat is not None and not isinstance(chat.policy, ModerationChatPolicy):
        chat.policy = moderation.chat_policy(chat.policy)
    if call is not None and not isinstance(call.policy, ModerationCallPolicy):
        call.policy = moderation.call_policy(call.policy)

    link = ModerationLink(moderation, chat, call)
    if chat is not None and moderation.context_provider is None:
        moderation.context_provider = link.report_messages
    hub.events.on("moderation.blocked", link.end_calls_on_block)
    moderation._link = link  # type: ignore[attr-defined]
    return link

