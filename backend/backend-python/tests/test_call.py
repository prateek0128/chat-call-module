"""Call-only app (no chat feature): chat_id null, no call_log."""

from __future__ import annotations

import base64
import hashlib
import hmac

from commskit.call import CallConfig, CallDecision

from conftest import auth_headers, expect, expect_none, send, sync

OFFER = {"type": "offer", "sdp": "v=0 offer"}
ANSWER = {"type": "answer", "sdp": "v=0 answer"}
BASE_KEYS = {"type", "call_id", "chat_id", "caller_id", "receiver_id", "call_type", "webrtc_session_id", "timestamp"}


def call_env(make_env, **kw):
    return make_env(chat=False, call=True, **kw)


def start_call(a, b, call_type="audio"):
    send(a, "call_initiate", receiver_id="B", call_type=call_type)
    initiated = expect(a, "call_initiated")
    incoming = expect(b, "incoming_call")
    ringing = expect(a, "call_ringing")
    return initiated, incoming, ringing


def test_call_only_app_has_no_chat(make_env):
    env = call_env(make_env)
    assert env.hub.handles("call_initiate") and not env.hub.handles("send_message")
    assert env.client.post("/chats/start", params={"candidate_id": "B"}, headers=auth_headers("A")).status_code == 404


def test_happy_path(make_env):
    env = call_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        initiated, incoming, ringing = start_call(a, b)
        call_id = initiated["call_id"]

        assert BASE_KEYS <= set(initiated)
        assert initiated["status"] == "calling" and initiated["chat_id"] is None
        # Legacy caller view: the peer sits in caller_id / caller_name.
        assert initiated["caller_id"] == "B" and initiated["caller_name"] == "B"
        assert initiated["receiver_id"] == "B" and initiated["webrtc_session_id"] == call_id
        assert initiated["call_type"] == "audio"

        assert incoming["call_id"] == call_id and incoming["caller_id"] == "A" and incoming["receiver_id"] == "B"
        assert incoming["caller_name"] == "Alice" and incoming["caller_avatar"] == "https://img/a.png"
        assert ringing["status"] == "ringing" and ringing["caller_id"] == "B"

        send(a, "sdp_offer", call_id=call_id, sdp=OFFER)
        offer = expect(b, "sdp_offer")
        assert offer["from_user_id"] == "A" and offer["sdp"] == OFFER and offer["call_id"] == call_id

        send(b, "ice_candidate", call_id=call_id, candidate={"candidate": "c-b"})
        assert expect(a, "ice_candidate")["candidate"] == {"candidate": "c-b"}
        send(a, "ice_candidate", call_id=call_id, candidate={"candidate": "c-a"})
        assert expect(b, "ice_candidate")["from_user_id"] == "A"

        send(b, "sdp_answer", call_id=call_id, sdp=ANSWER)
        assert expect(a, "sdp_answer")["sdp"] == ANSWER
        send(b, "answer_call", call_id=call_id)
        answered = expect(a, "call_answered")
        assert answered["status"] == "answered" and answered["answerer_id"] == "B"
        assert expect(b, "call_answered")["call_id"] == call_id  # stops other devices ringing

        send(b, "answer_call", call_id=call_id)  # duplicate: ignored
        send(a, "start_recording", call_id=call_id)  # accepted, ignored

        send(a, "end_call", call_id=call_id)
        ended_b = expect(b, "call_ended")
        ended_a = expect(a, "call_ended")
        for ended in (ended_a, ended_b):
            assert ended["status"] == "call_ended" and ended["end_reason"] == "hangup"
            assert ended["ended_by"] == "A" and ended["caller_name"] == "A"
            assert isinstance(ended["duration_seconds"], int) and ended["duration_seconds"] >= 0
            assert ended["chat_id"] is None
        expect_none(a, "call_log")

        # Signalling on a finished call is refused with a call-tagged error.
        send(a, "sdp_offer", call_id=call_id, sdp=OFFER)
        err = expect(a, "error")
        assert err["context"] == "call" and err["error"] == "No active call found."

    # Both were connected: no pushes.
    assert env.push.sent == []


def test_reject(make_env):
    env = call_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        initiated, _, _ = start_call(a, b)
        send(b, "reject_call", call_id=initiated["call_id"])
        for ws in (a, b):
            rejected = expect(ws, "call_rejected")
            assert rejected["status"] == "call_rejected" and rejected["end_reason"] == "declined"
            assert rejected["rejector_id"] == "B" and rejected["caller_name"] == "A"
            assert rejected["duration_seconds"] == 0 and rejected["call_id"] == initiated["call_id"]


def test_caller_cancel_pushes_missed_to_offline_receiver(make_env):
    env = call_env(make_env)
    with env.ws("A") as a:
        send(a, "call_initiate", receiver_id="B")
        initiated = expect(a, "call_initiated")
        expect_none(a, "call_ringing")  # nobody got incoming_call
        incoming_push = env.push.wait_for(lambda p: p["data"]["type"] == "incoming_call")
        assert incoming_push["user_id"] == "B" and incoming_push["channel"] == "call_ringtone"
        assert incoming_push["ttl"] == 45 and incoming_push["title"] == "Alice"
        assert incoming_push["data"] == {
            "type": "incoming_call", "call_id": initiated["call_id"], "chat_id": None, "caller_id": "A",
            "caller_name": "Alice", "caller_avatar": "https://img/a.png", "call_type": "audio",
        }

        send(a, "end_call", call_id=initiated["call_id"])
        ended = expect(a, "call_ended")
        assert ended["end_reason"] == "caller_cancelled"
        missed = env.push.wait_for(lambda p: p["data"]["type"] == "missed_call")
        assert missed["channel"] == "messages" and missed["data"]["call_id"] == initiated["call_id"]


def test_busy_and_already_in_call(make_env):
    env = call_env(make_env)
    with env.ws("A") as a, env.ws("B") as b, env.ws("C") as c:
        initiated, _, _ = start_call(a, b)

        send(c, "call_initiate", receiver_id="B", call_type="video")
        busy = expect(c, "call_rejected")
        assert busy["call_id"] is None and busy["status"] == "busy" and busy["reason"] == "busy"
        assert busy["caller_id"] == "C" and busy["receiver_id"] == "B" and busy["call_type"] == "video"

        send(a, "call_initiate", receiver_id="C")
        err = expect(a, "error")
        assert err == {"type": "error", "error": "You are already in a call.", "context": "call"}

        send(a, "call_initiate", receiver_id="A")
        assert expect(a, "error")["error"] == "You cannot call yourself."
        send(b, "answer_call", call_id="nope")
        assert expect(b, "error") == {"type": "error", "error": "Call not found", "call_id": "nope", "context": "call"}
        assert initiated["call_id"]


def test_ring_timeout(make_env):
    env = call_env(make_env, call_config=CallConfig(ring_timeout=0.4))
    with env.ws("A") as a, env.ws("B") as b:
        initiated, _, _ = start_call(a, b)
        for ws in (a, b):
            missed = expect(ws, "call_missed", timeout=3)
            assert missed["status"] == "missed" and missed["end_reason"] == "no_answer"
            assert missed["call_id"] == initiated["call_id"]

        # Answering after the timeout just stops the ringing.
        send(b, "answer_call", call_id=initiated["call_id"])
        late = expect(b, "call_ended")
        assert late["end_reason"] == "missed"
    assert not [p for p in env.push.sent if p["data"]["type"] == "missed_call"]  # B was online


def test_policy_deny(make_env):
    class Credits:
        async def authorize(self, session, caller_id, receiver_id, message):
            if message.get("credit_acknowledged"):
                return CallDecision.allow()
            return CallDecision.deny(
                "This would be a paid feature.", status=403, message="1 Credit = 1 Profile",
                info={"credit_balance": 3, "need_credits": True, "credits_needed": 1, "access_type": "call"},
            )

    env = call_env(make_env, call_policy=Credits())
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B")
        err = expect(a, "error")
        assert err == {
            "type": "error", "error": "This would be a paid feature.", "status": 403,
            "message": "1 Credit = 1 Profile", "context": "call",
            "info": {"credit_balance": 3, "need_credits": True, "credits_needed": 1, "access_type": "call"},
        }
        expect_none(b, "incoming_call")

        send(a, "call_initiate", receiver_id="B", credit_acknowledged=True)
        expect(a, "call_initiated")
        expect(b, "incoming_call")


def test_rest_reject_and_rering_with_stored_offer(make_env):
    env = call_env(make_env)
    with env.ws("A") as a:
        send(a, "call_initiate", receiver_id="B")
        call_id = expect(a, "call_initiated")["call_id"]
        send(a, "sdp_offer", call_id=call_id, sdp=OFFER)  # stored for a late receiver
        sync(a)

        with env.ws("B") as b:
            again = expect(b, "incoming_call")
            assert again["call_id"] == call_id and again["sdp"] == OFFER and again["caller_name"] == "Alice"

        assert env.client.post("/call/nope/reject", headers=auth_headers("B")).status_code == 404
        assert env.client.post(f"/call/{call_id}/reject", headers=auth_headers("C")).status_code == 404
        resp = env.client.post(f"/call/{call_id}/reject", headers=auth_headers("B"))
        assert resp.status_code == 200 and resp.json() == {"status": True}
        rejected = expect(a, "call_rejected")
        assert rejected["rejector_id"] == "B" and rejected["end_reason"] == "declined"


def test_disconnect_grace_ends_call(make_env):
    env = call_env(make_env, call_config=CallConfig(ringing_disconnect_grace=0.2, answered_disconnect_grace=0.4))
    with env.ws("A") as a:
        with env.ws("B") as b:
            initiated, _, _ = start_call(a, b)
            send(b, "answer_call", call_id=initiated["call_id"])
            expect(a, "call_answered")
        ended = expect(a, "call_ended", timeout=3)
        assert ended["end_reason"] == "disconnected" and ended["ended_by"] == "B"


def test_turn_credentials(make_env):
    env = call_env(make_env, call_config=CallConfig(turn_secret="turn-test-secret", turn_uris=["turn:example.org:3478"]))
    body = env.client.post("/call/turn-credentials", headers=auth_headers("A")).json()
    assert body["ttl"] == 3600 and body["uris"] == ["turn:example.org:3478"]
    expected = base64.b64encode(hmac.new(b"turn-test-secret", body["username"].encode(), hashlib.sha1).digest()).decode()
    assert body["password"] == expected

    unconfigured = call_env(make_env)
    assert unconfigured.client.post("/call/turn-credentials", headers=auth_headers("A")).status_code == 503
