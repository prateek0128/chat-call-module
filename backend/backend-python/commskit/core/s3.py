"""``S3Storage``: a reference ``MediaStorage`` on Amazon S3 (``pip install "commskit[s3]"``).

Key layout: ``{prefix}chat/{chat_id}/{media_type}/{unix_ts}_{uuid8}_{name}``; thumbnails sit next to
the file as ``..._thumb.jpg``. Images get a Pillow thumbnail, videos an ffmpeg one (when installed,
see ``commskit.core.media_tools``), audio / voice / video a duration (ffprobe). All boto3 and
thumbnail work runs in a thread, so uploads don't block the event loop.

``private=True`` stores presigned GET URLs (``presign_expires``, at most 7 days) instead of public
URLs; refresh old ones from your own code with ``storage.presign(file_url)``.

    storage = S3Storage("my-bucket", region="ap-south-1")          # boto3 default credentials
    ChatFeature(storage=storage).install(hub)
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from .adapters import MediaInfo
from .media_tools import DURATION_MEDIA_TYPES, VIDEO_MEDIA_TYPES, make_image_thumbnail, make_video_thumbnail, probe_duration

logger = logging.getLogger("commskit.s3")

PRESIGN_MAX_SECONDS = 7 * 24 * 3600  # SigV4 ceiling
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(file_name: str) -> str:
    name = _UNSAFE.sub("_", os.path.basename(file_name).strip()).strip("._") or "file"
    return name[-120:]


def thumbnail_key(key: str) -> str:
    base = key.rsplit(".", 1)[0] if "." in key.rsplit("/", 1)[-1] else key
    return f"{base}_thumb.jpg"


class S3Storage:
    def __init__(
        self,
        bucket: str,
        *,
        region: str | None = None,
        client: Any = None,
        prefix: str = "",
        public_base_url: str | None = None,
        private: bool = False,
        presign_expires: int = PRESIGN_MAX_SECONDS,
        thumbnails: bool = True,
        durations: bool = True,
        extra_put_args: dict[str, Any] | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("S3Storage needs a bucket")
        if not 1 <= presign_expires <= PRESIGN_MAX_SECONDS:
            raise ValueError("presign_expires must be between 1 s and 7 days")
        self.bucket = bucket
        self.region = region
        self.prefix = (prefix.strip("/") + "/") if prefix.strip("/") else ""
        if public_base_url:
            self.public_base_url = public_base_url.rstrip("/")
        elif region:
            self.public_base_url = f"https://{bucket}.s3.{region}.amazonaws.com"
        else:
            self.public_base_url = f"https://{bucket}.s3.amazonaws.com"
        self.private = private
        self.presign_expires = presign_expires
        self.thumbnails = thumbnails
        self.durations = durations
        self.extra_put_args = dict(extra_put_args or {})
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                import boto3
            except ImportError as exc:
                raise RuntimeError('S3Storage needs boto3: pip install "commskit[s3]"') from exc
            self._client = boto3.client("s3", region_name=self.region)
        return self._client

    # ------------------------------------------------------------------ keys

    def make_key(self, chat_id: int, media_type: str, file_name: str) -> str:
        return f"{self.prefix}chat/{chat_id}/{media_type}/{int(time.time())}_{uuid.uuid4().hex[:8]}_{_safe_name(file_name)}"

    def url_for(self, key: str) -> str:
        if self.private:
            return self.client.generate_presigned_url(
                "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=self.presign_expires,
            )
        return f"{self.public_base_url}/{quote(key, safe='/')}"

    def key_for(self, file_url: str) -> str | None:
        """Object key of a URL this storage produced (public or presigned); None otherwise."""
        if not file_url:
            return None
        base = self.public_base_url + "/"
        plain = file_url.split("?", 1)[0]
        if plain.startswith(base):
            key = unquote(plain[len(base):])
        else:
            parts = urlsplit(plain)
            path = unquote(parts.path.lstrip("/"))
            host = parts.netloc.lower()
            if host.startswith(f"{self.bucket.lower()}."):
                key = path  # virtual-hosted style
            elif path.startswith(f"{self.bucket}/"):
                key = path[len(self.bucket) + 1:]  # path style
            else:
                return None
        if not key.startswith(f"{self.prefix}chat/") or ".." in key.split("/"):
            return None
        return key

    def presign(self, file_url: str, expires: int | None = None) -> str | None:
        """Fresh presigned GET URL for a stored file (private buckets)."""
        key = self.key_for(file_url)
        if key is None:
            return None
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=min(expires or self.presign_expires, PRESIGN_MAX_SECONDS),
        )

    # ---------------------------------------------------------------- upload

    def _put(self, key: str, body: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type,
                               **self.extra_put_args)

    def _upload_sync(self, chat_id: int, file_name: str, data: bytes, media_type: str) -> MediaInfo:
        content_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        key = self.make_key(chat_id, media_type, file_name)
        self._put(key, data, content_type)
        info = MediaInfo(file_url=self.url_for(key), file_name=file_name, file_size=len(data),
                         file_type=content_type, media_type=media_type)
        suffix = os.path.splitext(file_name)[1].lower()
        thumb: bytes | None = None
        if self.thumbnails and media_type == "image":
            thumb = make_image_thumbnail(data)
        elif self.thumbnails and media_type in VIDEO_MEDIA_TYPES:
            thumb = make_video_thumbnail(data, suffix or ".mp4")
        if thumb:
            try:
                tkey = thumbnail_key(key)
                self._put(tkey, thumb, "image/jpeg")
                info.thumbnail_url = self.url_for(tkey)
            except Exception:
                logger.exception("Thumbnail upload failed for %s", key)
        if self.durations and media_type in DURATION_MEDIA_TYPES:
            info.duration = probe_duration(data, suffix)
        return info

    async def upload(self, chat_id: int, file_name: str, data: bytes, media_type: str) -> MediaInfo:
        return await asyncio.to_thread(self._upload_sync, chat_id, file_name, data, media_type)

    # ---------------------------------------------------------------- delete

    def _delete_sync(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)
        media_type = key[len(self.prefix):].split("/")[2] if key.count("/") >= 3 else ""
        if (media_type == "image" or media_type in VIDEO_MEDIA_TYPES) and not key.endswith("_thumb.jpg"):
            self.client.delete_object(Bucket=self.bucket, Key=thumbnail_key(key))

    async def delete(self, file_url: str) -> None:
        """Delete the object (and its thumbnail). Unknown URLs are ignored; S3 deletes are idempotent."""
        key = self.key_for(file_url)
        if key is None:
            return
        await asyncio.to_thread(self._delete_sync, key)
