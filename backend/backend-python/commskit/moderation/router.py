"""Moderation REST routes (PROTOCOL.md section 7), Bearer-authenticated."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.util import iso

from .handlers import ModerationError, target_id
from .service import REPORT_STATUSES, ModerationService

if TYPE_CHECKING:
    from .feature import ModerationFeature


def build_moderation_router(feature: "ModerationFeature") -> APIRouter:
    hub = feature.hub
    actions = feature.actions
    router = APIRouter(prefix="/moderation", tags=["moderation"])
    current_user = hub.current_user
    get_session = hub.get_session

    def target_or_422(user_id: str, value: Any) -> str:
        try:
            return target_id(user_id, value)
        except ModerationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/blocks")
    async def list_blocks(
        user_id: str = Depends(current_user), session: AsyncSession = Depends(get_session),
    ) -> list[dict[str, Any]]:
        rows = await ModerationService(session).list_blocked(user_id)
        profiles = await hub.profiles([r[0] for r in rows])
        result = []
        for blocked_id, blocked_at in rows:
            profile = profiles.get(blocked_id)
            result.append({
                "user_id": blocked_id,
                "username": profile.name if profile and profile.name else blocked_id,
                "avatar": profile.avatar if profile else None,
                "blocked_at": iso(blocked_at),
            })
        return result

    @router.post("/blocks")
    async def block_user(
        payload: dict[str, Any] = Body(...),
        user_id: str = Depends(current_user), session: AsyncSession = Depends(get_session),
    ) -> dict[str, Any]:
        await actions.block(session, user_id, target_or_422(user_id, payload.get("user_id")))
        return {"status": True}

    @router.delete("/blocks/{blocked_id}")
    async def unblock_user(
        blocked_id: str,
        user_id: str = Depends(current_user), session: AsyncSession = Depends(get_session),
    ) -> dict[str, Any]:
        await actions.unblock(session, user_id, target_or_422(user_id, blocked_id))
        return {"status": True}

    @router.post("/reports")
    async def report_user(
        payload: dict[str, Any] = Body(...),
        user_id: str = Depends(current_user), session: AsyncSession = Depends(get_session),
    ) -> dict[str, Any]:
        target = target_or_422(user_id, payload.get("user_id"))
        reason = payload.get("reason")
        if reason is None or not str(reason).strip():
            raise HTTPException(status_code=422, detail="reason is required")
        try:
            info = await actions.report(
                session, user_id, target, reason=reason, category=payload.get("category"),
                message_id=payload.get("message_id"), block=bool(payload.get("block", False)),
            )
        except ModerationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"report_id": info.id}

    if feature.admin_dependency is not None:
        admin = feature.admin_dependency

        @router.get("/admin/reports")
        async def admin_list_reports(
            status: str | None = Query(None),
            limit: int = Query(50, ge=1, le=200),
            offset: int = Query(0, ge=0),
            admin_id: Any = Depends(admin),
        ) -> list[dict[str, Any]]:
            if status is not None and status not in REPORT_STATUSES:
                raise HTTPException(status_code=422, detail=f"status must be one of: {', '.join(REPORT_STATUSES)}")
            return await feature.list_reports(status, limit=limit, offset=offset)

        @router.post("/admin/reports/{report_id}")
        async def admin_resolve_report(
            report_id: int,
            payload: dict[str, Any] = Body(...),
            admin_id: Any = Depends(admin),
        ) -> dict[str, Any]:
            status = payload.get("status")
            if status not in ("resolved", "dismissed", "open"):
                raise HTTPException(status_code=422, detail="status must be resolved or dismissed")
            note = payload.get("note")
            report = await feature.resolve_report(
                report_id, status, resolved_by=None if admin_id is None else str(admin_id),
                note=None if note is None else str(note),
            )
            if report is None:
                raise HTTPException(status_code=404, detail="Report not found")
            return report

        @router.get("/admin/reports/{report_id}/context")
        async def admin_report_context(
            report_id: int,
            before: int = Query(20, ge=0, le=200),
            after: int = Query(20, ge=0, le=200),
            admin_id: Any = Depends(admin),
        ) -> dict[str, Any]:
            context = await feature.report_context(report_id, before=before, after=after)
            if context is None:
                raise HTTPException(status_code=404, detail="Report not found")
            return context

    return router
