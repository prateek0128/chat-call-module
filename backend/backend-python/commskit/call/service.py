"""CallService: call rows and their state machine (ported from matrimonial-backend-v2).

State changes are conditional UPDATEs (``WHERE call_status = <expected>``) so
hangup / timeout / disconnect racing on different workers finalize a call once.
Timestamps come from the DB clock (``db_now``), never the app server.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import timedelta
from typing import TYPE_CHECKING

from sqlalchemy import desc, or_, and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.db import db_now
from commskit.core.util import to_naive_utc

from .config import CallConfig
from .models import Call

if TYPE_CHECKING:
    from .bridge import CallChatBridge

ACTIVE_CALL_STATUSES = ("ringing", "answered")


@dataclass
class CallInfo:
    call_id: str
    chat_id: int | None
    caller_id: str
    receiver_id: str
    is_video_call: bool
    status: str
    duration: int = 0
    end_reason: str | None = None
    # Filled by a chat bridge during finalize: the call's chat entry.
    message_id: int | None = None
    log_text: str | None = None

    @classmethod
    def from_row(cls, call: Call) -> "CallInfo":
        return cls(
            call_id=call.call_id,
            chat_id=call.chat_id,
            caller_id=call.caller_id,
            receiver_id=call.receiver_id,
            is_video_call=bool(call.is_video_call),
            status=call.call_status,
            duration=call.duration or 0,
            end_reason=call.end_reason,
        )

    @property
    def call_type(self) -> str:
        return "video" if self.is_video_call else "audio"

    def other_party(self, user_id: str) -> str | None:
        if user_id == self.caller_id:
            return self.receiver_id
        if user_id == self.receiver_id:
            return self.caller_id
        return None


def call_log_text(status: str, is_video_call: bool, duration: int, end_reason: str | None = None) -> str:
    """"Voice call · 05:42", "Missed voice call", "Declined voice call".

    A caller-cancelled call is logged as "Missed" too: installed apps only parse
    "Missed"/"Declined" (end_reason still records caller_cancelled).
    """
    kind = "Video call" if is_video_call else "Voice call"
    if status == "missed":
        return f"Missed {kind.lower()}"
    if status == "rejected":
        return f"Declined {kind.lower()}"
    hours, rem = divmod(max(0, int(duration)), 3600)
    mins, secs = divmod(rem, 60)
    clock = f"{hours}:{mins:02d}:{secs:02d}" if hours else f"{mins:02d}:{secs:02d}"
    return f"{kind} · {clock}"


class CallService:
    def __init__(
        self,
        session: AsyncSession,
        config: CallConfig | None = None,
        bridge: "CallChatBridge | None" = None,
    ) -> None:
        self.session = session
        self.config = config or CallConfig()
        self.bridge = bridge

    async def create_call(
        self, chat_id: int | None, caller_id: str, receiver_id: str, is_video_call: bool = False
    ) -> CallInfo:
        now = await db_now(self.session)
        call = Call(
            call_id=str(uuid.uuid4()),
            chat_id=chat_id,
            caller_id=caller_id,
            receiver_id=receiver_id,
            call_status="ringing",
            is_video_call=is_video_call,
            started_at=now,
        )
        info = CallInfo(call.call_id, chat_id, caller_id, receiver_id, is_video_call, "ringing")
        self.session.add(call)
        await self.session.commit()
        return info

    async def get_call(self, call_id: str) -> Call | None:
        # populate_existing: status may have changed via a conditional UPDATE / another worker.
        result = await self.session.execute(
            select(Call).where(Call.call_id == call_id).execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def get_call_info(self, call_id: str) -> CallInfo | None:
        call = await self.get_call(call_id)
        return CallInfo.from_row(call) if call else None

    async def save_offer_sdp(self, call_id: str, offer_sdp: str) -> None:
        await self.session.execute(
            update(Call).where(Call.call_id == call_id).values(offer_sdp=offer_sdp)
            .execution_options(synchronize_session=False)
        )
        await self.session.commit()

    async def get_offer_sdp(self, call_id: str) -> str | None:
        result = await self.session.execute(select(Call.offer_sdp).where(Call.call_id == call_id))
        return result.scalar_one_or_none()

    async def _live_calls_query(self, user_id: str):  # type: ignore[no-untyped-def]
        now = await db_now(self.session)
        cfg = self.config
        ring_cutoff = now - timedelta(seconds=cfg.ring_timeout + cfg.ring_window_slack)
        answered_cutoff = now - timedelta(hours=cfg.max_call_hours)
        return (
            select(Call)
            .where(
                or_(Call.caller_id == user_id, Call.receiver_id == user_id),
                or_(
                    and_(Call.call_status == "ringing", Call.started_at >= ring_cutoff),
                    and_(Call.call_status == "answered", Call.answered_at >= answered_cutoff),
                ),
            )
            .order_by(desc(Call.started_at), desc(Call.id))
            .execution_options(populate_existing=True)
        )

    async def get_active_call_for_user(self, user_id: str) -> CallInfo | None:
        result = await self.session.execute((await self._live_calls_query(user_id)).limit(1))
        call = result.scalars().first()
        return CallInfo.from_row(call) if call else None

    async def get_active_calls_for_user(self, user_id: str) -> list[CallInfo]:
        result = await self.session.execute(await self._live_calls_query(user_id))
        return [CallInfo.from_row(c) for c in result.scalars().all()]

    async def mark_answered(self, call_id: str, receiver_id: str) -> CallInfo | None:
        """ringing -> answered. Only the receiver can answer, and only once."""
        now = await db_now(self.session)
        result = await self.session.execute(
            update(Call)
            .where(Call.call_id == call_id, Call.receiver_id == receiver_id, Call.call_status == "ringing")
            .values(call_status="answered", answered_at=now)
            .execution_options(synchronize_session=False)
        )
        await self.session.commit()
        if result.rowcount != 1:
            return None
        return await self.get_call_info(call_id)

    async def finalize_call(
        self,
        call_id: str,
        status: str,
        end_reason: str,
        only_from: tuple[str, ...] = ACTIVE_CALL_STATUSES,
    ) -> CallInfo | None:
        """Move a live call to a terminal status. None if another path already did."""
        call = await self.get_call(call_id)
        if call is None or call.call_status not in only_from:
            return None
        from_status = call.call_status
        snapshot = CallInfo.from_row(call)
        answered_at = call.answered_at

        now = await db_now(self.session)
        duration = 0
        if from_status == "answered" and answered_at is not None:
            duration = max(0, int((to_naive_utc(now) - to_naive_utc(answered_at)).total_seconds()))

        values: dict[str, object] = {
            "call_status": status, "end_reason": end_reason, "ended_at": now, "duration": duration,
        }
        if status == "missed":
            values["missed_at"] = now
        result = await self.session.execute(
            update(Call)
            .where(Call.call_id == call_id, Call.call_status == from_status)
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:
            await self.session.rollback()
            return None

        info = replace(snapshot, status=status, duration=duration, end_reason=end_reason)
        if self.bridge is not None:
            # Same transaction: the chat entry flips to the log text with the status.
            await self.bridge.on_call_finalizing(self.session, info)
        await self.session.commit()
        return info
