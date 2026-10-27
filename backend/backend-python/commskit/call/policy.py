"""CallPolicy: host gate for starting a call (blocking, credits...)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class CallDecision:
    allowed: bool
    # On deny, sent as {"type":"error", **error, "context":"call"}; e.g.
    # {"error": "...", "status": 402, "message": "...", "info": {...}}.
    error: dict[str, Any] | None = None

    @classmethod
    def allow(cls) -> "CallDecision":
        return cls(True)

    @classmethod
    def deny(cls, error: str, **fields: Any) -> "CallDecision":
        return cls(False, {"error": error, **fields})


class CallPolicy(Protocol):
    async def authorize(
        self, session: AsyncSession, caller_id: str, receiver_id: str, message: dict
    ) -> CallDecision:
        """Runs after busy detection, right before the call row is created.

        ``message`` is the raw ``call_initiate`` frame (host fields such as
        ``credit_acknowledged`` are available). Charging here is safe: busy
        receivers never reach this point.
        """
        ...


class AllowAllCallPolicy:
    async def authorize(
        self, session: AsyncSession, caller_id: str, receiver_id: str, message: dict
    ) -> CallDecision:
        return CallDecision.allow()
