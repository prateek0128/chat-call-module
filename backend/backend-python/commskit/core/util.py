"""Small shared helpers."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Coroutine, Generic, Hashable, TypeVar

logger = logging.getLogger("commskit")

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


def utcnow() -> datetime:
    """Naive UTC now (matches the legacy wire format: no offset suffix)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now_iso() -> str:
    return utcnow().isoformat()


def iso(value: Any) -> str | None:
    if value is None or isinstance(value, str):
        return value
    return value.isoformat()


def callkit_uuid(call_id: str) -> str:
    """CallKit UUID for a call: UUIDv5(NAMESPACE_URL, "commskit:call:<call_id>").

    The mobile kit derives the same value, so a VoIP push and the later WS frames map
    to the same CallKit call. Test vector: see tests/test_push.py::test_callkit_uuid_vector.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"commskit:call:{call_id}"))


def to_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class LRU(Generic[K, V]):
    """Bounded mapping; oldest entries are evicted first."""

    def __init__(self, limit: int) -> None:
        self._data: OrderedDict[K, V] = OrderedDict()
        self._limit = limit

    def get(self, key: K) -> V | None:
        return self._data.get(key)

    def put(self, key: K, value: V) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self._limit:
            self._data.popitem(last=False)

    def pop(self, key: K) -> V | None:
        return self._data.pop(key, None)

    def clear(self) -> None:
        self._data.clear()

    def discard_where(self, predicate: Any) -> None:
        """Drop every key for which ``predicate(key)`` is true."""
        for key in [k for k in self._data if predicate(k)]:
            del self._data[key]


class TaskSet:
    """Keeps strong refs to fire-and-forget tasks (asyncio only holds weak ones)."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task[Any]] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._done)
        return task

    def _done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("Background task failed", exc_info=task.exception())

    async def cancel_all(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
