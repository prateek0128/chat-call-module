"""Push senders with httpx.MockTransport (no network): Expo, APNs VoIP, DevicePushRouter."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx
import pytest

from commskit.call import callkit_uuid as call_callkit_uuid
from commskit.core import callkit_uuid
from commskit.core.devices import DeviceInfo
from commskit.core.push import ApnsVoipSender, DevicePushRouter, ExpoPushSender

from conftest import auth_headers, expect, send

crypto = pytest.importorskip("cryptography")


# ------------------------------------------------------------------ fixtures


@dataclass
class FakeStore:
    devices: dict[str, list[DeviceInfo]] = field(default_factory=dict)
    removed: list[tuple[str, str]] = field(default_factory=list)

    async def devices_for(self, user_id: str) -> list[DeviceInfo]:
        return list(self.devices.get(user_id, []))

    async def remove_token(self, token: str, kind: str = "expo") -> int:
        self.removed.append((token, kind))
        return 1


@dataclass
class Recorder:
    """MockTransport handler recording requests; ``respond(request)`` builds the reply."""

    respond: Callable[[httpx.Request], httpx.Response]
    requests: list[httpx.Request] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        return self.respond(request)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))

    def bodies(self) -> list[Any]:
        return [json.loads(r.content) for r in self.requests]


def expo_ok(request: httpx.Request) -> httpx.Response:
    batch = json.loads(request.content)
    return httpx.Response(200, json={"data": [{"status": "ok", "id": f"t{i}"} for i in range(len(batch))]})


def apns_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, headers={"apns-id": "x"})


@pytest.fixture(scope="module")
def ec_key() -> tuple[str, Any]:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return pem, private.public_key()


def make_apns(ec_key, recorder: Recorder, store: FakeStore | None = None, **kw: Any) -> ApnsVoipSender:
    return ApnsVoipSender(key=ec_key[0], key_id="KEY123ABCD", team_id="TEAM123456", bundle_id="com.example.app",
                          registry=store, client=recorder.client(), **kw)


INCOMING = {"type": "incoming_call", "call_id": "call-123", "chat_id": None, "caller_id": "A",
            "caller_name": "Alice", "caller_avatar": None, "call_type": "audio"}
CHAT = {"type": "chat", "cid": "messaging:A", "chat_id": 1, "sender_id": "A"}


# ------------------------------------------------------------------ callkit


def test_callkit_uuid_vector():
    # Shared with the mobile kit: UUIDv5(NAMESPACE_URL, "commskit:call:<call_id>").
    assert callkit_uuid("call-123") == "e394bb1f-a663-5750-8664-4de655ce4bf3"
    assert callkit_uuid("3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c") == "653579da-f398-55b8-9545-46885f1e073e"
    assert call_callkit_uuid is callkit_uuid


# --------------------------------------------------------------------- Expo


async def test_expo_batches_of_100_and_access_token():
    rec = Recorder(expo_ok)
    sender = ExpoPushSender(access_token="expo-secret", client=rec.client())
    messages = [sender.build_message(f"ExponentPushToken[{i}]", "t", "b", {"i": i}) for i in range(250)]
    tickets = await sender.send_messages(messages)
    assert [len(b) for b in rec.bodies()] == [100, 100, 50]
    assert len(tickets) == 250 and all(t["status"] == "ok" for t in tickets)
    req = rec.requests[0]
    assert str(req.url) == "https://exp.host/--/api/v2/push/send"
    assert req.headers["authorization"] == "Bearer expo-secret"
    assert rec.bodies()[2][-1]["to"] == "ExponentPushToken[249]"

    rec2 = Recorder(expo_ok)
    await ExpoPushSender(client=rec2.client()).send_messages(messages[:1])
    assert "authorization" not in rec2.requests[0].headers


async def test_expo_device_not_registered_removes_token():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "1"},
            {"status": "error", "message": "not registered", "details": {"error": "DeviceNotRegistered"}},
            {"status": "error", "message": "too big", "details": {"error": "MessageTooBig"}},
        ]})

    store = FakeStore({"U": [DeviceInfo("U", f"d{i}", "android", f"ExponentPushToken[{i}]") for i in range(3)]})
    rec = Recorder(respond)
    sender = ExpoPushSender(store, client=rec.client())
    await sender.send("U", "Title", "Body", {"k": 1}, channel="messages", ttl=30)
    assert store.removed == [("ExponentPushToken[1]", "expo")]
    msg = rec.bodies()[0][0]
    assert msg == {"to": "ExponentPushToken[0]", "data": {"k": 1}, "priority": "high", "title": "Title",
                   "body": "Body", "sound": "default", "channelId": "messages", "ttl": 30}


async def test_expo_http_error_does_not_raise():
    rec = Recorder(lambda r: httpx.Response(500, json={"errors": [{"code": "INTERNAL"}]}))
    tickets = await ExpoPushSender(client=rec.client()).send_messages([{"to": "x", "data": {}}])
    assert tickets[0]["status"] == "error"


def test_expo_data_only_message_shape():
    msg = ExpoPushSender().build_message("tok", "T", "B", {"a": 1}, channel="call_ringtone", ttl=45, data_only=True)
    assert "title" not in msg and "body" not in msg and "sound" not in msg
    assert msg["priority"] == "high" and msg["ttl"] == 45 and msg["data"] == {"a": 1}


# --------------------------------------------------------------------- APNs


async def test_apns_headers_jwt_and_expiry(ec_key):
    import jwt

    rec = Recorder(apns_ok)
    sender = make_apns(ec_key, rec)
    before = int(time.time())
    assert await sender.send_voip("abc123", {"type": "incoming_call", "uuid": "u"}) is True
    req = rec.requests[0]
    assert str(req.url) == "https://api.push.apple.com/3/device/abc123"
    assert req.headers["apns-push-type"] == "voip"
    assert req.headers["apns-topic"] == "com.example.app.voip"
    assert req.headers["apns-priority"] == "10"
    assert before + 45 <= int(req.headers["apns-expiration"]) <= int(time.time()) + 45
    assert json.loads(req.content) == {"type": "incoming_call", "uuid": "u"}

    scheme, token = req.headers["authorization"].split(" ", 1)
    assert scheme == "bearer"
    assert jwt.get_unverified_header(token) == {"alg": "ES256", "kid": "KEY123ABCD", "typ": "JWT"}
    claims = jwt.decode(token, ec_key[1], algorithms=["ES256"])
    assert claims["iss"] == "TEAM123456" and before - 1 <= claims["iat"] <= int(time.time())

    # Reused while fresh, re-signed once older than token_refresh (< 60 min).
    await sender.send_voip("abc123", {})
    assert rec.requests[1].headers["authorization"] == req.headers["authorization"]
    sender._jwt_issued_at -= sender.token_refresh + 1
    await sender.send_voip("abc123", {})
    assert rec.requests[2].headers["authorization"] != req.headers["authorization"]


async def test_apns_sandbox_host_and_topic(ec_key):
    rec = Recorder(apns_ok)
    sender = make_apns(ec_key, rec, use_sandbox=True)
    await sender.send_voip("tok", {})
    assert str(rec.requests[0].url) == "https://api.sandbox.push.apple.com/3/device/tok"
    with pytest.raises(ValueError):
        make_apns(ec_key, rec, token_refresh=3600)


@pytest.mark.parametrize(
    ("status", "reason", "removed"),
    [(410, "Unregistered", True), (400, "BadDeviceToken", True), (400, "PayloadTooLarge", False),
     (429, "TooManyRequests", False)],
)
async def test_apns_invalid_token_cleanup(ec_key, status, reason, removed):
    store = FakeStore()
    rec = Recorder(lambda r: httpx.Response(status, json={"reason": reason}))
    assert await make_apns(ec_key, rec, store).send_voip("dead", {}) is False
    assert store.removed == ([("dead", "voip")] if removed else [])


async def test_apns_expired_provider_token_is_resigned_once(ec_key):
    replies = iter([httpx.Response(403, json={"reason": "ExpiredProviderToken"}), httpx.Response(200)])
    rec = Recorder(lambda r: next(replies))
    assert await make_apns(ec_key, rec).send_voip("tok", {}) is True
    assert len(rec.requests) == 2


def test_apns_missing_crypto_gives_clear_error(ec_key, monkeypatch):
    monkeypatch.setitem(sys.modules, "cryptography", None)
    with pytest.raises(RuntimeError, match=r"commskit\[apns\]"):
        ApnsVoipSender(key=ec_key[0], key_id="K", team_id="T", bundle_id="b")


def test_apns_from_env(ec_key, monkeypatch, tmp_path):
    for name in ("APNS_KEY", "APNS_KEY_PATH", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_USE_SANDBOX"):
        monkeypatch.delenv(name, raising=False)
    assert ApnsVoipSender.from_env() is None
    key_file = tmp_path / "AuthKey.p8"
    key_file.write_text(ec_key[0])
    monkeypatch.setenv("APNS_KEY_PATH", str(key_file))
    monkeypatch.setenv("APNS_KEY_ID", "K")
    monkeypatch.setenv("APNS_TEAM_ID", "T")
    monkeypatch.setenv("APNS_BUNDLE_ID", "com.example.app")
    monkeypatch.setenv("APNS_USE_SANDBOX", "true")
    sender = ApnsVoipSender.from_env()
    assert sender is not None and sender.host.startswith("https://api.sandbox") and sender.topic == "com.example.app.voip"


# ------------------------------------------------------------------- router


def router_setup(ec_key, devices, style="notification", voip=True, apns_respond=apns_ok):
    store = FakeStore({"B": devices})
    expo_rec, apns_rec = Recorder(expo_ok), Recorder(apns_respond)
    router = DevicePushRouter(
        store, expo=ExpoPushSender(client=expo_rec.client()),
        voip=make_apns(ec_key, apns_rec) if voip else None, android_call_style=style,
    )
    return router, store, expo_rec, apns_rec


IOS_VOIP = DeviceInfo("B", "ios1", "ios", "ExponentPushToken[ios]", "voiptoken1")
IOS_PLAIN = DeviceInfo("B", "ios2", "ios", "ExponentPushToken[ios2]", None)
ANDROID = DeviceInfo("B", "and1", "android", "ExponentPushToken[and]", None)


async def test_router_ios_incoming_call_goes_voip(ec_key):
    router, _, expo_rec, apns_rec = router_setup(ec_key, [IOS_VOIP])
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert expo_rec.requests == []
    [req] = apns_rec.requests
    assert str(req.url).endswith("/3/device/voiptoken1")
    assert json.loads(req.content) == {**INCOMING, "uuid": callkit_uuid("call-123")}


async def test_router_ios_without_voip_token_falls_back_to_expo(ec_key):
    router, _, expo_rec, apns_rec = router_setup(ec_key, [IOS_PLAIN])
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert apns_rec.requests == []
    [[msg]] = expo_rec.bodies()
    assert msg["to"] == "ExponentPushToken[ios2]" and msg["title"] == "Alice"
    assert msg["priority"] == "high" and msg["channelId"] == "call_ringtone" and msg["ttl"] == 45
    assert "uuid" not in msg["data"]

    # VoIP token but no APNs sender configured: also Expo.
    router, _, expo_rec, _ = router_setup(ec_key, [IOS_VOIP], voip=False)
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert expo_rec.bodies()[0][0]["to"] == "ExponentPushToken[ios]"


async def test_router_voip_failure_removes_token_and_falls_back(ec_key):
    router, store, expo_rec, _ = router_setup(
        ec_key, [IOS_VOIP], apns_respond=lambda r: httpx.Response(410, json={"reason": "Unregistered"}))
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert store.removed == [("voiptoken1", "voip")]
    assert expo_rec.bodies()[0][0]["to"] == "ExponentPushToken[ios]"


@pytest.mark.parametrize("style", ["data", "notification"])
async def test_router_android_call_style(ec_key, style):
    router, _, expo_rec, apns_rec = router_setup(ec_key, [ANDROID], style=style)
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert apns_rec.requests == []
    [[msg]] = expo_rec.bodies()
    assert msg["priority"] == "high" and msg["ttl"] == 45 and msg["data"] == INCOMING
    if style == "data":
        assert "title" not in msg and "body" not in msg
    else:
        assert msg["title"] == "Alice" and msg["body"] == "Incoming audio call" and msg["channelId"] == "call_ringtone"


async def test_router_chat_and_missed_call_go_to_expo_for_everyone(ec_key):
    router, _, expo_rec, apns_rec = router_setup(ec_key, [IOS_VOIP, IOS_PLAIN, ANDROID], style="data")
    await router.send("B", "Alice", "hi", CHAT, channel="messages")
    await router.send("B", "Alice", "Missed audio call",
                      {"type": "missed_call", "call_id": "c", "chat_id": None, "caller_id": "A", "call_type": "audio"},
                      channel="messages")
    assert apns_rec.requests == []
    for batch in expo_rec.bodies():
        assert len(batch) == 3 and all(m["title"] == "Alice" and m["channelId"] == "messages" for m in batch)


async def test_router_mixed_devices_and_no_devices(ec_key):
    router, _, expo_rec, apns_rec = router_setup(ec_key, [IOS_VOIP, ANDROID], style="data")
    await router.send("B", "Alice", "Incoming audio call", INCOMING, channel="call_ringtone", ttl=45)
    assert len(apns_rec.requests) == 1
    [[msg]] = expo_rec.bodies()
    assert msg["to"] == "ExponentPushToken[and]" and "title" not in msg

    await router.send("nobody", "x", "y", CHAT)
    assert len(expo_rec.requests) == 1 and len(apns_rec.requests) == 1


def test_router_end_to_end_incoming_call_push(make_env, ec_key):
    """Call-only app: the offline receiver's iOS device gets a VoIP push for the call."""
    from commskit.core.devices import SqlDeviceRegistry

    apns_rec, expo_rec = Recorder(apns_ok), Recorder(expo_ok)
    holder: dict[str, Any] = {}

    class LazyRouter:
        async def send(self, *args: Any, **kw: Any) -> None:
            await holder["router"].send(*args, **kw)

    env = make_env(chat=False, call=True, devices=True, push=LazyRouter())
    registry: SqlDeviceRegistry = env.devices.registry
    holder["router"] = DevicePushRouter(registry, expo=ExpoPushSender(client=expo_rec.client()),
                                        voip=make_apns(ec_key, apns_rec))
    env.client.post("/devices", json={"device_id": "b-phone", "platform": "ios", "voip_token": "bvoip",
                                      "expo_push_token": "ExponentPushToken[b]"}, headers=auth_headers("B"))
    with env.ws("A") as a:
        send(a, "call_initiate", receiver_id="B")
        call_id = expect(a, "call_initiated")["call_id"]
        deadline = time.monotonic() + 3
        while not apns_rec.requests and time.monotonic() < deadline:
            time.sleep(0.02)
        [req] = apns_rec.requests
        body = json.loads(req.content)
        assert body["type"] == "incoming_call" and body["call_id"] == call_id
        assert body["uuid"] == callkit_uuid(call_id) and body["caller_name"] == "Alice"
        assert expo_rec.requests == []
