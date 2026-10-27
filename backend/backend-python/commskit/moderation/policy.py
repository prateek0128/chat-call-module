"""Chat / call policy wrappers that put the block list in front of the host's own policy.

They match ``commskit.chat.ChatPolicy`` and ``commskit.call.CallPolicy`` structurally
(duck typing), so this package never imports chat or call::

    ChatFeature(policy=moderation.chat_policy(MyChatPolicy()))
    CallFeature(policy=moderation.call_policy(MyCreditPolicy()))

or let ``commskit.integration.link_moderation`` wrap the installed features' policies.
A blocked pair (either direction) is refused *before* the inner policy runs, so e.g. a
credit-charging call policy never charges for a call that would be refused anyway.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from .service import ModerationService

CHAT_REFUSAL = "Cannot send message. User is blocked."
CALL_REFUSAL = "Cannot call. User is blocked."

# The chat feature reads ``policy.refusal_message`` right after ``can_message`` returned
# False, in the same task; this remembers whose refusal it was (the block list or the inner policy).
_last_refusal: ContextVar[str | None] = ContextVar("commskit_moderation_refusal", default=None)


@dataclass
class ModerationDecision:
    """Same shape as ``commskit.call.CallDecision`` (``allowed``, ``error``)."""

    allowed: bool
    error: dict[str, Any] | None = None


class ModerationChatPolicy:
    def __init__(self, inner: Any = None, refusal_message: str = CHAT_REFUSAL) -> None:
        self.inner = inner
        self.blocked_message = refusal_message

    @property
    def refusal_message(self) -> str:
        last = _last_refusal.get()
        if last is not None:
            return last
        return getattr(self.inner, "refusal_message", None) or self.blocked_message

    async def can_message(self, session: AsyncSession, sender_id: str, recipient_id: str) -> bool:
        if await ModerationService(session).is_blocked_between(sender_id, recipient_id):
            _last_refusal.set(self.blocked_message)
            return False
        if self.inner is not None and not await self.inner.can_message(session, sender_id, recipient_id):
            _last_refusal.set(getattr(self.inner, "refusal_message", None) or self.blocked_message)
            return False
        _last_refusal.set(None)
        return True

    async def block_status(
        self, session: AsyncSession, viewer_id: str, other_ids: Sequence[str]
    ) -> Mapping[str, tuple[bool, bool]]:
        """Kit block list OR the inner policy's (e.g. a legacy host block table)."""
        merged = dict(await ModerationService(session).block_status(viewer_id, other_ids))
        if self.inner is not None:
            for other, (blocked, by_other) in (await self.inner.block_status(session, viewer_id, other_ids)).items():
                mine = merged.get(other, (False, False))
                merged[other] = (mine[0] or bool(blocked), mine[1] or bool(by_other))
        return merged

    async def extra_conversation_info(
        self, session: AsyncSession, viewer_id: str, other_id: str
    ) -> Mapping[str, Any]:
        if self.inner is not None:
            return await self.inner.extra_conversation_info(session, viewer_id, other_id)
        return {"chat_consent_given": True}


class ModerationCallPolicy:
    def __init__(self, inner: Any = None, refusal_message: str = CALL_REFUSAL) -> None:
        self.inner = inner
        self.blocked_message = refusal_message

    async def authorize(self, session: AsyncSession, caller_id: str, receiver_id: str, message: dict) -> Any:
        if await ModerationService(session).is_blocked_between(caller_id, receiver_id):
            return ModerationDecision(False, {"error": self.blocked_message, "reason": "blocked"})
        if self.inner is not None:
            return await self.inner.authorize(session, caller_id, receiver_id, message)
        return ModerationDecision(True)
