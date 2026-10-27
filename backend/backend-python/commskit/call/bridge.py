"""Hook points a chat integration plugs into (``CallFeature.chat_bridge``).

The call feature never imports chat; ``commskit.integration`` implements this.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from .service import CallInfo


class CallChatBridge(Protocol):
    async def resolve_chat_id(
        self, session: AsyncSession, caller_id: str, receiver_id: str, requested_chat_id: object
    ) -> int | None:
        """chat_id stored on the call (``None`` = no chat)."""
        ...

    async def on_call_created(self, session: AsyncSession, info: "CallInfo") -> None:
        """Call row committed; e.g. insert the "[Call Initiated]" chat entry."""
        ...

    async def on_call_finalizing(self, session: AsyncSession, info: "CallInfo") -> None:
        """Inside the finalize transaction (do not commit). May set
        ``info.message_id`` / ``info.log_text``; they are committed atomically
        with the terminal status."""
        ...
