"""CallConfig: timings, push channels and TURN settings."""

from __future__ import annotations

from dataclasses import dataclass, field

from commskit.core.ratelimit import RateLimit


@dataclass
class CallConfig:
    ring_timeout: float = 45  # ringing -> missed (no_answer)
    ringing_disconnect_grace: float = 20  # socket loss while ringing -> missed (disconnected)
    answered_disconnect_grace: float = 90  # socket loss while answered -> ended (disconnected)
    max_call_hours: float = 4  # answered calls older than this no longer count as live
    ring_window_slack: float = 15  # extra seconds a ringing row still counts as live

    ringtone_channel: str = "call_ringtone"  # Android channel for incoming-call pushes
    missed_channel: str = "messages"

    # coturn REST-API credentials; route answers 503 while turn_secret is unset.
    turn_secret: str | None = None
    turn_uris: list[str] = field(default_factory=list)
    turn_ttl: int = 3600

    # call_initiate per caller (PROTOCOL.md section 9 "Limits"); None disables it.
    initiate_rate: RateLimit | None = RateLimit(5, 60)
