"""Regenerate test/golden/call/*.json from the PYTHON backend (the wire-protocol reference for calls).

Runs a scripted chat+call exchange against commskit (FastAPI TestClient, SQLite in a temp dir; no network
port is bound), records the frames and normalises ids / timestamps / uuids / durations.
backend-node/test/call-golden.test.ts runs the same script against the Node server and requires identical output.

    python backend/backend-node/test/golden/generate_call_golden.py
Writes only into backend/backend-node/test/golden/call/. Reads (never modifies) comms-kit/backend/backend-python.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import anyio
import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import commskit.call  # noqa: F401  (registers tables)
import commskit.chat  # noqa: F401
from commskit.call import CallConfig, CallFeature
from commskit.chat import ChatFeature
from commskit.core import CommsBase, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, UserProfile
from commskit.integration import link_chat_and_call

OUT = Path(__file__).resolve().parent / "call"
OUT.mkdir(exist_ok=True)
SECRET = "test-only-secret-signed-by-the-tests-0001"
PROFILES = {
    "A": UserProfile(name="Alice", avatar="https://img/a.png"),
    "B": UserProfile(name="Bob", avatar="https://img/b.png"),
    "C": UserProfile(name="Carol", avatar=None),
}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CLOCK = re.compile(r"· \d+:\d\d(:\d\d)?$")
ID_KEYS = {"id", "chat_id", "message_id", "message_ids"}
OFFER = {"type": "offer", "sdp": "v=0 offer"}
ANSWER = {"type": "answer", "sdp": "v=0 answer"}


def normalise(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: normalise(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise(v, key) for v in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and key in ID_KEYS:
        return "<id>"
    if isinstance(value, int) and key == "duration_seconds":
        return "<dur>"
    if isinstance(value, str):
        if ISO.match(value):
            return "<ts>"
        if UUID.match(value):
            return "<uuid>"
        return CLOCK.sub("· <clock>", value)
    return value


def tok(uid: str) -> str:
    return jwt.encode({"uid": uid}, SECRET, algorithm="HS256")


class Recorder:
    def __init__(self) -> None:
        self.push: list[dict] = []

    async def send(self, user_id, title, body, data, channel="default", ttl=None) -> None:
        self.push.append({"user_id": user_id, "title": title, "body": body, "data": dict(data), "channel": channel, "ttl": ttl})


def recv(ws, timeout: float = 5.0) -> dict:
    async def _receive():
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()

    message = ws.portal.call(_receive)
    ws._raise_on_close(message)
    return json.loads(message["text"])


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="commskit-call-golden-"))
    db = tmp / "g.db"
    sync = create_engine(f"sqlite:///{db}")
    CommsBase.metadata.create_all(sync)
    sync.dispose()
    engine = create_async_engine(f"sqlite+aiosqlite:///{db}", connect_args={"timeout": 30})
    push = Recorder()
    hub = CommsHub(auth=JwtAuth(SECRET), session_factory=async_sessionmaker(engine), users=StaticUserDirectory(PROFILES), push=push)
    chat = ChatFeature(storage=LocalDiskStorage(str(tmp / "media"))).install(hub)
    call = CallFeature(config=CallConfig(ring_timeout=1.0, initiate_rate=None)).install(hub)
    link_chat_and_call(chat, call)
    app = FastAPI()
    app.include_router(hub.ws_router())
    app.include_router(hub.rest_router())
    golden: dict[str, Any] = {}

    with TestClient(app) as client:
        def expect(ws, type_, name=None, **match):
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                frame = recv(ws, max(0.1, deadline - time.monotonic()))
                if frame.get("type") == type_ and all(frame.get(k) == v for k, v in match.items()):
                    if name:
                        golden[name] = normalise(frame)
                    return frame
            raise AssertionError(type_)

        def send(ws, type_, **payload):
            ws.send_json({"type": type_, **payload})

        def sync_ws(ws):
            send(ws, "ping")
            expect(ws, "PONG")

        def wait_push(pred, name):
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                for item in push.push:
                    if pred(item):
                        golden[name] = normalise(item)
                        return item
                time.sleep(0.02)
            raise AssertionError(name)

        a = client.websocket_connect(f"/ws/{tok('A')}").__enter__()
        b = client.websocket_connect(f"/ws/{tok('B')}").__enter__()
        c = client.websocket_connect(f"/ws/{tok('C')}").__enter__()
        for ws in (a, b, c):
            sync_ws(ws)

        print("step 1", flush=True)  # happy path: audio call, signalling relay, answer, hangup by caller
        send(a, "call_initiate", receiver_id="B", call_type="audio", chat_id=999)
        init = expect(a, "call_initiated", "happy_call_initiated")
        expect(b, "incoming_call", "happy_incoming_call")
        expect(a, "call_ringing", "happy_call_ringing")
        cid = init["call_id"]
        send(a, "sdp_offer", call_id=cid, sdp=OFFER)
        expect(b, "sdp_offer", "happy_sdp_offer")
        send(b, "ice_candidate", call_id=cid, candidate={"candidate": "c-b"})
        expect(a, "ice_candidate", "happy_ice_candidate")
        send(b, "sdp_answer", call_id=cid, sdp=ANSWER)
        expect(a, "sdp_answer", "happy_sdp_answer")
        send(b, "answer_call", call_id=cid)
        expect(a, "call_answered", "happy_call_answered_caller")
        expect(b, "call_answered", "happy_call_answered_answerer")
        send(a, "end_call", call_id=cid)
        expect(b, "call_ended", "happy_call_ended_receiver")
        expect(a, "call_ended", "happy_call_ended_caller")
        expect(a, "call_log", "happy_call_log")
        expect(b, "call_log")
        send(a, "sdp_offer", call_id=cid, sdp=OFFER)
        expect(a, "error", "error_no_active_call")

        print("step 2", flush=True)  # video call declined
        send(a, "call_initiate", receiver_id="B", call_type="video")
        cid = expect(a, "call_initiated", "video_call_initiated")["call_id"]
        expect(b, "incoming_call", "video_incoming_call")
        send(b, "reject_call", call_id=cid)
        expect(a, "call_rejected", "reject_call_rejected")
        expect(b, "call_rejected")
        expect(a, "call_log", "reject_call_log")
        expect(b, "call_log")

        print("step 3", flush=True)  # caller cancels while ringing
        send(a, "call_initiate", receiver_id="B")
        cid = expect(a, "call_initiated")["call_id"]
        expect(b, "incoming_call")
        send(a, "end_call", call_id=cid)
        expect(a, "call_ended", "cancel_call_ended")
        expect(a, "call_log", "cancel_call_log")
        expect(b, "call_log")

        print("step 4", flush=True)  # busy + already in a call + validation errors
        send(a, "call_initiate", receiver_id="B")
        cid = expect(a, "call_initiated")["call_id"]
        expect(b, "incoming_call")
        send(c, "call_initiate", receiver_id="B", call_type="video")
        expect(c, "call_rejected", "busy_call_rejected")
        send(a, "call_initiate", receiver_id="C")
        expect(a, "error", "error_already_in_call")
        send(a, "end_call", call_id=cid)
        expect(a, "call_log")
        expect(b, "call_log")
        send(a, "call_initiate", receiver_id="A")
        expect(a, "error", "error_self_call")
        send(a, "call_initiate")
        expect(a, "error", "error_missing_receiver")
        send(b, "answer_call", call_id="nope")
        expect(b, "error", "error_call_not_found")
        send(b, "answer_call")
        expect(b, "error", "error_missing_call_id")
        send(a, "sdp_offer", call_id="x")
        expect(a, "error", "error_missing_sdp")

        print("step 5", flush=True)  # ring timeout (1 s)
        send(a, "call_initiate", receiver_id="B")
        expect(a, "call_initiated")
        expect(b, "incoming_call")
        expect(a, "call_missed", "timeout_call_missed_caller")
        expect(b, "call_missed", "timeout_call_missed_receiver")
        expect(a, "call_log", "timeout_call_log")
        expect(b, "call_log")

        print("step 6", flush=True)  # answering after a timeout / cancel
        send(a, "call_initiate", receiver_id="B")
        cid = expect(a, "call_initiated")["call_id"]
        expect(b, "incoming_call")
        send(a, "end_call", call_id=cid)
        expect(a, "call_log")
        expect(b, "call_log")
        send(b, "answer_call", call_id=cid)
        expect(b, "call_ended", "late_answer_call_ended")
        send(b, "end_call", call_id=cid)
        expect(b, "call_ended", "late_end_call_ended")

        print("step 7", flush=True)  # receiver offline: incoming push, re-ring with stored offer on reconnect, REST decline
        b.__exit__(None, None, None)
        time.sleep(0.3)
        send(a, "call_initiate", receiver_id="B")
        cid = expect(a, "call_initiated", "offline_call_initiated")["call_id"]
        wait_push(lambda p: p["data"].get("type") == "incoming_call", "push_incoming_call")
        send(a, "sdp_offer", call_id=cid, sdp=OFFER)
        sync_ws(a)
        b = client.websocket_connect(f"/ws/{tok('B')}").__enter__()
        expect(b, "incoming_call", "rering_incoming_call")
        auth = {"Authorization": f"Bearer {tok('B')}"}
        resp = client.post(f"/call/{cid}/reject", headers=auth)
        golden["rest_reject"] = {"status": resp.status_code, "body": resp.json()}
        expect(a, "call_rejected", "rest_reject_call_rejected")
        expect(a, "call_log")
        miss = client.post("/call/nope/reject", headers=auth)
        golden["rest_reject_404"] = {"status": miss.status_code, "body": miss.json()}
        turn = client.post("/call/turn-credentials", headers=auth)
        golden["rest_turn_503"] = {"status": turn.status_code, "body": turn.json()}

        print("step 8", flush=True)  # offline receiver + caller cancels -> missed-call push
        b.__exit__(None, None, None)
        time.sleep(0.3)
        send(a, "call_initiate", receiver_id="B")
        cid = expect(a, "call_initiated")["call_id"]
        send(a, "end_call", call_id=cid)
        expect(a, "call_ended")
        wait_push(lambda p: p["data"].get("type") == "missed_call", "push_missed_call")
        b = client.websocket_connect(f"/ws/{tok('B')}").__enter__()
        sync_ws(b)

        print("step 9", flush=True)  # the chat now holds the call entries
        send(b, "get_messages", candidate_user_id="A", limit=50)
        golden["res_messages_calls"] = normalise(expect(b, "res_messages"))
        send(a, "req_users")
        golden["res_users_calls"] = normalise(expect(a, "res_users"))

        for ws in (a, b, c):
            ws.__exit__(None, None, None)
        client.portal.call(hub.shutdown)

    for name, frame in golden.items():
        (OUT / f"{name}.json").write_text(json.dumps(frame, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(golden)} fixtures to {OUT}")


if __name__ == "__main__":
    import os, traceback
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stderr.flush()
        os._exit(1)
