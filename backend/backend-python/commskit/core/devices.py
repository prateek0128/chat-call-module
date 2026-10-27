"""Devices: the ``comms_devices`` table, ``SqlDeviceRegistry`` and the device REST routes.

Works with chat only, call only or both: install it on the hub on its own::

    devices = SqlDeviceRegistry(AsyncSessionLocal)
    DevicesFeature(devices).install(hub)      # POST /devices, DELETE /devices/{id}, legacy /chats/expo/push/token[/remove]

``SqlDeviceRegistry`` implements the ``DeviceRegistry`` protocol (``register`` / ``remove``, used by
the legacy routes) and ``DeviceStore`` (``devices_for`` / ``remove_token``, used by the push senders).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Mapping, Protocol, Sequence

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import DateTime, Integer, String, delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from .adapters import SessionFactory
from .db import CommsBase
from .util import utcnow

if TYPE_CHECKING:
    from .hub import CommsHub

logger = logging.getLogger("commskit.devices")

PLATFORMS = ("ios", "android", "web")
TokenKind = Literal["expo", "voip"]


class Device(CommsBase):
    __tablename__ = "comms_devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    device_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    expo_push_token: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    voip_token: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    app_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    os_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


@dataclass(frozen=True)
class DeviceInfo:
    """Plain (session-free) view of a device row."""

    user_id: str
    device_id: str
    platform: str
    expo_push_token: str | None = None
    voip_token: str | None = None
    app_version: str | None = None
    os_version: str | None = None
    model: str | None = None

    @classmethod
    def from_row(cls, row: Device) -> "DeviceInfo":
        return cls(row.user_id, row.device_id, row.platform, row.expo_push_token, row.voip_token,
                   row.app_version, row.os_version, row.model)


class DeviceStore(Protocol):
    """What the push senders need from a registry."""

    async def devices_for(self, user_id: str) -> Sequence[DeviceInfo]: ...

    async def remove_token(self, token: str, kind: TokenKind = "expo") -> int:
        """Forget a token the push service reported invalid. Returns rows changed."""
        ...


def _clean(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


def _first(payload: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if payload.get(key) not in (None, ""):
            return payload[key]
    return None


def _platform(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in ("ios", "iphone", "ipad", "ipados"):
        return "ios"
    if text in ("android",):
        return "android"
    if text in ("web",):
        return "web"
    if text in ("", "unknown"):
        return "unknown"  # legacy registrations that never said; treated like "web" for routing
    raise ValueError("platform must be one of: ios, android, web")


class SqlDeviceRegistry:
    """Devices in ``comms_devices`` (one row per app install, keyed by ``device_id``)."""

    def __init__(self, session_factory: SessionFactory) -> None:
        self.session_factory = session_factory

    # ------------------------------------------------------------ writes

    async def upsert(
        self,
        user_id: str,
        device_id: str,
        platform: str,
        *,
        expo_push_token: str | None = None,
        voip_token: str | None = None,
        app_version: str | None = None,
        os_version: str | None = None,
        model: str | None = None,
    ) -> DeviceInfo:
        """Create or update the device. A device that changes hands (logout, then another
        user logs in on the same phone) moves to ``user_id``. A token can live on one
        device only, so other rows carrying the same token lose it."""
        device_id = _clean(device_id, 255) or ""
        if not device_id:
            raise ValueError("device_id is required")
        platform = _platform(platform)
        values = {
            "user_id": str(user_id),
            "platform": platform,
            "expo_push_token": _clean(expo_push_token, 255),
            "voip_token": _clean(voip_token, 255),
            "app_version": _clean(app_version, 64),
            "os_version": _clean(os_version, 64),
            "model": _clean(model, 128),
        }
        for attempt in range(2):
            try:
                return await self._upsert_once(device_id, values)
            except IntegrityError:
                if attempt:
                    raise
                # Two requests inserted the same device_id concurrently: the retry updates it.
        raise AssertionError("unreachable")

    async def _upsert_once(self, device_id: str, values: dict[str, Any]) -> DeviceInfo:
        now = utcnow()
        async with self.session_factory() as session:
            for column in ("expo_push_token", "voip_token"):
                if values[column]:
                    await session.execute(
                        update(Device)
                        .where(getattr(Device, column) == values[column], Device.device_id != device_id)
                        .values({column: None, "updated_at": now})
                        .execution_options(synchronize_session=False)
                    )
            row = (await session.execute(select(Device).where(Device.device_id == device_id))).scalar_one_or_none()
            if row is None:
                row = Device(device_id=device_id, created_at=now, **values)
                session.add(row)
            else:
                changed_hands = row.user_id != values["user_id"]
                for key, value in values.items():
                    # Optional fields the client did not send keep their value, unless the
                    # device changed hands (then stale tokens must not follow it).
                    if value is not None or key == "user_id" or changed_hands:
                        setattr(row, key, value)
            row.updated_at = now
            row.last_seen_at = now
            info = DeviceInfo.from_row(row)
            await session.commit()
            return info

    async def delete(self, user_id: str, device_id: str) -> bool:
        async with self.session_factory() as session:
            result = await session.execute(
                delete(Device).where(Device.device_id == device_id, Device.user_id == str(user_id))
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return bool(result.rowcount)

    async def delete_user(self, user_id: str) -> int:
        """Forget every device of ``user_id`` (account deletion). Returns rows deleted."""
        async with self.session_factory() as session:
            result = await session.execute(
                delete(Device).where(Device.user_id == str(user_id)).execution_options(synchronize_session=False)
            )
            await session.commit()
            return int(result.rowcount or 0)

    async def remove_token(self, token: str, kind: TokenKind = "expo") -> int:
        column =Device.voip_token if kind == "voip" else Device.expo_push_token
        async with self.session_factory() as session:
            result = await session.execute(
                update(Device).where(column == token).values({column.key: None, "updated_at": utcnow()})
                .execution_options(synchronize_session=False)
            )
            await session.commit()
        if result.rowcount:
            logger.info("Removed invalid %s push token", kind)
        return int(result.rowcount or 0)

    # ------------------------------------------------------------- reads

    async def devices_for(self, user_id: str) -> list[DeviceInfo]:
        async with self.session_factory() as session:
            rows = (await session.execute(
                select(Device).where(Device.user_id == str(user_id)).order_by(Device.id)
            )).scalars().all()
            return [DeviceInfo.from_row(r) for r in rows]

    async def get(self, device_id: str) -> DeviceInfo | None:
        async with self.session_factory() as session:
            row = (await session.execute(select(Device).where(Device.device_id == device_id))).scalar_one_or_none()
            return DeviceInfo.from_row(row) if row else None

    # ------------------------------------------- DeviceRegistry (legacy routes)

    async def register(self, user_id: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        """Legacy ``POST /chats/expo/push/token`` body. Accepted keys:
        ``expo_push_token`` | ``token`` | ``push_token``, ``device_id`` | ``deviceId``,
        ``platform`` | ``device_type`` | ``os`` and the ``/devices`` fields.
        Without a ``device_id`` the token itself identifies the install."""
        token = _first(payload, "expo_push_token", "token", "push_token", "expoPushToken")
        device_id = _first(payload, "device_id", "deviceId")
        if not device_id and not token:
            raise HTTPException(status_code=422, detail="expo_push_token or device_id is required")
        platform = _first(payload, "platform", "device_type", "os") or "unknown"
        try:
            await self.upsert(
                user_id, str(device_id or f"expo:{token}"), platform,
                expo_push_token=token, voip_token=_first(payload, "voip_token", "voipToken"),
                app_version=_first(payload, "app_version", "appVersion"),
                os_version=_first(payload, "os_version", "osVersion"),
                model=_first(payload, "model", "device_name", "deviceName"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"status": True, "message": "Push token registered"}

    async def remove(self, user_id: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        """Legacy ``POST /chats/expo/push/token/remove``: by ``device_id`` or token (own devices only)."""
        device_id = _first(payload, "device_id", "deviceId")
        token = _first(payload, "expo_push_token", "token", "push_token", "expoPushToken")
        removed = False
        if device_id:
            removed = await self.delete(user_id, str(device_id))
        elif token:
            async with self.session_factory() as session:
                result = await session.execute(
                    delete(Device).where(Device.expo_push_token == str(token), Device.user_id == str(user_id))
                    .execution_options(synchronize_session=False)
                )
                await session.commit()
                removed = bool(result.rowcount)
        else:
            raise HTTPException(status_code=422, detail="expo_push_token or device_id is required")
        return {"status": True, "removed": removed}


# ------------------------------------------------------------------ REST


def build_devices_router(hub: "CommsHub", registry: SqlDeviceRegistry, legacy_routes: bool = True) -> APIRouter:
    router = APIRouter(tags=["devices"])
    current_user = hub.current_user

    @router.post("/devices")
    async def register_device(
        payload: dict[str, Any] = Body(...),
        user_id: str = Depends(current_user),
    ) -> dict[str, Any]:
        if not payload.get("device_id"):
            raise HTTPException(status_code=422, detail="device_id is required")
        if str(payload.get("platform", "")).lower() not in PLATFORMS:
            raise HTTPException(status_code=422, detail="platform must be one of: ios, android, web")
        try:
            await registry.upsert(
                user_id, str(payload["device_id"]), str(payload["platform"]),
                expo_push_token=payload.get("expo_push_token"), voip_token=payload.get("voip_token"),
                app_version=payload.get("app_version"), os_version=payload.get("os_version"),
                model=payload.get("model"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"status": True}

    @router.delete("/devices/{device_id}")
    async def delete_device(device_id: str, user_id: str = Depends(current_user)) -> dict[str, Any]:
        await registry.delete(user_id, device_id)  # idempotent: logging out twice is fine
        return {"status": True}

    if legacy_routes:
        @router.post("/chats/expo/push/token")
        async def legacy_register(payload: dict[str, Any] = Body(...), user_id: str = Depends(current_user)) -> Any:
            return await registry.register(user_id, payload)

        @router.post("/chats/expo/push/token/remove")
        async def legacy_remove(payload: dict[str, Any] = Body(...), user_id: str = Depends(current_user)) -> Any:
            return await registry.remove(user_id, payload)

    return router


class DevicesFeature:
    """Mounts the device routes on the hub (independent of chat / call).

    ``legacy_routes`` also mounts ``/chats/expo/push/token[/remove]`` on the same registry, so
    installed apps keep working even without the chat feature. Don't also pass ``devices=`` to
    ``ChatFeature`` (if you do, chat skips its copy of the legacy routes when this is installed first).
    """

    name = "devices"

    def __init__(self, registry: SqlDeviceRegistry, legacy_routes: bool = True) -> None:
        self.registry = registry
        self.legacy_routes = legacy_routes

    def install(self, hub: "CommsHub") -> "DevicesFeature":
        hub.register_feature(self.name, self)
        hub.include_router(build_devices_router(hub, self.registry, self.legacy_routes))
        return self

    async def delete_user_data(self, user_id: str) -> dict[str, int]:
        """Account deletion: drop all of the user's devices and tokens."""
        return {"devices": await self.registry.delete_user(user_id)}
