"""Regenerate test/golden/moderation/*.json from the PYTHON backend (the wire-protocol reference).

Same approach as generate_golden.py: scripted block / report / unblock exchange against commskit (FastAPI TestClient,
SQLite in a temp dir), frames normalised. backend/backend-node/test/moderation-golden.test.ts runs the same script against the
Node server and requires identical output.

    python backend/backend-node/test/golden/generate_moderation_golden.py
Writes only into backend/backend-node/test/golden/moderation/. Reads (never modifies) comms-kit/backend/backend-python.
"""

from __future__ import annotations

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
import commskit.moderation  # noqa: F401
from commskit.chat import ChatFeature
from commskit.core import CommsBase, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, UserProfile
from commskit.moderation import ModerationFeature

OUT = Path(__file__).resolve().parent / "moderation"
SECRET = "test-only-secret-signed-by-the-tests-0001"
PROFILES = {"A": UserProfile(name="Alice", avatar="https://img/a.png"), "B": UserProfile(name="Bob", avatar="https://img/b.png")}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$")
ID_KEYS = {"id", "report_id"}


def normalise(value, key=""):
    if isinstance(value, dict):
        return {k: normalise(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise(v, key) for v in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and key in ID_KEYS:
        return "<id>"
    if isinstance(value, str) and ISO.match(value):
        return "<ts>"
    return value


def tok(uid: str) -> str:
    return jwt.encode({"uid": uid}, SECRET, algorithm="HS256")


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="commskit-mod-golden-"))
    db = tmp / "g.db"
    sync = create_engine(f"sqlite:///{db}")
    CommsBase.metadata.create_all(sync)
    sync.dispose()
    engine = create_async_engine(f"sqlite+aiosqlite:///{db}", connect_args={"timeout": 30})
    hub = CommsHub(auth=JwtAuth(SECRET), session_factory=async_sessionmaker(engine), users=StaticUserDirectory(PROFILES))
    ChatFeature(storage=LocalDiskStorage(str(tmp / "media"))).install(hub)
    ModerationFeature().install(hub)
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
            a.send_json({"type": "block", "candidate_user_id": "B"})
            expect(a, "user_blocked", "user_blocked")
            expect(b, "blocked_by_user", "blocked_by_user")
            a.send_json({"type": "unblock", "candidate_user_id": "B"})
            expect(a, "user_unblocked", "user_unblocked")
            expect(b, "unblocked_by_user", "unblocked_by_user")
            a.send_json({"type": "report_and_block", "candidate_user_id": "B", "reason": "rude",
                         "category": "Harassment", "message_id": 7})
            expect(a, "user_blocked")
            expect(a, "report_received", "report_received")
            a.send_json({"type": "block", "candidate_user_id": "A"})
            expect(a, "error", "error_self_block")
            a.send_json({"type": "report_and_block", "candidate_user_id": "B", "message_id": "abc"})
            expect(a, "error", "error_bad_message_id")

        auth = {"Authorization": f"Bearer {tok('A')}"}
        golden["rest_blocks"] = normalise(client.get("/moderation/blocks", headers=auth).json())
        golden["rest_block_status"] = client.post("/moderation/blocks", json={"user_id": "B"}, headers=auth).json()
        bad = client.post("/moderation/blocks", json={"user_id": "A"}, headers=auth)
        golden["rest_block_self"] = {"status": bad.status_code, "body": bad.json()}
        no_reason = client.post("/moderation/reports", json={"user_id": "B"}, headers=auth)
        golden["rest_report_no_reason"] = {"status": no_reason.status_code, "body": no_reason.json()}
        rep = client.post("/moderation/reports", json={"user_id": "B", "reason": "x"}, headers=auth)
        golden["rest_report"] = normalise(rep.json())

    OUT.mkdir(exist_ok=True)
    for name, frame in golden.items():
        (OUT / f"{name}.json").write_text(json.dumps(frame, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(golden)} fixtures to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
