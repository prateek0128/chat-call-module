"""TURN REST-API credentials (coturn ``use-auth-secret`` scheme)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any, Sequence


def turn_credentials(
    secret: str, uris: Sequence[str], ttl: int = 3600, user_id: str | None = None, now: float | None = None
) -> dict[str, Any]:
    """username = "<expiry>[:<user_id>]", password = base64(HMAC-SHA1(secret, username))."""
    expiry = int(now if now is not None else time.time()) + ttl
    username = f"{expiry}:{user_id}" if user_id else str(expiry)
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return {
        "username": username,
        "password": base64.b64encode(digest).decode(),
        "ttl": ttl,
        "uris": list(uris),
    }
