"""Call frame builders, including legacy quirks (PROTOCOL.md section 6)."""

from __future__ import annotations

from typing import Any

from commskit.core.util import now_iso

from .service import CallInfo


def call_payload(event: str, info: CallInfo, **extra: Any) -> dict[str, Any]:
    return {
        "type": event,
        "call_id": info.call_id,
        "chat_id": info.chat_id,
        "caller_id": info.caller_id,
        "receiver_id": info.receiver_id,
        "call_type": info.call_type,
        "webrtc_session_id": info.call_id,
        "timestamp": now_iso(),
        **extra,
    }


def caller_view(info: CallInfo) -> dict[str, Any]:
    """Legacy: caller-side call_initiated / call_ringing carry the *receiver* in
    caller_id / caller_name, because installed apps read the peer from there."""
    return {"caller_id": info.receiver_id, "caller_name": info.receiver_id}


def busy_payload(caller_id: str, receiver_id: str, call_type: str) -> dict[str, Any]:
    """Legacy: busy is a call_rejected with call_id null."""
    return {
        "type": "call_rejected",
        "call_id": None,
        "status": "busy",
        "reason": "busy",
        "caller_id": caller_id,
        "receiver_id": receiver_id,
        "call_type": call_type,
        "timestamp": now_iso(),
    }


def call_error(error: str, **extra: Any) -> dict[str, Any]:
    """Tagged so clients only tear down call UI for call errors."""
    return {"type": "error", "error": error, **extra, "context": "call"}
