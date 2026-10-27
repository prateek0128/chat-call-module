"""Call WebSocket handlers (PROTOCOL.md section 4)."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.hub import Handler
from commskit.core.ratelimit import retry_after_seconds
from commskit.core.util import now_iso

from .payloads import busy_payload, call_error, call_payload, caller_view
from .service import ACTIVE_CALL_STATUSES

if TYPE_CHECKING:
    from .feature import CallFeature

logger = logging.getLogger("commskit.call")

# PROTOCOL.md names the caller-view quirk location as handlers._caller_view.
_caller_view = caller_view


class CallHandlers:
    def __init__(self, feature: "CallFeature") -> None:
        self.feature = feature
        self.hub = feature.hub
        self.lifecycle = feature.lifecycle

    def register(self) -> None:
        on = self.hub.on
        on("call_initiate", self._guard(self.call_initiate, "Failed to initiate call"))
        on("answer_call", self._guard(self.answer_call, "Failed to answer call"))
        # reject_call and end_call are equivalent: the outcome comes from call state.
        on("reject_call", self._guard(self.end_call, "Failed to reject call"))
        on("end_call", self._guard(self.end_call, "Failed to end call"))
        on("sdp_offer", self._guard(self.sdp_offer, None))
        on("sdp_answer", self._guard(self.sdp_answer, None))
        on("ice_candidate", self._guard(self.ice_candidate, None))
        on("start_recording", self.start_recording)

    def _guard(self, fn: Handler, label: str | None) -> Handler:
        """Crash -> call-tagged error (label) or logged only (signalling relays)."""
        async def run(user_id: str, message: dict, session: AsyncSession) -> None:
            try:
                await fn(user_id, message, session)
            except Exception as exc:
                logger.exception("%s handler failed", message.get("type"))
                await self.hub.report_handler_error(user_id, message, exc)
                if label:
                    await self._error(user_id, f"{label}: {exc}")

        return run

    async def _error(self, user_id: str, error: str, **extra: Any) -> None:
        await self.hub.send(user_id, call_error(error, **extra))

    # ------------------------------------------------------------ initiate

    async def call_initiate(self, user_id: str, message: dict, session: AsyncSession) -> None:
        lifecycle = self.lifecycle
        connections = self.hub.connections
        receiver_id = message.get("receiver_id")
        call_type = "video" if message.get("call_type") == "video" else "audio"
        if not receiver_id:
            await self._error(user_id, "Missing required fields: receiver_id")
            return
        receiver_id = str(receiver_id)
        if receiver_id == user_id:
            await self._error(user_id, "You cannot call yourself.")
            return
        limit = self.feature.config.initiate_rate
        wait = await self.hub.rate_limiter.hit(f"call.initiate:{user_id}", limit) if limit else 0.0
        if wait:
            seconds = retry_after_seconds(wait)
            await self._error(user_id, f"Too many calls. Try again in {seconds} s.", code="rate_limited",
                              retry_after=seconds)
            return

        service = lifecycle.service(session)
        own_call = await service.get_active_call_for_user(user_id)
        if own_call and own_call.status == "ringing":
            await self._error(user_id, "You are already in a call.")
            return
        if own_call:
            # Starting a new call means they left their answered one; its hangup
            # was lost (e.g. worker restarted mid-call). Close it out.
            await lifecycle.finish_call(session, own_call, user_id)

        receiver_call = await service.get_active_call_for_user(receiver_id)
        if receiver_call and not (
            await connections.is_connected(receiver_call.caller_id)
            or await connections.is_connected(receiver_call.receiver_id)
        ):
            # Nobody on that call has a socket anywhere: a leftover, not a real call.
            stale = await service.finalize_call(
                receiver_call.call_id,
                "ended" if receiver_call.status == "answered" else "missed",
                "stale",
                only_from=(receiver_call.status,),
            )
            if stale:
                await lifecycle.finalized(stale)
            receiver_call = await service.get_active_call_for_user(receiver_id)

        if receiver_call:
            await self.hub.send(user_id, busy_payload(user_id, receiver_id, call_type))
            return

        decision = await self.feature.policy.authorize(session, user_id, receiver_id, message)
        if not decision.allowed:
            error = dict(decision.error or {"error": "Call not allowed."})
            error.setdefault("error", "Call not allowed.")
            await self.hub.send(user_id, {"type": "error", **error, "context": "call"})
            return

        bridge = self.feature.chat_bridge
        chat_id = await bridge.resolve_chat_id(session, user_id, receiver_id, message.get("chat_id")) if bridge else None
        info = await service.create_call(chat_id, user_id, receiver_id, is_video_call=call_type == "video")
        self.hub.spawn(lifecycle.expire_unanswered(info.call_id))
        if bridge:
            await bridge.on_call_created(session, info)
        lifecycle.remember(info)

        await self.hub.send(user_id, call_payload("call_initiated", info, status="calling", **caller_view(info)))

        incoming = await lifecycle.incoming_payload(info)
        delivered = await self.hub.send(receiver_id, incoming)
        if delivered:
            await self.hub.send(user_id, call_payload("call_ringing", info, status="ringing", **caller_view(info)))
        else:
            # Push only when no socket got it: a connected app rings by itself and
            # a push on top would ring twice. ttl drops it once ringing is over.
            self.hub.spawn(lifecycle.push_incoming(info, incoming["caller_name"], incoming["caller_avatar"]))
        logger.info("Call %s initiated %s -> %s", info.call_id, user_id, receiver_id)

    # -------------------------------------------------------------- answer

    async def answer_call(self, user_id: str, message: dict, session: AsyncSession) -> None:
        call_id = message.get("call_id")
        if not call_id:
            await self._error(user_id, "Missing required fields: call_id")
            return
        call_id = str(call_id)
        lifecycle = self.lifecycle
        info = await lifecycle.service(session).mark_answered(call_id, user_id)
        if info is None:
            call = await lifecycle.load_call_for(session, call_id, user_id)
            if call is None:
                await self._error(user_id, "Call not found", call_id=call_id)
                return
            if call.status == "answered":
                return  # duplicate answer (double tap / second socket)
            # Cancelled or timed out meanwhile: stop ringing on every socket.
            await self.hub.send(user_id, call_payload(
                "call_ended", call, status="call_ended", end_reason=call.status, duration_seconds=call.duration,
            ))
            return
        lifecycle.remember(info)
        payload = call_payload("call_answered", info, status="answered", answerer_id=user_id)
        await self.hub.send(info.caller_id, payload)
        # Also the answerer: stops ringing on their other devices ("answered elsewhere").
        await self.hub.send(user_id, payload)

    # ------------------------------------------------------- reject / end

    async def end_call(self, user_id: str, message: dict, session: AsyncSession) -> None:
        call_id = message.get("call_id")
        if not call_id:
            await self._error(user_id, "Missing required fields: call_id")
            return
        call = await self.lifecycle.load_call_for(session, str(call_id), user_id)
        if call is None:
            await self._error(user_id, "Call not found", call_id=call_id)
            return
        await self.lifecycle.finish_call(session, call, user_id)

    # ---------------------------------------------------------- signalling

    async def _relay_sdp(self, user_id: str, message: dict, session: AsyncSession, event: str) -> None:
        call_id, sdp = message.get("call_id"), message.get("sdp")
        if not call_id or not sdp:
            await self._error(user_id, "Missing required fields: sdp, call_id")
            return
        call_id = str(call_id)
        call = await self.lifecycle.load_call_for(session, call_id, user_id)
        if call is None or call.status not in ACTIVE_CALL_STATUSES:
            await self._error(user_id, "No active call found.", call_id=call_id)
            return
        if event == "sdp_offer" and user_id == call.caller_id:
            # Kept so a receiver who connects later (e.g. from the push) still gets it.
            await self.lifecycle.service(session).save_offer_sdp(call_id, json.dumps(sdp))
        other = call.other_party(user_id)
        if other:
            await self.hub.send(other, {
                "type": event, "call_id": call_id, "from_user_id": user_id, "sdp": sdp, "timestamp": now_iso(),
            })

    async def sdp_offer(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self._relay_sdp(user_id, message, session, "sdp_offer")

    async def sdp_answer(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self._relay_sdp(user_id, message, session, "sdp_answer")

    async def ice_candidate(self, user_id: str, message: dict, session: AsyncSession) -> None:
        call_id, candidate = message.get("call_id"), message.get("candidate")
        if not call_id or not candidate:
            return
        call_id = str(call_id)
        parties = self.lifecycle.parties.get(call_id)
        if parties is None:
            call = await self.lifecycle.load_call_for(session, call_id, user_id)
            if call is None:
                return
            parties = (call.caller_id, call.receiver_id)
        caller_id, receiver_id = parties
        if user_id not in parties:
            return
        await self.hub.send(receiver_id if user_id == caller_id else caller_id, {
            "type": "ice_candidate", "call_id": call_id, "from_user_id": user_id,
            "candidate": candidate, "timestamp": now_iso(),
        })

    async def start_recording(self, user_id: str, message: dict, session: AsyncSession) -> None:
        """Accepted and ignored (PROTOCOL.md)."""
        return None
