"""Core additions: rate limiter, connection roles, rooms, user.came_online, on_handler_error."""

from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from typing import Any

import pytest

from conftest import auth_headers, expect, expect_none, recv, send, sync

from commskit.core import ConnectionManager, RateLimit, RateLimiter, RedisRateLimiter

# ------------------------------------------------------------- rate limiter


async def test_token_bucket():
    now = [0.0]
    limiter = RateLimiter(clock=lambda: now[0])
    limit = RateLimit(2, 10)  # 1 token / 5 s
    assert await limiter.hit("k", limit) == 0 and await limiter.hit("k", limit) == 0
    wait = await limiter.hit("k", limit)
    assert wait == pytest.approx(5.0)
    assert await limiter.hit("other", limit) == 0  # separate bucket
    now[0] = 5.0
    assert await limiter.hit("k", limit) == 0
    assert await limiter.hit("k", limit) > 0
    now[0] = 100.0  # refills up to capacity only
    assert [await limiter.hit("k", limit) for _ in range(3)][:2] == [0, 0]
    assert await limiter.hit("k", None) == 0
    with pytest.raises(ValueError):
        RateLimit(0, 1)


class FakeEvalClient:
    def __init__(self, replies: list[Any]) -> None:
        self.replies = replies
        self.calls: list[tuple] = []

    async def eval(self, script, numkeys, *args):
        self.calls.append((numkeys, *args))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


async def test_redis_rate_limiter_parses_and_falls_back():
    client = FakeEvalClient(["0", b"2.5", ConnectionError("down")])
    limiter = RedisRateLimiter(client, prefix="rl:")
    limit = RateLimit(1, 60)
    assert await limiter.hit("chat.message:U1", limit) == 0
    assert await limiter.hit("chat.message:U1", limit) == 2.5
    numkeys, key, count, rate, *_ = client.calls[0]
    assert numkeys == 1 and key == "rl:chat.message:U1" and count == 1 and float(rate) == pytest.approx(1 / 60)
    # Redis error -> in-memory fallback (first hit allowed, second limited).
    assert await limiter.hit("x", limit) == 0
    assert await limiter.hit("x", limit) > 0

    class Bridge:  # client not connected yet -> fallback
        client = None

    assert await RedisRateLimiter(Bridge()).hit("y", limit) == 0


# ------------------------------------------------------------ fake cluster


class FakeWS:
    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.frames.append(json.loads(text))


class Cluster:
    """Shared state of a fake multi-worker bridge."""

    def __init__(self) -> None:
        self.presence: dict[str, set[str]] = defaultdict(set)
        self.delivers: dict[str, Any] = {}
        self.room_delivers: dict[str, Any] = {}
        self.came: dict[str, float] = {}


class FakeBridge:
    heartbeat_seconds = 30

    def __init__(self, cluster: Cluster) -> None:
        self.c = cluster
        self._room = None

    def set_room_deliver(self, fn):
        self._room = fn

    async def start(self, deliver, server_id):
        self.c.delivers[server_id] = deliver
        if self._room:
            self.c.room_delivers[server_id] = self._room

    async def stop(self):
        pass

    async def set_online(self, user_id, server_id):
        self.c.presence[user_id].add(server_id)

    async def set_offline(self, user_id, server_id):
        self.c.presence[user_id].discard(server_id)

    async def set_away(self, user_id, away):
        pass

    async def get_user_servers(self, user_id):
        return list(self.c.presence[user_id])

    async def is_online(self, user_id):
        return bool(self.c.presence[user_id])

    async def get_online_users(self, user_ids):
        return {u for u in user_ids if self.c.presence[u]}

    async def publish(self, user_id, payload, origin):
        for deliver in self.c.delivers.values():
            await deliver(user_id, {"origin": origin, "data": payload})

    async def publish_room(self, room, payload, origin):
        for deliver in self.c.room_delivers.values():
            await deliver(room, {"origin": origin, "data": payload})

    async def claim_came_online(self, user_id, ttl):
        if self.c.came.get(user_id, 0) > time.monotonic():
            return False
        self.c.came[user_id] = time.monotonic() + ttl
        return True

    async def release_came_online(self, user_id):
        self.c.came.pop(user_id, None)


async def _workers(**kw) -> tuple[Cluster, ConnectionManager, ConnectionManager]:
    cluster = Cluster()
    w1 = ConnectionManager(bridge=FakeBridge(cluster), server_id="w1", **kw)
    w2 = ConnectionManager(bridge=FakeBridge(cluster), server_id="w2", **kw)
    await w1.start()
    await w2.start()
    return cluster, w1, w2


async def _settle() -> None:
    await asyncio.sleep(0.05)


async def test_rooms_local_and_across_workers():
    _, w1, w2 = await _workers()
    a, b, c = FakeWS(), FakeWS(), FakeWS()
    await w1.register("ADM1", a, role="admin")
    await w2.register("ADM2", b, role="admin")
    await w2.register("U3", c)
    assert w1.join_room("ADM1", "admins") and w2.join_room("ADM2", "admins")
    assert not w1.join_room("ADM2", "admins")  # no socket on this worker

    frame = {"event": "new_report", "data": {"id": 1}}  # host shapes are kept as given
    assert await w1.broadcast_room("admins", frame) == 1
    assert a.frames == [frame] and b.frames == [frame] and c.frames == []

    w2.leave_room("ADM2", "admins")
    await w2.broadcast_room("admins", {"type": "x"})
    assert a.frames[-1] == {"type": "x"} and b.frames == [frame]

    w1.disconnect("ADM1", a)  # leaving the worker leaves its rooms
    assert w1.room_members("admins") == set()


async def test_came_online_once_across_workers_and_cooldown():
    _, w1, w2 = await _workers()
    assert await w1.register("U1", FakeWS()) is True
    assert await w2.register("U1", FakeWS()) is False  # already online on w1
    assert await w1.register("U1", FakeWS()) is False  # second local socket
    assert await w1.register("ADM", FakeWS(), role="admin") is False

    for sockets, worker in ((list(w1.user_sockets["U1"]), w1), (list(w2.user_sockets["U1"]), w2)):
        for ws in sockets:
            worker.disconnect("U1", ws)
    await _settle()
    assert await w2.register("U1", FakeWS()) is True  # offline everywhere -> fires again

    _, c1, c2 = await _workers(came_online_cooldown=60)
    ws = FakeWS()
    assert await c1.register("U1", ws) is True
    c1.disconnect("U1", ws)
    await _settle()
    assert await c2.register("U1", FakeWS()) is False  # within the cooldown

    local = ConnectionManager(came_online_cooldown=60)
    ws = FakeWS()
    assert await local.register("U1", ws) is True
    local.disconnect("U1", ws)
    await _settle()
    assert await local.register("U1", FakeWS()) is False


async def test_redis_bridge_rooms_and_came_online_key():
    pytest.importorskip("redis")
    from commskit.core.redis_bridge import RedisBridge

    class FakeRedis:
        def __init__(self) -> None:
            self.store: dict[str, Any] = {}
            self.published: list[tuple[str, str]] = []

        async def set(self, key, value, nx=False, px=None, ex=None):
            if nx and key in self.store:
                return None
            self.store[key] = (value, px)
            return True

        async def delete(self, key):
            self.store.pop(key, None)

        async def publish(self, channel, data):
            self.published.append((channel, data))

    fake = FakeRedis()
    bridge = RedisBridge(client=fake)
    assert await bridge.claim_came_online("U1", 10) is True
    assert fake.store["came_online:U1"] == (1, 10000)
    assert await bridge.claim_came_online("U1", 10) is False
    await bridge.release_came_online("U1")
    assert await bridge.claim_came_online("U1", 0.5) is True

    await bridge.publish_room("ops:eu", {"event": "x"}, origin="w1")
    channel, data = fake.published[0]
    assert channel == "room_channel:ops:eu" and json.loads(data) == {"origin": "w1", "data": {"event": "x"}}

    got: list[tuple[str, str, dict]] = []

    async def deliver_user(uid, env):
        got.append(("user", uid, env))

    async def deliver_room(room, env):
        got.append(("room", room, env))

    class FakePubSub:
        async def listen(self):
            yield {"type": "pmessage", "channel": "room_channel:ops:eu", "data": json.dumps({"origin": "w9", "data": {"a": 1}})}
            yield {"type": "pmessage", "channel": "user_channel:U7", "data": json.dumps({"origin": "w9", "data": {"b": 2}})}

    bridge._pubsub = FakePubSub()
    bridge._deliver = deliver_user
    bridge.set_room_deliver(deliver_room)
    await bridge._consume()
    assert got == [("room", "ops:eu", {"origin": "w9", "data": {"a": 1}}),
                   ("user", "U7", {"origin": "w9", "data": {"b": 2}})]


# ------------------------------------------------------------ hub (TestClient)


def test_admin_role_skips_presence_hooks_and_flush(make_env):
    env = make_env(chat=True, call=False, hub_kwargs={"role_resolver": lambda uid: "admin" if uid == "ADM" else "user"})
    seen: dict[str, list[str]] = defaultdict(list)

    async def user_hook(user_id, ws):
        seen["user_hook"].append(user_id)

    async def any_hook(user_id, ws):
        seen["any_hook"].append(user_id)
        env.hub.join_room(user_id, f"role:{await env.hub.role_of(user_id)}")

    def recorder(name):
        async def listener(user_id):
            seen[name].append(user_id)
        return listener

    env.hub.on_connect(user_hook)
    env.hub.on_connect(any_hook, all_roles=True)
    for name in ("user.connected", "user.came_online", "user.disconnected"):
        env.hub.events.on(name, recorder(name))

    with env.ws("A") as a:
        send(a, "send_message", candidate_user_id="ADM", content="to the admin while offline")
        expect(a, "message_sent")
        with env.ws("ADM") as adm:
            sync(adm)
            send(adm, "user_status", status="online")
            sync(adm)
            assert env.client.portal.call(env.hub.broadcast_room, "role:admin", {"event": "hello"}) == 1
            assert recv(adm) == {"event": "hello"}  # frames are sent as given (no "type" needed)
        expect_none(a, "delivery_status")  # no delivery flush for an admin socket
        expect_none(a, "user_status")  # no presence for an admin socket
    assert "ADM" not in seen["user_hook"] and "ADM" in seen["any_hook"] and "A" in seen["user_hook"]
    assert "ADM" not in seen["user.connected"] and "ADM" not in seen["user.came_online"]
    assert seen["user.came_online"] == ["A"]


def test_came_online_event_dedupes_sockets(make_env):
    env = make_env(chat=True, call=False)
    events: list[str] = []

    async def came(user_id):
        events.append(user_id)

    env.hub.events.on("user.came_online", came)
    with env.ws("A") as a1, env.ws("A") as a2:
        sync(a1)
        sync(a2)
    assert events == ["A"]
    time.sleep(0.1)
    with env.ws("A") as a:
        sync(a)
    assert events == ["A", "A"]

    cooled = make_env(chat=False, call=False, hub_kwargs={"came_online_cooldown": 60})
    cooled_events: list[str] = []

    async def came2(user_id):
        cooled_events.append(user_id)

    cooled.hub.events.on("user.came_online", came2)
    for _ in range(2):
        with cooled.ws("B") as b:
            sync(b)
        time.sleep(0.1)
    assert cooled_events == ["B"]


def test_on_handler_error_hook(make_env):
    calls: list[tuple[str, Any, str]] = []

    async def hook(user_id, frame, exc):
        calls.append((user_id, frame, type(exc).__name__))
        raise RuntimeError("hook failures are swallowed")

    env = make_env(chat=True, call=False, hub_kwargs={"on_handler_error": hook})

    @env.hub.on("boom")
    async def boom(user_id, message, session):
        raise KeyError("kaput")

    from commskit.chat import ChatService

    original = ChatService.get_reply_previews

    async def broken(self, ids):
        raise RuntimeError("db down")

    with env.ws("A") as ws:
        ws.send_text("{oops")
        assert expect(ws, "error")["error"] == "Invalid JSON"
        ws.send_text("[]")
        expect(ws, "error")
        send(ws, "boom")
        assert expect(ws, "error")["error"].startswith("Message processing failed")
        ChatService.get_reply_previews = broken
        try:
            send(ws, "get_messages", candidate_user_id="B")
            assert expect(ws, "error")["error"].startswith("Failed to retrieve messages")
        finally:
            ChatService.get_reply_previews = original
    assert calls[0] == ("A", "{oops", "JSONDecodeError")
    assert calls[1] == ("A", [], "TypeError")
    assert calls[2][1]["type"] == "boom" and calls[2][2] == "KeyError"
    assert calls[3][1]["type"] == "get_messages" and calls[3][2] == "RuntimeError"


def test_join_room_requires_local_socket(make_env):
    env = make_env(chat=False, call=False)
    assert env.hub.join_room("nobody", "r") is False
    assert env.client.get("/chats/A/unread-count", headers=auth_headers("A")).status_code == 404
