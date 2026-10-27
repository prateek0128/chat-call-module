"""Media type detection by file extension (ported from S3MediaManager)."""

from __future__ import annotations

import os

# Order matters: the first type whose extensions match wins ("voice" shares
# audio's extensions, so it is only chosen when the client asks for it).
MEDIA_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "image": (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"),
    "video": (".mp4", ".avi", ".mov", ".mkv", ".3gp"),
    "audio": (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"),
    "voice": (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"),
    "document": (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".zip", ".rar"),
    "webm": (".webm",),
}
MEDIA_TYPES = frozenset(MEDIA_EXTENSIONS)


def detect_media_type(file_name: str, requested: str | None = None) -> str | None:
    """Media type for ``file_name``; a valid ``requested`` type (e.g. "voice") wins."""
    if requested in MEDIA_TYPES:
        return requested
    _, ext = os.path.splitext(file_name.lower())
    for media_type, extensions in MEDIA_EXTENSIONS.items():
        if ext in extensions:
            return media_type
    return None
