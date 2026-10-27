"""Moderation WebSocket handlers and the shared block/report actions (also used by REST)."""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from .service import ModerationService, ReportInfo

if TYPE_CHECKING:
    from .feature import ModerationFeature

logger = logging.getLogger("commskit.moderation")

BLOCKED_TEXT = "User blocked successfully"
BLOCKED_BY_TEXT = "You have been blocked by this user"
UNBLOCKED_TEXT = "User unblocked successfully"
UNBLOCKED_BY_TEXT = "You have been unblocked by this user"


def moderation_error(error: str, **extra: Any) -> dict[str, Any]:
    return {"type": "error", "error": error, **extra, "context": "moderation"}


class ModerationError(ValueError):
    """Bad request (missing / self target ...)."""


def target_id(user_id: str, value: Any) -> str:
    if value is None or str(value).strip() == "":
        raise ModerationError("Missing required fields: candidate_user_id")
    target = str(value).strip()
    if target == user_id:
        raise ModerationError("You cannot block or report yourself.")
    return target


def _message_id(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ModerationError("message_id must be an integer") from None


class ModerationActions:
    """Block / unblock / report + their frames and events. Commits its own writes."""

    def __init__(self, feature: "ModerationFeature") -> None:
        self.feature = feature
        self.hub = feature.hub

    async def block(self, session: AsyncSession, user_id: str, target: str) -> bool:
        created = await ModerationService(session).block(user_id, target)
        await self.hub.send(user_id, {"type": "user_blocked", "candidate_user_id": target, "message": BLOCKED_TEXT})
        if self.feature.notify_blocked_user:
            await self.hub.send(target, {"type": "blocked_by_user", "candidate_user_id": user_id,
                                         "message": BLOCKED_BY_TEXT})
        # Always emitted (also for a repeated block): listeners such as link_moderation
        # end live calls between the pair, which must happen even if a call slipped through.
        await self.hub.events.emit("moderation.blocked", user_id, target)
        return created

    async def unblock(self, session: AsyncSession, user_id: str, target: str) -> bool:
        removed = await ModerationService(session).unblock(user_id, target)
        await self.hub.send(user_id, {"type": "user_unblocked", "candidate_user_id": target, "message": UNBLOCKED_TEXT})
        if self.feature.notify_blocked_user and removed:
            await self.hub.send(target, {"type": "unblocked_by_user", "candidate_user_id": user_id,
                                         "message": UNBLOCKED_BY_TEXT})
        if removed:
            await self.hub.events.emit("moderation.unblocked", user_id, target)
        return removed

    async def report(
        self, session: AsyncSession, user_id: str, target: str, *, reason: Any = None, category: Any = None,
        message_id: Any = None, block: bool = True,
    ) -> ReportInfo:
        info = await ModerationService(session).create_report(
            user_id, target, reason=None if reason is None else str(reason),
            category=None if category is None else str(category), message_id=_message_id(message_id),
        )
        if block:
            await self.block(session, user_id, target)
            info = replace(info, blocked=True)
        await self.hub.send(user_id, {"type": "report_received", "report_id": info.id, "candidate_user_id": target})
        await self.hub.events.emit("moderation.reported", info)
        if self.feature.on_report is not None:
            self.hub.spawn(self._run_hook(info))
        return info

    async def _run_hook(self, info: ReportInfo) -> None:
        try:
            await self.feature.on_report(info)  # type: ignore[misc]
        except Exception:
            logger.exception("on_report hook failed for report %s", info.id)


class ModerationHandlers:
    def __init__(self, feature: "ModerationFeature") -> None:
        self.feature = feature
        self.hub = feature.hub
        self.actions = feature.actions

    def register(self) -> None:
        self.hub.on("report_and_block", self._guard(self.report_and_block, "Failed to report user"))
        self.hub.on("block", self._guard(self.block, "Failed to block user"))
        self.hub.on("unblock", self._guard(self.unblock, "Failed to unblock user"))

    def _guard(self, fn: Any, label: str) -> Any:
        async def run(user_id: str, message: dict, session: AsyncSession) -> None:
            try:
                await fn(user_id, message, session)
            except ModerationError as exc:
                await self.hub.send(user_id, moderation_error(str(exc)))
            except Exception as exc:
                logger.exception("%s handler failed", message.get("type"))
                await self.hub.report_handler_error(user_id, message, exc)
                await self.hub.send(user_id, moderation_error(f"{label}: {exc}"))

        return run

    async def report_and_block(self, user_id: str, message: dict, session: AsyncSession) -> None:
        target = target_id(user_id, message.get("candidate_user_id"))
        await self.actions.report(
            session, user_id, target, reason=message.get("reason"), category=message.get("category"),
            message_id=message.get("message_id"), block=message.get("block", True) is not False,
        )

    async def block(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self.actions.block(session, user_id, target_id(user_id, message.get("candidate_user_id")))

    async def unblock(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self.actions.unblock(session, user_id, target_id(user_id, message.get("candidate_user_id")))
