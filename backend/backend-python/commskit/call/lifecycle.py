"""Call lifecycle: finishing calls, ring timeout, disconnect grace, re-ring, pushes."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

from fastapi import WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.util import LRU

from .payloads import call_payload
from .service import ACTIVE_CALL_STATUSES, CallInfo, CallService

if TYPE_CHECKING:
    from .feature import CallFeature

logger = logging.getLogger("commskit.call")


def end_status(call: CallInfo, from_user: str) -> tuple[str, str]:
    """(terminal status, end_reason) for a hangup/reject by ``from_user``."""
    if call.status == "answered":
        return "ended", "hangup"
    if from_user == call.caller_id:
        return "missed", "caller_cancelled"
    return "rejected", "declined"


class CallLifecycle:
    def __init__(self, feature: "CallFeature") -> None:
        self.feature = feature
        self.hub = feature.hub
        self.config = feature.config
        # call_id -> (caller_id, receiver_id): participants never change, so this
        # per-worker cache keeps ICE relaying off the DB.
        self.parties: LRU[str, tuple[str, str]] = LRU(5000)

    def service(self, session: AsyncSession) -> CallService:
        return CallService(session, self.config, self.feature.chat_bridge)

    def remember(self, info: CallInfo) -> None:
        self.parties.put(info.call_id, (info.caller_id, info.receiver_id))

    async def finalized(self, info: CallInfo) -> None:
        """Emit ``call.finalized`` (chat integration sends ``call_log`` from it)."""
        await self.hub.events.emit("call.finalized", info)

    async def load_call_for(self, session: AsyncSession, call_id: str, user_id: str) -> CallInfo | None:
        """The call, only if ``user_id`` is a participant."""
        call = await self.service(session).get_call_info(str(call_id))
        if call is None or call.other_party(user_id) is None:
            return None
        self.remember(call)
        return call

    # ----------------------------------------------------------- finishing

    async def finish_call(self, session: AsyncSession, call: CallInfo, from_user: str) -> None:
        """Hangup / reject / cancel by ``from_user``; outcome decided from call state."""
        service = self.service(session)
        info: CallInfo | None = None
        reason = ""
        # Two attempts: if the call changed state underneath us (caller cancels as
        # the receiver answers), re-read it and end it from its real state.
        for _ in range(2):
            if call.status not in ACTIVE_CALL_STATUSES:
                break
            status, reason = end_status(call, from_user)
            info = await service.finalize_call(call.call_id, status, reason, only_from=(call.status,))
            if info:
                break
            call = await service.get_call_info(call.call_id) or call

        if info is None:
            # Already over: just tell this user's sockets so their UI stops.
            await self.hub.send(from_user, call_payload(
                "call_ended", call, status="call_ended", end_reason=call.status,
                ended_by=from_user, duration_seconds=call.duration, caller_name=call.caller_id,
            ))
            return

        rejected = info.status == "rejected"
        # Legacy: caller_name carries the caller's id in these frames.
        payload = call_payload(
            "call_rejected" if rejected else "call_ended", info,
            status="call_rejected" if rejected else "call_ended",
            end_reason=reason,
            duration_seconds=info.duration,
            caller_name=info.caller_id,
            **({"rejector_id": from_user} if rejected else {"ended_by": from_user}),
        )
        other = info.other_party(from_user)
        if other:
            await self.hub.send(other, payload)
        await self.hub.send(from_user, payload)
        await self.finalized(info)
        if info.status == "missed" and from_user == info.caller_id:
            # Caller hung up while ringing: stop the ringing on a closed app.
            self.hub.spawn(self.push_missed_call(info))

    async def end_calls_between(self, user_a: str, user_b: str, end_reason: str, ended_by: str | None = None) -> list[CallInfo]:
        """End every live call between two users with ``end_reason`` (e.g. ``"blocked"``).

        Answered calls become ``ended``, ringing ones ``missed``. Both parties get
        ``call_ended``; ``call.finalized`` is emitted (call_log when chat is linked).
        Used by ``commskit.integration.link_moderation``; the call feature itself does
        not know why.
        """
        ended: list[CallInfo] = []
        async with self.hub.session_factory() as session:
            service = self.service(session)
            for call in await service.get_active_calls_for_user(user_a):
                if call.other_party(user_a) != user_b:
                    continue
                to_status = "ended" if call.status == "answered" else "missed"
                info = await service.finalize_call(call.call_id, to_status, end_reason, only_from=(call.status,))
                if info:
                    ended.append(info)
        for info in ended:
            payload = call_payload(
                "call_ended", info, status="call_ended", end_reason=end_reason,
                ended_by=ended_by or user_a, duration_seconds=info.duration, caller_name=info.caller_id,
            )
            await self.hub.send(info.caller_id, payload)
            await self.hub.send(info.receiver_id, payload)
            await self.finalized(info)
            if info.status == "missed":
                self.hub.spawn(self.push_missed_call(info))  # stop a ringing notification on a closed app
        return ended

    async def reject_from_notification(self, session: AsyncSession, call_id: str, user_id: str) -> bool:
        call = await self.load_call_for(session, call_id, user_id)
        if call is None:
            return False
        await self.finish_call(session, call, user_id)
        return True

    # -------------------------------------------------------------- timers

    async def expire_unanswered(self, call_id: str) -> None:
        """Ring timeout: ringing -> missed (no_answer)."""
        await asyncio.sleep(self.config.ring_timeout)
        try:
            async with self.hub.session_factory() as session:
                info = await self.service(session).finalize_call(call_id, "missed", "no_answer", only_from=("ringing",))
            if info is None:
                return
            payload = call_payload("call_missed", info, status="missed", end_reason="no_answer")
            await self.hub.send(info.caller_id, payload)
            await self.hub.send(info.receiver_id, payload)
            await self.finalized(info)
            await self.push_missed_call(info)
        except Exception:
            logger.exception("Ring timeout handling failed for %s", call_id)

    async def _end_user_calls(self, user_id: str, from_status: str, to_status: str) -> None:
        ended: list[CallInfo] = []
        async with self.hub.session_factory() as session:
            service = self.service(session)
            for call in await service.get_active_calls_for_user(user_id):
                if call.status != from_status:
                    continue
                info = await service.finalize_call(call.call_id, to_status, "disconnected", only_from=(from_status,))
                if info:
                    ended.append(info)
        for info in ended:
            other = info.other_party(user_id)
            if other:
                await self.hub.send(other, call_payload(
                    "call_ended", info, status="call_ended", ended_by=user_id,
                    end_reason="disconnected", duration_seconds=info.duration,
                ))
            await self.finalized(info)

    async def end_calls_after_disconnect(self, user_id: str) -> None:
        """Last socket closed: after a grace period end calls the user is still in.

        Answered calls get longer: mobile OSes drop the socket on backgrounding
        while WebRTC audio keeps flowing.
        """
        cfg = self.config
        try:
            await asyncio.sleep(cfg.ringing_disconnect_grace)
            if await self.hub.connections.is_connected(user_id):
                return
            await self._end_user_calls(user_id, "ringing", "missed")

            await asyncio.sleep(max(0.0, cfg.answered_disconnect_grace - cfg.ringing_disconnect_grace))
            if await self.hub.connections.is_connected(user_id):
                return
            await self._end_user_calls(user_id, "answered", "ended")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Ending calls for disconnected %s failed", user_id)

    # ------------------------------------------------------------- connect

    async def on_connect(self, user_id: str, websocket: WebSocket) -> None:
        """Re-ring a call still waiting for this user, on the new socket only
        (other sockets already got incoming_call), with the stored offer SDP."""
        async with self.hub.session_factory() as session:
            service = self.service(session)
            call = await service.get_active_call_for_user(user_id)
            if call is None or call.status != "ringing" or call.receiver_id != user_id:
                return
            offer_sdp = await service.get_offer_sdp(call.call_id)
        self.remember(call)
        payload = await self.incoming_payload(call)
        if offer_sdp:
            try:
                payload["sdp"] = json.loads(offer_sdp)
            except ValueError:
                pass
        await self.hub.connections.send_to_socket(websocket, payload)

    async def incoming_payload(self, info: CallInfo) -> dict:
        profile = await self.hub.profile(info.caller_id)
        return call_payload(
            "incoming_call", info,
            caller_name=profile.name if profile and profile.name else "Someone",
            caller_avatar=profile.avatar if profile else None,
        )

    # --------------------------------------------------------------- push

    async def push_incoming(self, info: CallInfo, caller_name: str, caller_avatar: str | None) -> None:
        await self.hub.push(info.receiver_id, caller_name, f"Incoming {info.call_type} call", {
            "type": "incoming_call",
            "call_id": info.call_id,
            "chat_id": info.chat_id,
            "caller_id": info.caller_id,
            "caller_name": caller_name,
            "caller_avatar": caller_avatar,
            "call_type": info.call_type,
        }, channel=self.config.ringtone_channel, ttl=int(self.config.ring_timeout))

    async def push_missed_call(self, info: CallInfo) -> None:
        """Receiver's app is not in the foreground: leave a missed-call notification
        (the app also uses it to stop a still-ringing notification)."""
        if await self.hub.connections.is_online(info.receiver_id):
            return
        caller_name = await self.hub.display_name(info.caller_id)
        await self.hub.push(info.receiver_id, caller_name, f"Missed {info.call_type} call", {
            "type": "missed_call",
            "call_id": info.call_id,
            "chat_id": info.chat_id,
            "caller_id": info.caller_id,
            "call_type": info.call_type,
        }, channel=self.config.missed_channel)
