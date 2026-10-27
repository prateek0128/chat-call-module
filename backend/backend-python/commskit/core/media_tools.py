"""Optional media helpers: image / video thumbnails and audio / video duration.

- ``make_image_thumbnail`` needs Pillow (``pip install "commskit[media]"``), imported lazily.
- ``probe_duration`` / ``make_video_thumbnail`` run ``ffprobe`` / ``ffmpeg`` when they are on PATH
  (or at ``FFPROBE_PATH`` / ``FFMPEG_PATH``).

Every helper is synchronous (CPU / subprocess work) and returns ``None`` when the tool is missing
or the input can't be read, so an upload never fails because of a thumbnail. Call them from a
thread: ``await asyncio.to_thread(make_image_thumbnail, data)``.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import tempfile
from typing import Any

logger = logging.getLogger("commskit.media")

THUMBNAIL_SIZE = (300, 300)
DURATION_MEDIA_TYPES = frozenset({"audio", "voice", "video", "webm"})
VIDEO_MEDIA_TYPES = frozenset({"video", "webm"})


def _tool(name: str) -> str | None:
    configured = os.getenv(f"{name.upper()}_PATH")
    if configured and os.path.exists(configured):
        return configured
    return shutil.which(name)


def make_image_thumbnail(data: bytes, size: tuple[int, int] = THUMBNAIL_SIZE, quality: int = 80) -> bytes | None:
    """JPEG thumbnail that fits in ``size`` (aspect kept); None without Pillow or for a bad image."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        logger.warning("Pillow is not installed (pip install \"commskit[media]\"); no image thumbnail")
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in ("RGB", "L"):
                background = Image.new("RGB", image.size, (255, 255, 255))
                rgba = image.convert("RGBA")
                background.paste(rgba, mask=rgba.split()[-1])
                image = background
            image.thumbnail(size, Image.Resampling.LANCZOS)
            out = io.BytesIO()
            image.convert("RGB").save(out, format="JPEG", quality=quality, optimize=True)
            return out.getvalue()
    except Exception as exc:
        logger.warning("Image thumbnail failed: %s", exc)
        return None


def _with_temp_file(data: bytes, suffix: str, fn: Any) -> Any:
    fd, path = tempfile.mkstemp(suffix=suffix or ".bin")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return fn(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def probe_duration(data: bytes, suffix: str = "", timeout: float = 20.0) -> int | None:
    """Duration in whole seconds via ``ffprobe``; None when ffprobe is missing or fails."""
    ffprobe = _tool("ffprobe")
    if ffprobe is None:
        return None

    def run(path: str) -> int | None:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        text = (result.stdout or "").strip().splitlines()
        try:
            seconds = float(text[0]) if text else None
        except ValueError:
            seconds = None
        return int(round(seconds)) if seconds is not None and seconds >= 0 else None

    try:
        return _with_temp_file(data, suffix, run)
    except Exception as exc:
        logger.warning("ffprobe failed: %s", exc)
        return None


def make_video_thumbnail(data: bytes, suffix: str = ".mp4", width: int = THUMBNAIL_SIZE[0],
                         timeout: float = 30.0) -> bytes | None:
    """JPEG of a frame near the start via ``ffmpeg``; None when ffmpeg is missing or fails."""
    ffmpeg = _tool("ffmpeg")
    if ffmpeg is None:
        return None

    def run(path: str) -> bytes | None:
        for seek in ("1", "0"):  # very short clips have no frame at 1 s
            result = subprocess.run(
                [ffmpeg, "-v", "error", "-ss", seek, "-i", path, "-frames:v", "1",
                 "-vf", f"scale={int(width)}:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
                capture_output=True, timeout=timeout, check=False,
            )
            if result.returncode == 0 and result.stdout:
                return bytes(result.stdout)
        return None

    try:
        return _with_temp_file(data, suffix, run)
    except Exception as exc:
        logger.warning("ffmpeg thumbnail failed: %s", exc)
        return None
