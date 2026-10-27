"""Tiny in-process async event bus.

Events emitted by the kit:
- ``user.connected(user_id)`` / ``user.disconnected(user_id)`` (last socket closed; users only, not other roles)
- ``user.came_online(user_id)`` once per offline -> online transition across all workers (+ optional cooldown)
- ``user.deleted(user_id)`` after ``commskit.integration.delete_user_everywhere``
- ``chat.message_sent(message: dict)`` (MessageDto as seen by the sender)
- ``chat.system_message_sent(message: dict)`` (MessageDto as seen by the recipient)
- ``chat.message_deleted({chat_id, message_id, for_everyone, user_id})``
- ``call.finalized(info: CallInfo)`` (after the terminal frames were sent)
- ``moderation.blocked(blocker_id, blocked_id)`` / ``moderation.unblocked(blocker_id, blocked_id)``
- ``moderation.reported(report: ReportInfo)``, ``moderation.report_resolved(report: dict)``
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable

logger = logging.getLogger("commskit.events")

Listener = Callable[..., Awaitable[None]]


class EventBus:
    def __init__(self) -> None:
        self._listeners: dict[str, list[Listener]] = defaultdict(list)

    def on(self, name: str, listener: Listener) -> Listener:
        self._listeners[name].append(listener)
        return listener

    def off(self, name: str, listener: Listener) -> None:
        if listener in self._listeners.get(name, []):
            self._listeners[name].remove(listener)

    async def emit(self, name: str, *args: Any, **kwargs: Any) -> None:
        """Run listeners in registration order; a failing listener is logged, not raised."""
        for listener in list(self._listeners.get(name, ())):
            try:
                await listener(*args, **kwargs)
            except Exception:
                logger.exception("Listener for %s failed", name)
