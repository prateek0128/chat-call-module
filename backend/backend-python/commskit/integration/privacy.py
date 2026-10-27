"""Account deletion across every installed feature.

Works through ``hub.features`` (any feature with an async ``delete_user_data(user_id)``), so it
imports no feature package and works for chat only, call only, moderation, devices or any mix.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from commskit.core.hub import CommsHub

logger = logging.getLogger("commskit.privacy")

# Chat first: its messages may reference calls (call-log entries); devices last.
_ORDER = ("chat", "call", "moderation", "devices")


async def delete_user_everywhere(hub: "CommsHub", user_id: str, *, raise_errors: bool = False) -> dict[str, Any]:
    """Call ``delete_user_data(user_id)`` on every installed feature, then emit ``user.deleted(user_id)``.

    Returns ``{feature_name: result}``. A failing feature is logged and reported as
    ``{"error": "..."}`` (or re-raised with ``raise_errors=True``); the others still run.
    """
    user_id = str(user_id)
    names = sorted(hub.features, key=lambda n: (_ORDER.index(n) if n in _ORDER else len(_ORDER), n))
    results: dict[str, Any] = {}
    for name in names:
        delete = getattr(hub.features[name], "delete_user_data", None)
        if delete is None:
            continue
        try:
            results[name] = await delete(user_id)
        except Exception as exc:
            if raise_errors:
                raise
            logger.exception("delete_user_data failed in feature %s", name)
            results[name] = {"error": str(exc)}
    await hub.events.emit("user.deleted", user_id)
    return results
