"""ModerationFeature(...).install(hub)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from .handlers import ModerationActions, ModerationHandlers
from .policy import ModerationCallPolicy, ModerationChatPolicy
from .router import build_moderation_router
from .service import ModerationService, ReportInfo

if TYPE_CHECKING:
    from commskit.core.hub import CommsHub

ReportHook = Callable[[ReportInfo], Awaitable[None]]
# context_provider(reporter_id, reported_id, message_id, before, after) -> MessageDto list (newest
# first). Set by commskit.integration.link_moderation(moderation, chat=...) so this package never
# imports chat; hosts may supply their own.
ContextProvider = Callable[["str | None", "str | None", "int | None", int, int], Awaitable[list[dict[str, Any]]]]


class ModerationFeature:
    """Block list + reports. Installs WS handlers ``report_and_block`` / ``block`` /
    ``unblock`` and ``/moderation/...`` REST routes.

    It does not touch chat or call by itself. To enforce blocks there, either wrap your
    policies (``chat_policy(inner)`` / ``call_policy(inner)``) or call
    ``commskit.integration.link_moderation(moderation, chat=..., call=...)``, which also
    ends a live call between the pair on block (``end_reason: "blocked"``).

    Events on ``hub.events``: ``moderation.blocked(blocker_id, blocked_id)``,
    ``moderation.unblocked(blocker_id, blocked_id)``, ``moderation.reported(ReportInfo)``,
    ``moderation.report_resolved(report: dict)``.

    Admin review (PROTOCOL.md section 9): pass ``admin_dependency``, a FastAPI dependency that
    authenticates a moderator (raise 401/403 otherwise) and returns their id; the
    ``/moderation/admin/reports...`` routes are only mounted when it is set.
    """

    name = "moderation"

    def __init__(
        self,
        on_report: ReportHook | None = None,
        notify_blocked_user: bool = True,
        admin_dependency: Callable[..., Any] | None = None,
        context_provider: ContextProvider | None = None,
    ) -> None:
        self.on_report = on_report
        self.notify_blocked_user = notify_blocked_user
        self.admin_dependency = admin_dependency
        self.context_provider = context_provider
        self._hub: "CommsHub | None" = None
        self.actions: ModerationActions
        self.handlers: ModerationHandlers

    @property
    def hub(self) -> "CommsHub":
        if self._hub is None:
            raise RuntimeError("ModerationFeature is not installed; call .install(hub) first")
        return self._hub

    def install(self, hub: "CommsHub") -> "ModerationFeature":
        hub.register_feature(self.name, self)
        self._hub = hub
        self.actions = ModerationActions(self)
        self.handlers = ModerationHandlers(self)
        self.handlers.register()
        hub.include_router(build_moderation_router(self))
        return self

    # ------------------------------------------------------------ policies

    def chat_policy(self, inner: Any = None) -> ModerationChatPolicy:
        """ChatPolicy: refuses a blocked pair, otherwise asks ``inner`` (allow-all if None)."""
        return ModerationChatPolicy(inner)

    def call_policy(self, inner: Any = None) -> ModerationCallPolicy:
        """CallPolicy: denies a blocked pair (``context: "call"`` error), otherwise ``inner``."""
        return ModerationCallPolicy(inner)

    # -------------------------------------------------------------- queries

    async def block_status(
        self, session: AsyncSession, viewer_id: str, other_ids: Sequence[str]
    ) -> Mapping[str, tuple[bool, bool]]:
        """{other_id: (is_blocked, blocked_by_other)} for ``res_users`` / ``res_messages.info``."""
        return await ModerationService(session).block_status(viewer_id, other_ids)

    async def is_blocked_between(self, session: AsyncSession, user_a: str, user_b: str) -> bool:
        return await ModerationService(session).is_blocked_between(user_a, user_b)

    # --------------------------------------------------------- admin review

    async def list_reports(self, status: str | None = None, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        async with self.hub.session_factory() as session:
            return await ModerationService(session).list_reports(status, limit=limit, offset=offset)

    async def resolve_report(
        self, report_id: int, status: str, resolved_by: str | None = None, note: str | None = None,
    ) -> dict[str, Any] | None:
        """``status``: resolved | dismissed (| open). None if the report doesn't exist."""
        async with self.hub.session_factory() as session:
            report = await ModerationService(session).resolve_report(report_id, status, resolved_by, note)
        if report is not None:
            await self.hub.events.emit("moderation.report_resolved", report)
        return report

    async def report_context(self, report_id: int, before: int = 20, after: int = 20) -> dict[str, Any] | None:
        """``{report, messages}``: messages around the reported message (or the latest between the pair),
        newest first, from ``context_provider`` (empty without one, e.g. call-only apps)."""
        async with self.hub.session_factory() as session:
            report = await ModerationService(session).get_report(report_id)
        if report is None:
            return None
        messages: list[dict[str, Any]] = []
        if self.context_provider is not None and report["reporter_id"] and report["reported_id"]:
            messages = list(await self.context_provider(
                report["reporter_id"], report["reported_id"], report["message_id"], max(0, before), max(0, after),
            ))
        return {"report": report, "messages": messages}

    # ------------------------------------------------------------- deletion

    async def delete_user_data(self, user_id: str) -> dict[str, int]:
        """Account deletion: blocks involving the user are deleted; reports are kept for the
        moderation history with the user's id set to NULL (as reporter and as reported user)."""
        async with self.hub.session_factory() as session:
            return await ModerationService(session).delete_user_data(str(user_id))
