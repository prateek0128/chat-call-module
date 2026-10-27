"""ModerationService: block list and reports on one session."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Sequence

from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.util import iso, utcnow

from .models import Block, Report

# Suggested; free text is allowed.
REPORT_CATEGORIES = ("spam", "harassment", "inappropriate", "fake_profile", "scam", "underage", "other")
REPORT_STATUSES = ("open", "resolved", "dismissed")
MAX_NOTE_CHARS = 4000
MAX_REASON_CHARS = 2000
MAX_CATEGORY_CHARS = 64


@dataclass(frozen=True)
class ReportInfo:
    """What ``on_report`` receives (session-free)."""

    id: int
    reporter_id: str
    reported_id: str
    reason: str | None
    category: str | None
    message_id: int | None
    status: str
    created_at: datetime
    blocked: bool = False  # the reporter also blocked the user


class ModerationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # --------------------------------------------------------------- blocks

    async def block(self, blocker_id: str, blocked_id: str) -> bool:
        """True if a new block was stored (blocking twice is a no-op)."""
        if await self.has_blocked(blocker_id, blocked_id):
            return False
        self.session.add(Block(blocker_id=blocker_id, blocked_id=blocked_id, created_at=utcnow()))
        try:
            await self.session.commit()
        except IntegrityError:  # concurrent duplicate
            await self.session.rollback()
            return False
        return True

    async def unblock(self, blocker_id: str, blocked_id: str) -> bool:
        result = await self.session.execute(
            delete(Block).where(Block.blocker_id == blocker_id, Block.blocked_id == blocked_id)
            .execution_options(synchronize_session=False)
        )
        await self.session.commit()
        return bool(result.rowcount)

    async def has_blocked(self, blocker_id: str, blocked_id: str) -> bool:
        result = await self.session.execute(
            select(Block.id).where(Block.blocker_id == blocker_id, Block.blocked_id == blocked_id).limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def is_blocked_between(self, user_a: str, user_b: str) -> bool:
        """Either direction."""
        result = await self.session.execute(
            select(Block.id).where(or_(
                and_(Block.blocker_id == user_a, Block.blocked_id == user_b),
                and_(Block.blocker_id == user_b, Block.blocked_id == user_a),
            )).limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def block_status(self, viewer_id: str, other_ids: Sequence[str]) -> Mapping[str, tuple[bool, bool]]:
        """{other_id: (is_blocked, blocked_by_other)} for ids with any block."""
        ids = [o for o in dict.fromkeys(other_ids) if o]
        if not ids:
            return {}
        rows = (await self.session.execute(
            select(Block.blocker_id, Block.blocked_id).where(or_(
                and_(Block.blocker_id == viewer_id, Block.blocked_id.in_(ids)),
                and_(Block.blocked_id == viewer_id, Block.blocker_id.in_(ids)),
            ))
        )).all()
        status: dict[str, tuple[bool, bool]] = {}
        for blocker, blocked in rows:
            if blocker == viewer_id:
                is_blocked, by_other = status.get(blocked, (False, False))
                status[blocked] = (True, by_other)
            else:
                is_blocked, by_other = status.get(blocker, (False, False))
                status[blocker] = (is_blocked, True)
        return status

    async def list_blocked(self, blocker_id: str) -> list[tuple[str, datetime]]:
        rows = (await self.session.execute(
            select(Block.blocked_id, Block.created_at).where(Block.blocker_id == blocker_id)
            .order_by(Block.created_at.desc(), Block.id.desc())
        )).all()
        return [(r[0], r[1]) for r in rows]

    # -------------------------------------------------------------- reports

    async def create_report(
        self,
        reporter_id: str,
        reported_id: str,
        reason: str | None = None,
        category: str | None = None,
        message_id: int | None = None,
    ) -> ReportInfo:
        reason = (str(reason).strip()[:MAX_REASON_CHARS] or None) if reason is not None else None
        category = (str(category).strip().lower()[:MAX_CATEGORY_CHARS] or None) if category is not None else None
        report = Report(
            reporter_id=reporter_id, reported_id=reported_id, reason=reason, category=category,
            message_id=message_id, status="open", created_at=utcnow(),
        )
        self.session.add(report)
        await self.session.flush()
        info = ReportInfo(report.id, reporter_id, reported_id, reason, category, message_id,
                          report.status, report.created_at)
        await self.session.commit()
        return info

    # --------------------------------------------------------- admin review

    async def get_report(self, report_id: int) -> dict[str, Any] | None:
        report = (await self.session.execute(
            select(Report).where(Report.id == report_id).execution_options(populate_existing=True)
        )).scalar_one_or_none()
        return report_dict(report) if report else None

    async def list_reports(self, status: str | None = None, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        """Newest first; ``status`` filters (open | resolved | dismissed)."""
        query = select(Report)
        if status:
            query = query.where(Report.status == status)
        rows = (await self.session.execute(
            query.order_by(Report.created_at.desc(), Report.id.desc()).limit(limit).offset(offset)
        )).scalars().all()
        return [report_dict(r) for r in rows]

    async def resolve_report(
        self, report_id: int, status: str, resolved_by: str | None, note: str | None = None,
    ) -> dict[str, Any] | None:
        """Set a report to ``resolved`` / ``dismissed`` (or back to ``open``). None if it doesn't exist."""
        if status not in REPORT_STATUSES:
            raise ValueError(f"status must be one of: {', '.join(REPORT_STATUSES)}")
        report = (await self.session.execute(select(Report).where(Report.id == report_id))).scalar_one_or_none()
        if report is None:
            return None
        report.status = status
        if status == "open":
            report.resolved_at = None
            report.resolved_by = None
        else:
            report.resolved_at = utcnow()
            report.resolved_by = (str(resolved_by)[:50] or None) if resolved_by is not None else None
        if note is not None:
            report.note = str(note).strip()[:MAX_NOTE_CHARS] or None
        data = report_dict(report)
        await self.session.commit()
        return data

    # ------------------------------------------------------------- deletion

    async def delete_user_data(self, user_id: str) -> dict[str, int]:
        """Account deletion: drop every block involving ``user_id``; keep reports (moderation history)
        but replace the user's id with NULL as reporter and as reported user."""
        quiet = {"synchronize_session": False}
        blocks = await self.session.execute(
            delete(Block).where(or_(Block.blocker_id == user_id, Block.blocked_id == user_id)).execution_options(**quiet)
        )
        as_reporter = await self.session.execute(
            update(Report).where(Report.reporter_id == user_id).values(reporter_id=None).execution_options(**quiet)
        )
        as_reported = await self.session.execute(
            update(Report).where(Report.reported_id == user_id).values(reported_id=None).execution_options(**quiet)
        )
        await self.session.commit()
        return {"blocks": int(blocks.rowcount or 0),
                "reports_anonymized": int((as_reporter.rowcount or 0) + (as_reported.rowcount or 0))}


def report_dict(report: Report) -> dict[str, Any]:
    """Admin wire shape (PROTOCOL.md section 9)."""
    return {
        "report_id": report.id,
        "reporter_id": report.reporter_id,
        "reported_id": report.reported_id,
        "reason": report.reason,
        "category": report.category,
        "message_id": report.message_id,
        "status": report.status,
        "created_at": iso(report.created_at),
        "resolved_at": iso(report.resolved_at),
        "resolved_by": report.resolved_by,
        "note": report.note,
    }
