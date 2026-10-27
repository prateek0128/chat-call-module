"""Call REST routes: notification decline and TURN credentials."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .turn import turn_credentials

if TYPE_CHECKING:
    from .feature import CallFeature


def build_call_router(feature: "CallFeature") -> APIRouter:
    hub = feature.hub
    router = APIRouter(prefix="/call", tags=["call"])

    @router.post("/turn-credentials")
    async def get_turn_credentials(user_id: str = Depends(hub.current_user)) -> dict[str, Any]:
        cfg = feature.config
        if not cfg.turn_secret:
            raise HTTPException(status_code=503, detail="TURN is not configured")
        return turn_credentials(cfg.turn_secret, cfg.turn_uris, cfg.turn_ttl)

    @router.post("/{call_id}/reject")
    async def reject_call(
        call_id: str,
        user_id: str = Depends(hub.current_user),
        session: AsyncSession = Depends(hub.get_session),
    ) -> JSONResponse:
        """Decline from the call notification while the app has no socket."""
        if not await feature.lifecycle.reject_from_notification(session, call_id, user_id):
            return JSONResponse(status_code=404, content={"status": False, "message": "Call not found"})
        return JSONResponse(status_code=200, content={"status": True})

    return router
