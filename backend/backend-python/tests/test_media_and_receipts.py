"""Expo receipt polling (httpx.MockTransport), media tools, S3Storage with a fake boto3 client."""

from __future__ import annotations

import asyncio
import io
import json
import threading

import httpx
import pytest

from commskit.core.adapters import LocalDiskStorage, delete_media
from commskit.core.push import ExpoPushSender
from commskit.core.s3 import S3Storage, thumbnail_key


class Registry:
    def __init__(self) -> None:
        self.removed: list[tuple[str, str]] = []

    async def devices_for(self, user_id):
        return []

    async def remove_token(self, token, kind="expo"):
        self.removed.append((token, kind))
        return 1


def make_sender(handler, registry=None, **kw) -> ExpoPushSender:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ExpoPushSender(registry, client=client, **kw)


# ----------------------------------------------------------------- receipts


async def test_poll_receipts_removes_unregistered_tokens():
    registry = Registry()
    receipt_requests: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith("/send"):
            return httpx.Response(200, json={"data": [{"status": "ok", "id": f"t{i}"} for i, _ in enumerate(body)]})
        receipt_requests.append(body["ids"])
        return httpx.Response(200, json={"data": {
            "t0": {"status": "ok"},
            "t1": {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}},
            "t2": {"status": "error", "message": "big", "details": {"error": "MessageTooBig"}},
        }})

    sender = make_sender(handler, registry)
    messages = [sender.build_message(f"ExponentPushToken[{i}]", "t", "b", {}) for i in range(4)]
    await sender.send_messages(messages)
    assert sender.pending_tickets == {f"t{i}": f"ExponentPushToken[{i}]" for i in range(4)}

    summary = await sender.poll_receipts()
    assert summary == {"checked": 4, "ok": 1, "errors": 2, "unregistered": 1, "pending": 1}
    assert registry.removed == [("ExponentPushToken[1]", "expo")]
    assert list(sender.pending_tickets) == ["t3"]  # no receipt yet -> polled again later
    assert receipt_requests == [["t0", "t1", "t2", "t3"]]
    await sender.aclose()


async def test_poll_receipts_batches_of_1000_and_failures():
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = json.loads(request.content)["ids"]
        calls.append(len(ids))
        if len(calls) == 1:
            return httpx.Response(500, json={"errors": [{"message": "boom"}]})
        return httpx.Response(200, json={"data": {i: {"status": "ok"} for i in ids}})

    sender = make_sender(handler, Registry())
    for i in range(2500):
        sender._tickets[f"id{i}"] = (f"tok{i}", 0.0)
    sender.receipt_ttl = 10**9
    import time as _t
    for k in list(sender._tickets):
        sender._tickets[k] = (sender._tickets[k][0], _t.monotonic())
    summary = await sender.poll_receipts()
    assert calls == [1000, 1000, 500]
    assert summary["ok"] == 1500 and summary["pending"] == 1000  # first batch failed, stays pending
    assert await ExpoPushSender(Registry(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler))).poll_receipts() == {
        "checked": 0, "ok": 0, "errors": 0, "unregistered": 0, "pending": 0}
    with pytest.raises(ValueError):
        ExpoPushSender(receipt_batch_size=1001)


async def test_receipt_poller_loop_stops_cleanly():
    polled = asyncio.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        polled.set()
        return httpx.Response(200, json={"data": {"a": {"status": "ok"}}})

    sender = make_sender(handler, Registry())
    import time as _t
    sender._tickets["a"] = ("tok", _t.monotonic())
    task = sender.start_receipt_poller(interval=0.01)
    assert sender.start_receipt_poller(interval=0.01) is task  # idempotent
    await asyncio.wait_for(polled.wait(), 3)
    await sender.aclose()
    assert task.done() and sender._poller is None


# -------------------------------------------------------------- media tools


def test_image_thumbnail_and_missing_tools(monkeypatch):
    PIL = pytest.importorskip("PIL")
    from PIL import Image

    from commskit.core import media_tools

    buf = io.BytesIO()
    Image.new("RGBA", (800, 400), (255, 0, 0, 128)).save(buf, format="PNG")
    thumb = media_tools.make_image_thumbnail(buf.getvalue())
    assert thumb is not None
    out = Image.open(io.BytesIO(thumb))
    assert out.format == "JPEG" and out.size == (300, 150)
    assert media_tools.make_image_thumbnail(b"not an image") is None

    monkeypatch.setattr(media_tools, "_tool", lambda name: None)
    assert media_tools.probe_duration(b"x", ".mp3") is None
    assert media_tools.make_video_thumbnail(b"x") is None


def test_probe_duration_parses_ffprobe(monkeypatch):
    from commskit.core import media_tools

    monkeypatch.setattr(media_tools, "_tool", lambda name: "/fake/ffprobe")

    class Done:
        stdout = "12.6\n"

    monkeypatch.setattr(media_tools.subprocess, "run", lambda *a, **k: Done())
    assert media_tools.probe_duration(b"data", ".mp4") == 13


# ------------------------------------------------------------------- storage


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict] = {}
        self.deleted: list[str] = []
        self.threads: set[int] = set()

    def put_object(self, **kw):
        self.threads.add(threading.get_ident())
        self.objects[kw["Key"]] = kw

    def delete_object(self, **kw):
        self.deleted.append(kw["Key"])
        self.objects.pop(kw["Key"], None)

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"https://bkt.s3.amazonaws.com/{Params['Key']}?X-Amz-Expires={ExpiresIn}"


def png_bytes() -> bytes:
    pytest.importorskip("PIL")
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (0, 128, 255)).save(buf, format="PNG")
    return buf.getvalue()


async def test_s3_storage_upload_layout_thumbnail_delete():
    fake = FakeS3()
    storage = S3Storage("bkt", region="ap-south-1", client=fake)
    info = await storage.upload(7, "My Pic (1).png", png_bytes(), "image")
    keys = sorted(fake.objects)
    main = next(k for k in keys if not k.endswith("_thumb.jpg"))
    parts = main.split("/")
    assert parts[:3] == ["chat", "7", "image"]
    ts, uid, name = parts[3].split("_", 2)
    assert ts.isdigit() and len(uid) == 8 and name == "My_Pic_1_.png"
    assert thumbnail_key(main) in fake.objects and fake.objects[thumbnail_key(main)]["ContentType"] == "image/jpeg"
    assert info.file_url == f"https://bkt.s3.ap-south-1.amazonaws.com/{main}"
    assert info.thumbnail_url.endswith("_thumb.jpg") and info.file_type == "image/png"
    assert info.file_name == "My Pic (1).png" and info.file_size > 0
    assert threading.get_ident() not in fake.threads  # ran off the event loop

    assert storage.key_for(info.file_url) == main
    assert storage.key_for("https://elsewhere.example/chat/1/x") is None
    await storage.delete(info.file_url)
    assert fake.deleted == [main, thumbnail_key(main)] and not fake.objects
    await storage.delete("https://elsewhere.example/chat/1/x")  # ignored
    assert len(fake.deleted) == 2


async def test_s3_storage_private_presigned_and_prefix(monkeypatch):
    from commskit.core import s3

    monkeypatch.setattr(s3, "probe_duration", lambda data, suffix="": 42)
    fake = FakeS3()
    storage = S3Storage("bkt", client=fake, private=True, prefix="env1", presign_expires=600, thumbnails=False)
    info = await storage.upload(3, "v.m4a", b"audio", "voice")
    assert info.file_url.startswith("https://bkt.s3.amazonaws.com/env1/chat/3/voice/") and "Expires=600" in info.file_url
    assert info.thumbnail_url is None and info.duration == 42
    assert storage.key_for(info.file_url).startswith("env1/chat/3/voice/")
    assert storage.presign(info.file_url, 60).endswith("Expires=60")
    with pytest.raises(ValueError):
        S3Storage("bkt", presign_expires=8 * 24 * 3600)


async def test_delete_media_helper(tmp_path):
    storage = LocalDiskStorage(str(tmp_path), base_url="/media")
    info = await storage.upload(1, "a.txt", b"x", "document")
    path = storage.path_for(info.file_url)
    assert await delete_media(storage, info.file_url, info.file_url, None) == 1
    assert not __import__("os").path.exists(path)
    await storage.delete(info.file_url)  # already gone: no error
    assert storage.path_for("/media/../secret") is None and storage.path_for("/other/x") is None

    class NoDelete:  # custom storage without delete(): skipped
        pass

    assert await delete_media(NoDelete(), "x") == 0
