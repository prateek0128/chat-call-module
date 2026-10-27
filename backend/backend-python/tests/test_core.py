"""Transport-level behaviour shared by every mode."""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import expect, recv, send


def test_invalid_token_closes_1008(make_env):
    env = make_env(chat=False, call=False)
    with env.client.websocket_connect("/ws/not-a-jwt") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 1008


def test_ping_bad_json_and_unknown_types(make_env):
    env = make_env(chat=False, call=False)
    with env.ws("A") as ws:
        send(ws, "ping")
        pong = recv(ws)
        assert pong["type"] == "PONG" and "timestamp" in pong

        ws.send_text("{not json")
        assert recv(ws) == {"type": "error", "error": "Invalid JSON"}
        ws.send_text("[1, 2]")
        assert recv(ws) == {"type": "error", "error": "Message must be a JSON object"}

        send(ws, "no_such_event")  # ignored, no reply
        send(ws, "ping")
        assert recv(ws)["type"] == "PONG"


def test_host_event_and_handler_crash(make_env):
    env = make_env(chat=False, call=False)

    @env.hub.on("report_and_block")
    async def report(user_id, message, session):
        await env.hub.send(user_id, {"type": "user_blocked", "candidate_user_id": message["candidate_user_id"]})

    @env.hub.on("boom")
    async def boom(user_id, message, session):
        raise RuntimeError("kaput")

    with env.ws("A") as ws:
        send(ws, "report_and_block", candidate_user_id="B")
        assert expect(ws, "user_blocked")["candidate_user_id"] == "B"
        send(ws, "boom")
        assert expect(ws, "error")["error"] == "Message processing failed: kaput"


def test_rest_requires_bearer(make_env):
    env = make_env(chat=True, call=True)
    assert env.client.post("/chats/start", params={"candidate_id": "B"}).status_code == 401
    assert env.client.post("/call/turn-credentials").status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert env.client.get("/chats/A/unread-count", headers=bad).status_code == 401
