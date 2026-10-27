"""ChatPolicy: host rules for who may message whom (blocking, consent...)."""

from __future__ import annotations

from typing import Any, Mapping, Protocol, Sequence

from sqlalchemy.ext.asyncio import AsyncSession


class ChatPolicy(Protocol):
    # Sent as {"type":"error","error": refusal_message} when can_message is False.
    refusal_message: str

    async def can_message(self, session: AsyncSession, sender_id: str, recipient_id: str) -> bool:
        """False refuses send_message / media_upload and silently drops typing."""
        ...

    async def block_status(
        self, session: AsyncSession, viewer_id: str, other_ids: Sequence[str]
    ) -> Mapping[str, tuple[bool, bool]]:
        """{other_id: (is_blocked, blocked_by_other)}; missing ids = (False, False)."""
        ...

    async def extra_conversation_info(
        self, session: AsyncSession, viewer_id: str, other_id: str
    ) -> Mapping[str, Any]:
        """Merged into ``res_messages.info`` (e.g. ``chat_consent_given``)."""
        ...


class AllowAllChatPolicy:
    """Default: everyone may message everyone, nobody is blocked."""

    refusal_message = "Cannot send message. User is blocked."

    async def can_message(self, session: AsyncSession, sender_id: str, recipient_id: str) -> bool:
        return True

    async def block_status(
        self, session: AsyncSession, viewer_id: str, other_ids: Sequence[str]
    ) -> Mapping[str, tuple[bool, bool]]:
        return {}

    async def extra_conversation_info(
        self, session: AsyncSession, viewer_id: str, other_id: str
    ) -> Mapping[str, Any]:
        return {"chat_consent_given": True}
