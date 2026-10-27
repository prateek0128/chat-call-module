"""Interfaces the host app implements, with safe defaults.

Every adapter is a ``typing.Protocol``: any object with matching methods works,
no subclassing needed.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import mimetypes
import os
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Protocol, Sequence, runtime_checkable

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("commskit.media")

# The host supplies an ``async_sessionmaker`` (or any zero-arg callable returning
# an AsyncSession usable as an async context manager).
SessionFactory = Callable[[], AsyncSession]


# --------------------------------------------------------------------- auth


class AuthError(Exception):
    """Token is missing, invalid or expired."""


@runtime_checkable
class AuthAdapter(Protocol):
    def user_id_from_token(self, token: str) -> str | Awaitable[str]:
        """Return the user id for ``token`` or raise (any exception = invalid)."""
        ...


class JwtAuth:
    """HS256 (by default) JWT auth reading the user id from ``claim``."""

    def __init__(self, secret: str, algorithm: str = "HS256", claim: str = "uid") -> None:
        if not secret:
            raise ValueError("JwtAuth needs a non-empty secret")
        self._secret = secret
        self._algorithm = algorithm
        self._claim = claim

    def user_id_from_token(self, token: str) -> str:
        import jwt

        try:
            payload = jwt.decode(token, self._secret, algorithms=[self._algorithm])
        except jwt.PyJWTError as exc:
            raise AuthError(str(exc)) from exc
        user_id = payload.get(self._claim)
        if user_id is None or user_id == "":
            raise AuthError(f"Token has no '{self._claim}' claim")
        return str(user_id)


async def resolve_user_id(auth: AuthAdapter, token: str) -> str:
    """Call the adapter, supporting both sync and async implementations."""
    result = auth.user_id_from_token(token)
    if inspect.isawaitable(result):
        result = await result
    return str(result)


def bearer_dependency(auth: AuthAdapter) -> Callable[..., Awaitable[str]]:
    """FastAPI dependency: ``Authorization: Bearer <token>`` -> user id (401 otherwise)."""
    scheme = HTTPBearer(auto_error=False)

    async def current_user_id(
        credentials: HTTPAuthorizationCredentials | None = Depends(scheme),
    ) -> str:
        if credentials is None or not credentials.credentials:
            raise HTTPException(status_code=401, detail="Not authenticated")
        try:
            return await resolve_user_id(auth, credentials.credentials)
        except Exception as exc:
            raise HTTPException(status_code=401, detail="Invalid token") from exc

    return current_user_id


# ---------------------------------------------------------------- directory


@dataclass(frozen=True)
class UserProfile:
    name: str | None = None
    avatar: str | None = None


class UserDirectory(Protocol):
    async def get_profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        """Display info for the ids it knows; unknown ids may be omitted."""
        ...


class NullUserDirectory:
    """Knows nobody: names fall back to user ids / "Someone"."""

    async def get_profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        return {}


class StaticUserDirectory:
    """In-memory directory (tests, demos)."""

    def __init__(self, profiles: Mapping[str, UserProfile] | None = None) -> None:
        self.profiles: dict[str, UserProfile] = dict(profiles or {})

    async def get_profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        return {uid: self.profiles[uid] for uid in user_ids if uid in self.profiles}


# --------------------------------------------------------------------- push


class PushSender(Protocol):
    async def send(
        self,
        user_id: str,
        title: str,
        body: str,
        data: Mapping[str, Any],
        channel: str = "default",
        ttl: int | None = None,
    ) -> None:
        """Push to every device of ``user_id``. Must not raise for "no devices"."""
        ...


class NoopPush:
    async def send(
        self,
        user_id: str,
        title: str,
        body: str,
        data: Mapping[str, Any],
        channel: str = "default",
        ttl: int | None = None,
    ) -> None:
        return None


class DeviceRegistry(Protocol):
    """Optional: backs the ``/chats/expo/push/token`` routes."""

    async def register(self, user_id: str, payload: Mapping[str, Any]) -> Mapping[str, Any]: ...

    async def remove(self, user_id: str, payload: Mapping[str, Any]) -> Mapping[str, Any]: ...


# -------------------------------------------------------------------- media


@dataclass
class MediaInfo:
    file_url: str
    file_name: str
    file_size: int
    file_type: str
    media_type: str
    thumbnail_url: str | None = None
    duration: int | None = None


class MediaStorage(Protocol):
    async def upload(self, chat_id: int, file_name: str, data: bytes, media_type: str) -> MediaInfo:
        """Store the file and return where it lives. Raise ValueError to reject it.

        Do slow, blocking work (disk, S3, thumbnails) in a thread (``asyncio.to_thread``)."""
        ...

    async def delete(self, file_url: str) -> None:
        """Optional: remove a stored file (unsend, user deletion). Storages without it are skipped
        (see ``delete_media``). Must not raise for files that are already gone."""
        ...


async def delete_media(storage: Any, *file_urls: str | None) -> int:
    """Delete files through ``storage.delete`` when the storage has it (no-op otherwise).

    Never raises; returns how many deletes were attempted without error."""
    delete = getattr(storage, "delete", None)
    if delete is None:
        return 0
    done = 0
    for url in dict.fromkeys(u for u in file_urls if u):
        try:
            await delete(url)
            done += 1
        except Exception:
            logger.exception("Deleting media %s failed", url)
    return done


class LocalDiskStorage:
    """Writes files under ``root/chat/<chat_id>/<media_type>/``.

    ``file_url`` is ``base_url`` + relative path; serve ``root`` yourself
    (e.g. ``app.mount("/media", StaticFiles(directory=root))``).
    """

    def __init__(self, root: str = "comms_media", base_url: str = "/media") -> None:
        self.root = root
        self.base_url = base_url.rstrip("/")

    async def upload(self, chat_id: int, file_name: str, data: bytes, media_type: str) -> MediaInfo:
        safe_name = os.path.basename(file_name).replace(" ", "_") or "file"
        rel = f"chat/{chat_id}/{media_type}/{uuid.uuid4().hex[:12]}_{safe_name}"
        path = os.path.join(self.root, *rel.split("/"))

        def _write() -> None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(data)

        await asyncio.to_thread(_write)
        mime, _ = mimetypes.guess_type(file_name)
        return MediaInfo(
            file_url=f"{self.base_url}/{rel}",
            file_name=file_name,
            file_size=len(data),
            file_type=mime or "application/octet-stream",
            media_type=media_type,
        )

    def path_for(self, file_url: str) -> str | None:
        """Local path of a URL this storage produced; None for anything else (incl. ``..`` tricks)."""
        prefix = f"{self.base_url}/"
        url = file_url.split("?", 1)[0]
        if not url.startswith(prefix):
            return None
        rel = url[len(prefix):]
        parts = rel.split("/")
        if not rel or any(p in ("", ".", "..") for p in parts):
            return None
        root = os.path.abspath(self.root)
        path = os.path.abspath(os.path.join(root, *parts))
        if os.path.commonpath([root, path]) != root:
            return None
        return path

    async def delete(self, file_url: str) -> None:
        path = self.path_for(file_url)
        if path is None:
            return

        def _remove() -> None:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

        await asyncio.to_thread(_remove)
