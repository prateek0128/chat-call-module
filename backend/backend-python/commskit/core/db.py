"""Declarative base owned by the kit, plus DB-clock helper."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase


class CommsBase(DeclarativeBase):
    """All kit tables live on this metadata (``CommsBase.metadata``)."""


async def db_now(session: AsyncSession) -> datetime:
    """Current time from the database clock.

    Call timestamps are stamped and compared with this value rather than the app
    server's clock, so workers in different timezones/clock skews agree.
    """
    return (await session.execute(select(func.now()))).scalar_one()
