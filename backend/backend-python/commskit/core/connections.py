"""Sockets per user, presence, rooms and fan-out.

In-memory by default (single worker). Pass a ``PresenceBridge`` such as
``commskit.core.redis_bridge.RedisBridge`` for multi-worker deployments.

Connection roles: every socket is registered with a role (``"user"`` by default; the hub's
``role_resolver`` decides). Only ``"user"`` connections take part in presence (``user_status``
broadcasts, offline hooks registered without ``all_roles``) and ``user.came_online``.

Rooms: ``join_room`` / ``leave_room`` / ``broadcast_room``. Membership is per worker (the one
holding the user's sockets); ``broadcast_room`` reaches members on every worker when the bridge
implements the optional ``publish_room`` / ``set_room_deliver`` methods (``RedisBridge`` does,
channel ``room_channel:{room}``).
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Iterable, Protocol

from fastapi import WebSocket

from .util import LRU, TaskSet, utcnow

logger = logging.getLogger("commskit.connections")

OfflineHook = Callable[[str], Awaitable[None]]
PartnersLookup = Callable[[str], Awaitable[Iterable[str]]]
Deliver = Callable[[str, dict], Awaitable[None]]

USER_ROLE = "user"


class PresenceBridge(Protocol):
    """Cross-worker presence + delivery (see ``RedisBridge``).

    Optional methods, looked up with ``getattr`` so older / custom bridges keep working:

    - ``set_room_deliver(deliver_room)`` and ``async publish_room(room, payload, origin)``: rooms
      across workers.
    - ``async claim_came_online(user_id, ttl_seconds) -> bool`` and
      ``async release_came_online(user_id)``: cluster-wide dedupe of ``user.came_online``.
    """

    heartbeat_seconds: float

    async def start(self, deliver: Deliver, server_id: str) -> None: ...
    async def stop(self) -> None: ...
    async def set_online(self, user_id: str, server_id: str) -> None: ...
    async def set_offline(self, user_id: str, server_id: str) -> None: ...
    async def set_away(self, user_id: str, away: bool) -> None: ...
    async def get_user_servers(self, user_id: str) -> list[str]: ...
    async def is_online(self, user_id: str) -> bool: ...
    async def get_online_users(self, user_ids: list[str]) -> set[str]: ...
    async def publish(self, user_id: str, payload: dict, origin: str) -> None: ...


@dataclass
class UserConnection:
    user_id: str
    status: str = "online"  # "online" (foreground) or anything else (= away)
    last_seen: datetime = field(default_factory=utcnow)


class ConnectionManager:
    def __init__(
        self,
        bridge: PresenceBridge | None = None,
        server_id: str | None = None,
        came_online_cooldown: float = 0.0,
        came_online_dedupe_seconds: float = 10.0,
    ) -> None:
        self.bridge = bridge
        self.server_id = server_id or f"{os.getenv('HOSTNAME', 'server')}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        # A user may hold several sockets (devices / screens); all get every frame.
        self.user_sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self.active_connections: dict[str, UserConnection] = {}
        self.roles: dict[str, str] = {}
        # Local room membership: room -> user ids, user id -> rooms.
        self.rooms: dict[str, set[str]] = defaultdict(set)
        self._user_rooms: dict[str, set[str]] = defaultdict(set)
        # user.came_online: 0 = only dedupe concurrent connects; > 0 = at most once per cooldown.
        self.came_online_cooldown = came_online_cooldown
        self.came_online_dedupe_seconds = came_online_dedupe_seconds
        self._came_online_at: LRU[str, float] = LRU(100_000)
        self._offline_hooks: list[tuple[OfflineHook, bool]] = []
        self._partners_lookup: PartnersLookup | None = None
        self._tasks = TaskSet()

    # ----------------------------------------------------------- lifecycle

    async def start(self) -> None:
        """Start the bridge consumer (call from the app lifespan)."""
        if self.bridge is not None:
            set_room_deliver = getattr(self.bridge, "set_room_deliver", None)
            if set_room_deliver is not None:
                set_room_deliver(self._deliver_room_from_bridge)
            await self.bridge.start(self._deliver_from_bridge, self.server_id)

    async def stop(self) -> None:
        await self._tasks.cancel_all()
        if self.bridge is not None:
            await self.bridge.stop()

    def add_offline_hook(self, hook: OfflineHook, all_roles: bool = False) -> None:
        """``hook(user_id)`` runs when the user's last socket on this worker closes.

        Only for ``"user"`` connections unless ``all_roles``."""
        self._offline_hooks.append((hook, all_roles))

    def set_partners_lookup(self, lookup: PartnersLookup | None) -> None:
        """Who should receive this user's ``user_status`` (chat installs this)."""
        self._partners_lookup = lookup

    def role_of(self, user_id: str) -> str:
        """Role of a connected user on this worker (``"user"`` when unknown)."""
        return self.roles.get(user_id, USER_ROLE)

    # ---------------------------------------------------------- connections

    async def register(self, user_id: str, websocket: WebSocket, role: str = USER_ROLE) -> bool:
        """Register an already-accepted socket.

        Returns True when this connect is the user's offline -> online transition across all
        workers (the hub then emits ``user.came_online``); always False for non-user roles."""
        first_socket = not self.user_sockets.get(user_id)
        self.user_sockets[user_id].add(websocket)
        self.roles[user_id] = role
        self.active_connections[user_id] = UserConnection(user_id=user_id)
        came_online = False
        if first_socket and role == USER_ROLE:
            came_online = await self._claim_came_online(user_id)
        if self.bridge is not None:
            await self.bridge.set_online(user_id, self.server_id)
            await self.bridge.set_away(user_id, False)
        if first_socket:
            await self.broadcast_user_status(user_id, "online")
        return came_online

    async def _claim_came_online(self, user_id: str) -> bool:
        if self.bridge is not None:
            try:
                others = [s for s in await self.bridge.get_user_servers(user_id) if s != self.server_id]
            except Exception:
                others = []
            if others:
                return False  # already online on another worker
            claim = getattr(self.bridge, "claim_came_online", None)
            if claim is not None:
                ttl = self.came_online_cooldown or self.came_online_dedupe_seconds
                try:
                    return bool(await claim(user_id, ttl))
                except Exception:
                    logger.exception("claim_came_online(%s) failed", user_id)
        if self.came_online_cooldown > 0:
            now = time.monotonic()
            last = self._came_online_at.get(user_id)
            if last is not None and now - last < self.came_online_cooldown:
                return False
            self._came_online_at.put(user_id, now)
        return True

    async def heartbeat(self, user_id: str) -> None:
        if self.bridge is not None and self.user_sockets.get(user_id):
            await self.bridge.set_online(user_id, self.server_id)

    def disconnect(self, user_id: str, websocket: WebSocket | None = None) -> None:
        """Remove one socket (or all). User stays online while any socket remains. Idempotent."""
        sockets = self.user_sockets.get(user_id)
        if sockets is not None and websocket is not None:
            sockets.discard(websocket)
            if sockets:
                return
        self.user_sockets.pop(user_id, None)
        role = self.roles.pop(user_id, USER_ROLE)
        for room in self._user_rooms.pop(user_id, set()):
            members = self.rooms.get(room)
            if members is not None:
                members.discard(user_id)
                if not members:
                    self.rooms.pop(room, None)
        if self.active_connections.pop(user_id, None) is None:
            return
        self._tasks.spawn(self._went_offline(user_id, role))
        for hook, all_roles in self._offline_hooks:
            if role == USER_ROLE or all_roles:
                self._tasks.spawn(hook(user_id))

    async def _went_offline(self, user_id: str, role: str = USER_ROLE) -> None:
        # Reconnected here before this ran: don't wipe presence or announce offline.
        if self.user_sockets.get(user_id):
            return
        if self.bridge is not None:
            await self.bridge.set_offline(user_id, self.server_id)
        if await self.is_connected(user_id):
            return  # still connected on another worker; that one announces offline
        if role != USER_ROLE:
            return
        if self.bridge is not None and not self.came_online_cooldown:
            release = getattr(self.bridge, "release_came_online", None)
            if release is not None:
                try:
                    await release(user_id)
                except Exception:
                    logger.exception("release_came_online(%s) failed", user_id)
        await self._broadcast_status(user_id, "offline")

    async def set_status(self, user_id: str, status: str) -> None:
        """Client-reported foreground ("online") / background (anything else)."""
        now = utcnow()
        conn = self.active_connections.get(user_id)
        if conn is not None:
            conn.status = status
            conn.last_seen = now
        if self.bridge is not None:
            await self.bridge.set_away(user_id, status != "online")
        await self.broadcast_user_status(user_id, status, now)

    # ------------------------------------------------------------- presence

    def is_user_online(self, user_id: str) -> bool:
        """Local only: foreground socket on this worker."""
        conn = self.active_connections.get(user_id)
        return conn is not None and conn.status == "online"

    async def is_online(self, user_id: str) -> bool:
        """Cluster-wide: connected somewhere with the app in foreground."""
        if self.is_user_online(user_id):
            return True
        return self.bridge is not None and await self.bridge.is_online(user_id)

    async def is_connected(self, user_id: str) -> bool:
        """Cluster-wide: any open socket (foreground or background)."""
        if self.user_sockets.get(user_id):
            return True
        return self.bridge is not None and bool(await self.bridge.get_user_servers(user_id))

    async def get_online_users(self, user_ids: list[str]) -> set[str]:
        local = {uid for uid in user_ids if self.is_user_online(uid)}
        if self.bridge is None:
            return local
        return local | await self.bridge.get_online_users([u for u in user_ids if u not in local])

    # ------------------------------------------------------------- delivery

    async def _send_local(self, user_id: str, text: str) -> bool:
        delivered = False
        dead: list[WebSocket] = []
        for ws in list(self.user_sockets.get(user_id, ())):
            try:
                await ws.send_text(text)
                delivered = True
            except Exception as exc:
                logger.warning("Send to %s failed: %s", user_id, exc)
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)
        return delivered

    async def send(self, user_id: str, payload: dict[str, Any]) -> bool:
        """Deliver to every socket of the user on any worker. True if at least one got it."""
        delivered = await self._send_local(user_id, json.dumps(payload))
        if self.bridge is not None:
            remote = [s for s in await self.bridge.get_user_servers(user_id) if s != self.server_id]
            if remote:
                await self.bridge.publish(user_id, payload, origin=self.server_id)
                delivered = True
        return delivered

    # Legacy name used throughout the reference implementation.
    send_personal_message = send

    async def send_to_socket(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        await websocket.send_text(json.dumps(payload))

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """Every socket on this worker (e.g. host community events)."""
        text = json.dumps(payload)
        for user_id in list(self.user_sockets):
            await self._send_local(user_id, text)

    async def _deliver_from_bridge(self, user_id: str, envelope: dict) -> None:
        if "origin" in envelope and "data" in envelope:
            if envelope["origin"] == self.server_id:
                return  # we published it and already delivered locally
            envelope = envelope["data"]
        await self._send_local(user_id, json.dumps(envelope))

    # ---------------------------------------------------------------- rooms

    def join_room(self, user_id: str, room: str) -> bool:
        """Add the user's sockets on this worker to ``room`` (left automatically on disconnect).

        False when the user has no socket on this worker."""
        if not self.user_sockets.get(user_id):
            return False
        self.rooms[room].add(user_id)
        self._user_rooms[user_id].add(room)
        return True

    def leave_room(self, user_id: str, room: str) -> None:
        members = self.rooms.get(room)
        if members is not None:
            members.discard(user_id)
            if not members:
                self.rooms.pop(room, None)
        rooms = self._user_rooms.get(user_id)
        if rooms is not None:
            rooms.discard(room)
            if not rooms:
                self._user_rooms.pop(user_id, None)

    def room_members(self, room: str) -> set[str]:
        """Members on this worker."""
        return set(self.rooms.get(room, ()))

    async def _send_room_local(self, room: str, payload: dict[str, Any]) -> int:
        text = json.dumps(payload)
        reached = 0
        for user_id in list(self.rooms.get(room, ())):
            if await self._send_local(user_id, text):
                reached += 1
        return reached

    async def broadcast_room(self, room: str, payload: dict[str, Any]) -> int:
        """Send ``payload`` unchanged to every member on every worker.

        Returns how many local members got it (members on other workers aren't counted)."""
        reached = await self._send_room_local(room, payload)
        publish_room = getattr(self.bridge, "publish_room", None) if self.bridge is not None else None
        if publish_room is not None:
            await publish_room(room, payload, origin=self.server_id)
        return reached

    async def _deliver_room_from_bridge(self, room: str, envelope: dict) -> None:
        if "origin" in envelope and "data" in envelope:
            if envelope["origin"] == self.server_id:
                return
            envelope = envelope["data"]
        await self._send_room_local(room, envelope)

    # ------------------------------------------------------------- presence

    async def broadcast_user_status(self, user_id: str, status: str, timestamp: datetime | None = None) -> None:
        """Presence goes only to the user's conversation partners (never for non-user roles)."""
        if self.role_of(user_id) != USER_ROLE:
            return
        await self._broadcast_status(user_id, status, timestamp)

    async def _broadcast_status(self, user_id: str, status: str, timestamp: datetime | None = None) -> None:
        if self._partners_lookup is None:
            return
        payload = {
            "type": "user_status",
            "user_id": user_id,
            "status": status,
            "timestamp": (timestamp or utcnow()).isoformat(),
        }
        try:
            partners = list(await self._partners_lookup(user_id))
        except Exception:
            logger.exception("Partner lookup for %s failed", user_id)
            return
        for partner_id in partners:
            await self.send(partner_id, payload)
