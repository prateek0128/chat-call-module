"""The only package allowed to import several features (chat, call, moderation).

Submodules are loaded lazily, so e.g. ``link_moderation`` in a chat-only app does not
import the call feature (and does not register its table).
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "CALL_PLACEHOLDER": "chat_call",
    "ChatCallBridge": "chat_call",
    "link_chat_and_call": "chat_call",
    "ModerationLink": "moderation",
    "link_moderation": "moderation",
    "delete_user_everywhere": "privacy",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str) -> Any:
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module 'commskit.integration' has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module}"), name)
    globals()[name] = value
    return value
