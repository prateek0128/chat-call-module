"""Optional Redis presence + cross-worker delivery (``pip install commskit[redis]``).

Key names match matrimonial-backend-v2 so old and new workers interoperate:
``presence:{uid}`` (hash server_id -> last heartbeat epoch), ``presence_away:{uid}``,
pub/sub channel ``user_channel:{uid}`` carrying ``{"origin", "data"}``.
Kit additions: rooms on ``room_channel:{room}`` (same envelope) and the ``user.came_online`` dedupe key
``came_online:{uid}`` (``SET NX`` with a TTL).

Every Redis failure is logged and degrades to "not connected"; it never raises.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

import redis.asyncio as redis

from .connections import Deliver

logger = logging.getLogger("commskit.redis")

USER_CHANNEL_FMT = "user_channel:{user_id}"
USER_CHANNEL_PATTERN = "user_channel:*"
PRESENCE_KEY_FMT = "presence:{user_id}"
AWAY_KEY_FMT = "presence_away:{user_id}"
ROOM_CHANNEL_PREFIX = "room_channel:"
ROOM_CHANNEL_PATTERN = "room_channel:*"
CAME_ONLINE_KEY_FMT = "came_online:{user_id}"

RoomDeliver = Callable[[str, dict], Awaitable[None]]


class RedisBridge:
    def __init__(
        self,
        url: str | None = None,
        client: "redis.Redis | None" = None,
        heartbeat_seconds: float = 30,
        stale_seconds: float = 90,
        presence_ttl_seconds: int = 120,
        away_ttl_seconds: int = 12 * 3600,
    ) -> None:
        if url is None and client is None:
            raise ValueError("RedisBridge needs a url or a client")
        self._url = url
        self.client: "redis.Redis | None" = client
        self.heartbeat_seconds = heartbeat_seconds
        self.stale_seconds = stale_seconds
        self.presence_ttl_seconds = presence_ttl_seconds
        self.away_ttl_seconds = away_ttl_seconds
        self._pubsub: Any = None
        self._consumer: asyncio.Task[None] | None = None
        self._deliver: Deliver | None = None
        self._room_deliver: RoomDeliver | None = None

    # ----------------------------------------------------------- lifecycle

    def set_room_deliver(self, deliver_room: RoomDeliver) -> None:
        self._room_deliver = deliver_room

    async def start(self, deliver: Deliver, server_id: str) -> None:
        self._deliver = deliver
        try:
            if self.client is None:
                self.client = redis.from_url(
                    self._url, decode_responses=True, socket_keepalive=True,
                    socket_connect_timeout=5, socket_timeout=5, retry_on_timeout=True,
                    health_check_interval=30,
                )
            await self.client.ping()
            self._pubsub = self.client.pubsub()
            await self._pubsub.psubscribe(USER_CHANNEL_PATTERN, ROOM_CHANNEL_PATTERN)
            self._consumer = asyncio.create_task(self._consume())
        except Exception as exc:
            logger.warning("Redis unavailable (%s); running single-worker", exc)
            self.client = None
            self._pubsub = None

    async def stop(self) -> None:
        if self._consumer is not None:
            self._consumer.cancel()
            try:
                await self._consumer
            except (asyncio.CancelledError, Exception):
                pass
        for obj in (self._pubsub, self.client):
            if obj is None:
                continue
            close = getattr(obj, "aclose", None) or obj.close
            try:
                await close()
            except Exception:
                pass

    async def _consume(self) -> None:
        async for raw in self._pubsub.listen():
            if not raw or raw.get("type") not in {"pmessage", "message"}:
                continue
            channel, data = raw.get("channel"), raw.get("data")
            if not isinstance(channel, str) or not data:
                continue
            if channel.startswith(ROOM_CHANNEL_PREFIX):
                room = channel[len(ROOM_CHANNEL_PREFIX):]
                if self._room_deliver is None:
                    continue
                try:
                    await self._room_deliver(room, json.loads(data) if isinstance(data, str) else data)
                except Exception as exc:
                    logger.warning("Cross-worker room delivery to %s failed: %s", room, exc)
                continue
            if self._deliver is None:
                continue
            user_id = channel.rsplit(":", 1)[-1]
            try:
                payload = json.loads(data) if isinstance(data, str) else data
                await self._deliver(user_id, payload)
            except Exception as exc:
                logger.warning("Cross-worker delivery to %s failed: %s", user_id, exc)

    # ------------------------------------------------------------ presence

    async def set_online(self, user_id: str, server_id: str) -> None:
        if self.client is None:
            return
        key = PRESENCE_KEY_FMT.format(user_id=user_id)
        try:
            async with self.client.pipeline(transaction=False) as pipe:
                pipe.hset(key, server_id, int(time.time()))
                pipe.expire(key, self.presence_ttl_seconds)
                await pipe.execute()
        except Exception as exc:
            logger.warning("set_online(%s) failed: %s", user_id, exc)

    async def set_offline(self, user_id: str, server_id: str) -> None:
        if self.client is None:
            return
        try:
            await self.client.hdel(PRESENCE_KEY_FMT.format(user_id=user_id), server_id)
        except Exception as exc:
            logger.warning("set_offline(%s) failed: %s", user_id, exc)

    async def set_away(self, user_id: str, away: bool) -> None:
        if self.client is None:
            return
        key = AWAY_KEY_FMT.format(user_id=user_id)
        try:
            if away:
                await self.client.set(key, 1, ex=self.away_ttl_seconds)
            else:
                await self.client.delete(key)
        except Exception as exc:
            logger.warning("set_away(%s) failed: %s", user_id, exc)

    async def get_user_servers(self, user_id: str) -> list[str]:
        if self.client is None:
            return []
        try:
            entries = await self.client.hgetall(PRESENCE_KEY_FMT.format(user_id=user_id))
        except Exception as exc:
            logger.warning("get_user_servers(%s) failed: %s", user_id, exc)
            return []
        cutoff = time.time() - self.stale_seconds
        return [server for server, beat in (entries or {}).items() if float(beat) >= cutoff]

    async def is_online(self, user_id: str) -> bool:
        if not await self.get_user_servers(user_id):
            return False
        try:
            return not await self.client.exists(AWAY_KEY_FMT.format(user_id=user_id))
        except Exception:
            return True

    async def get_online_users(self, user_ids: list[str]) -> set[str]:
        if self.client is None or not user_ids:
            return set()
        try:
            async with self.client.pipeline(transaction=False) as pipe:
                for uid in user_ids:
                    pipe.hgetall(PRESENCE_KEY_FMT.format(user_id=uid))
                    pipe.exists(AWAY_KEY_FMT.format(user_id=uid))
                results = await pipe.execute()
        except Exception as exc:
            logger.warning("get_online_users failed: %s", exc)
            return set()
        cutoff = time.time() - self.stale_seconds
        online: set[str] = set()
        for i, uid in enumerate(user_ids):
            servers, away = results[2 * i], results[2 * i + 1]
            if not away and any(float(b) >= cutoff for b in (servers or {}).values()):
                online.add(uid)
        return online

    async def publish(self, user_id: str, payload: dict, origin: str) -> None:
        if self.client is None:
            return
        try:
            await self.client.publish(
                USER_CHANNEL_FMT.format(user_id=user_id),
                json.dumps({"origin": origin, "data": payload}),
            )
        except Exception as exc:
            logger.warning("publish(%s) failed: %s", user_id, exc)

    async def publish_room(self, room: str, payload: dict, origin: str) -> None:
        if self.client is None:
            return
        try:
            await self.client.publish(ROOM_CHANNEL_PREFIX + room, json.dumps({"origin": origin, "data": payload}))
        except Exception as exc:
            logger.warning("publish_room(%s) failed: %s", room, exc)

    # ------------------------------------------------------- user.came_online

    async def claim_came_online(self, user_id: str, ttl_seconds: float) -> bool:
        """True for exactly one caller until the key expires or is released (``SET NX PX``).
        Without Redis every caller wins (single-worker behaviour)."""
        if self.client is None:
            return True
        try:
            return bool(await self.client.set(CAME_ONLINE_KEY_FMT.format(user_id=user_id), 1, nx=True,
                                              px=max(1, int(ttl_seconds * 1000))))
        except Exception as exc:
            logger.warning("claim_came_online(%s) failed: %s", user_id, exc)
            return True

    async def release_came_online(self, user_id: str) -> None:
        if self.client is None:
            return
        try:
            await self.client.delete(CAME_ONLINE_KEY_FMT.format(user_id=user_id))
        except Exception as exc:
            logger.warning("release_came_online(%s) failed: %s", user_id, exc)
