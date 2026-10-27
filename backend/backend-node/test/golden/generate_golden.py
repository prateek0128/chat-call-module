"""Regenerate test/golden/*.json from the PYTHON backend (the wire-protocol reference).

Runs a scripted chat exchange against commskit (FastAPI TestClient, SQLite in a temp dir), records the
frames and normalises ids / timestamps / random file names. backend/backend-node/test/golden.test.ts runs the same
script against the Node server and requires identical output.

    python backend/backend-node/test/golden/generate_golden.py
Writes only into backend/backend-node/test/golden/. Reads (never modifies) comms-kit/backend/backend-python.
"""

from __future__ import annotations

import base64
import json
import re
import sys
import tempfile
import time
from pathlib import Path

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import commskit.chat  # noqa: F401  (registers tables)
from commskit.chat import ChatFeature
from commskit.core import CommsBase, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, UserProfile

OUT = Path(__file__).resolve().parent
SECRET = "test-only-secret-signed-by-the-tests-0001"
PROFILES = {"A": UserProfile(name="Alice", avatar="https://img/a.png"), "B": UserProfile(name="Bob", avatar="https://img/b.png")}
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$")
ID_KEYS = {"id", "chat_id", "message_id", "message_ids", "user1_id_num"}


def normalise(value, key=""):
    if isinstance(value, dict):
        return {k: normalise(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise(v, key) for v in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and key in ID_KEYS:
        return "<id>"
    if isinstance(value, str):
        if ISO.match(value):
            return "<ts>"
        return re.sub(r"/media/chat/\d+/(\w+)/[0-9a-f]{12}_", r"/media/chat/<id>/\1/<rand>_", value)
    return value


def tok(uid: str) -> str:
    return jwt.encode({"uid": uid}, SECRET, algorithm="HS256")


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="commskit-golden-"))
    db = tmp / "g.db"
    sync = create_engine(f"sqlite:///{db}")
    CommsBase.metadata.create_all(sync)
    sync.dispose()
    engine = create_async_engine(f"sqlite+aiosqlite:///{db}", connect_args={"timeout": 30})
    hub = CommsHub(auth=JwtAuth(SECRET), session_factory=async_sessionmaker(engine), users=StaticUserDirectory(PROFILES))
    ChatFeature(storage=LocalDiskStorage(str(tmp / "media"))).install(hub)
    app = FastAPI()
    app.include_router(hub.ws_router())
    app.include_router(hub.rest_router())
    golden: dict = {}

    with TestClient(app) as client:
        def expect(ws, type_, name=None, **match):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                frame = json.loads(ws.receive_text())
                if frame.get("type") == type_ and all(frame.get(k) == v for k, v in match.items()):
                    if name:
                        golden[name] = normalise(frame)
                    return frame
            raise AssertionError(type_)

        def sync_ws(ws):
            ws.send_json({"type": "ping"})
            expect(ws, "PONG")

        with client.websocket_connect(f"/ws/{tok('A')}") as a, client.websocket_connect(f"/ws/{tok('B')}") as b:
            sync_ws(a), sync_ws(b)
            a.send_json({"type": "send_message", "candidate_user_id": "B", "content": "hello Bob"})
            first = expect(b, "new_message", "new_message")["message"]
            expect(a, "message_sent", "message_sent")

            b.send_json({"type": "send_message", "candidate_user_id": "A", "content": "hi Alice", "reply_to_id": first["id"]})
            expect(a, "new_message", "new_message_reply")
            expect(b, "message_sent", "message_sent_reply")

            a.send_json({"type": "media_upload", "target_user_id": "B", "file_name": "photo.png",
                         "file_data": base64.b64encode(PNG).decode()})
            media = expect(a, "media_upload_success", "media_upload_success")["message"]
            expect(b, "new_message", "new_message_media")
            expect(a, "message_sent", "message_sent_media")

            a.send_json({"type": "typing", "target_user_id": "B", "is_typing": True})
            expect(b, "typing_status", "typing_status")

            b.send_json({"type": "mark_read", "candidate_user_id": "A"})
            expect(b, "chat_read", "chat_read")
            expect(a, "messages_read", "messages_read")

            b.send_json({"type": "req_users"})
            expect(b, "res_users", "res_users")
            b.send_json({"type": "get_messages", "candidate_user_id": "A", "limit": 10})
            expect(b, "res_messages", "res_messages")

            b.send_json({"type": "user_status", "status": "away"})
            expect(a, "user_status", "user_status", user_id="B", status="away")

            a.send_json({"type": "delete_message", "message_id": media["id"], "for_everyone": True})
            expect(b, "message_deleted", "message_deleted")
            a.send_json({"type": "get_messages", "candidate_user_id": "B", "limit": 10})
            expect(a, "res_messages", "res_messages_after_unsend")

        # b is offline now: a message, then b reconnects -> delivery_status to a
        with client.websocket_connect(f"/ws/{tok('A')}") as a:
            sync_ws(a)
            a.send_json({"type": "send_message", "candidate_user_id": "B", "content": "while you were away"})
            expect(a, "message_sent", "message_sent_offline")
            with client.websocket_connect(f"/ws/{tok('B')}") as b:
                expect(a, "delivery_status", "delivery_status")
                sync_ws(b)

        auth = {"Authorization": f"Bearer {tok('A')}"}
        golden["rest_start"] = normalise(client.post("/chats/start", params={"candidate_id": "B"}, headers=auth).json())
        golden["rest_list"] = normalise(client.get("/chats/A", headers=auth).json())
        golden["rest_messages"] = normalise(client.get(f"/chats/{media['chat_id']}/messages", params={"limit": 2}, headers=auth).json())
        golden["rest_unread"] = client.get("/chats/A/unread-count", headers=auth).json()
        golden["rest_online"] = client.get("/chats/B/online-status", headers=auth).json()
        bad = client.get("/chats/B", headers=auth)
        golden["rest_forbidden"] = {"status": bad.status_code, "body": bad.json()}
        miss = client.post("/chats/start", headers=auth)
        golden["rest_422_status"] = miss.status_code

    for name, frame in golden.items():
        (OUT / f"{name}.json").write_text(json.dumps(frame, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(golden)} fixtures to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
