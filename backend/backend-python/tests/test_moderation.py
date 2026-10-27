"""Moderation (PROTOCOL.md section 7): block / unblock / report over WS and REST, and its
effect on chat and call through commskit.integration.link_moderation."""

from __future__ import annotations

import base64
import time

import pytest

from commskit.call import CallDecision
from commskit.moderation import ModerationCallPolicy, ModerationChatPolicy, ReportInfo

from conftest import auth_headers, expect, expect_none, send, sync

BLOCKED_CHAT = "Cannot send message. User is blocked."
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 32).decode()


def block(a, b, blocker="A", target="B"):
    send(a, "block", candidate_user_id=target)
    frame = expect(a, "user_blocked")
    assert frame["candidate_user_id"] == target and frame["message"]
    by = expect(b, "blocked_by_user")
    assert by["candidate_user_id"] == blocker and by["message"]


# --------------------------------------------------------------- chat side


def test_block_stops_chat_both_ways_and_unblock_restores(make_env):
    env = make_env(chat=True, call=False, moderation=True)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "send_message", candidate_user_id="B", content="before")
        chat_id = expect(a, "message_sent")["message"]["chat_id"]
        expect(b, "new_message")

        block(a, b)

        for sender, ws, target in (("A", a, "B"), ("B", b, "A")):
            send(ws, "send_message", candidate_user_id=target, content="hi")
            assert expect(ws, "error")["error"] == BLOCKED_CHAT
            send(ws, "media_upload", target_user_id=target, file_name="x.png", file_data=PNG)
            assert expect(ws, "error")["error"] == BLOCKED_CHAT
        send(b, "typing", target_user_id="A", is_typing=True)
        sync(b)
        expect_none(a, "typing_status")
        expect_none(a, "new_message", wait=0.1)

        # Flags in res_users / res_messages.info for both viewers.
        send(a, "req_users")
        user = expect(a, "res_users")["users"][0]
        assert (user["is_blocked"], user["blocked_by_other"]) == (True, False)
        send(b, "get_messages", chat_id=chat_id)
        info = expect(b, "res_messages")["info"]
        assert (info["is_blocked"], info["blocked_by_other"]) == (False, True)

        send(a, "unblock", candidate_user_id="B")
        assert expect(a, "user_unblocked")["candidate_user_id"] == "B"
        assert expect(b, "unblocked_by_user")["candidate_user_id"] == "A"
        send(b, "send_message", candidate_user_id="A", content="back")
        assert expect(a, "new_message")["message"]["content"] == "back"
        send(b, "typing", target_user_id="A", is_typing=True)
        assert expect(a, "typing_status")["is_typing"] is True
        send(a, "req_users")
        user = expect(a, "res_users")["users"][0]
        assert (user["is_blocked"], user["blocked_by_other"]) == (False, False)


def test_report_and_block_hook_and_events(make_env):
    reports: list[ReportInfo] = []

    async def on_report(report: ReportInfo) -> None:
        reports.append(report)

    env = make_env(chat=True, call=False, moderation=True, moderation_kwargs={"on_report": on_report})
    seen: list[ReportInfo] = []

    async def listener(info):
        seen.append(info)

    env.hub.events.on("moderation.reported", listener)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "report_and_block", candidate_user_id="B", reason="rude", category="Harassment", message_id=7)
        blocked = expect(a, "user_blocked")
        received = expect(a, "report_received")
        assert blocked["candidate_user_id"] == "B"
        assert received["candidate_user_id"] == "B" and isinstance(received["report_id"], int)
        expect(b, "blocked_by_user")
        deadline = time.monotonic() + 3
        while not reports and time.monotonic() < deadline:
            time.sleep(0.02)
        [report] = reports
        assert (report.id, report.reporter_id, report.reported_id, report.reason, report.category,
                report.message_id, report.status, report.blocked) == (
            received["report_id"], "A", "B", "rude", "harassment", 7, "open", True)
        assert seen == [report]

        # block: false -> report only, chat still works.
        send(a, "report_and_block", candidate_user_id="C", block=False)
        assert expect(a, "report_received")["candidate_user_id"] == "C"
        send(a, "send_message", candidate_user_id="C", content="still fine")
        expect(a, "message_sent")


def test_ws_errors_have_moderation_context(make_env):
    env = make_env(chat=True, call=False, moderation=True)
    with env.ws("A") as a:
        for type_, payload in (("block", {}), ("unblock", {"candidate_user_id": ""}),
                               ("report_and_block", {"candidate_user_id": "A"}),
                               ("report_and_block", {"candidate_user_id": "B", "message_id": "abc"})):
            send(a, type_, **payload)
            err = expect(a, "error")
            assert err["context"] == "moderation" and err["error"]


def test_notify_blocked_user_false(make_env):
    env = make_env(chat=True, call=False, moderation=True, moderation_kwargs={"notify_blocked_user": False})
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "block", candidate_user_id="B")
        expect(a, "user_blocked")
        send(a, "unblock", candidate_user_id="B")
        expect(a, "user_unblocked")
        sync(b)
        expect_none(b, "blocked_by_user", wait=0.2)
        expect_none(b, "unblocked_by_user", wait=0.2)


# ------------------------------------------------------------------- REST


def test_rest_blocks_and_reports(make_env):
    env = make_env(chat=True, call=True, moderation=True)
    c = env.client
    h = auth_headers("A")
    assert c.get("/moderation/blocks").status_code == 401
    with env.ws("A") as a, env.ws("B") as b:
        assert c.post("/moderation/blocks", json={"user_id": "B"}, headers=h).json() == {"status": True}
        expect(a, "user_blocked")  # REST keeps the sockets in sync
        expect(b, "blocked_by_user")
        c.post("/moderation/blocks", json={"user_id": "C"}, headers=h)
        listed = c.get("/moderation/blocks", headers=h).json()
        assert {x["user_id"] for x in listed} == {"B", "C"}
        bob = next(x for x in listed if x["user_id"] == "B")
        assert bob["username"] == "Bob" and bob["avatar"] == "https://img/b.png" and bob["blocked_at"]

        assert c.delete("/moderation/blocks/B", headers=h).json() == {"status": True}
        expect(b, "unblocked_by_user")
        assert [x["user_id"] for x in c.get("/moderation/blocks", headers=h).json()] == ["C"]

        assert c.post("/moderation/blocks", json={"user_id": "A"}, headers=h).status_code == 422
        assert c.post("/moderation/blocks", json={}, headers=h).status_code == 422
        assert c.post("/moderation/reports", json={"user_id": "B"}, headers=h).status_code == 422

        r = c.post("/moderation/reports", json={"user_id": "B", "reason": "spam!", "category": "spam"}, headers=h)
        assert r.status_code == 200 and isinstance(r.json()["report_id"], int)
        assert expect(a, "report_received")["report_id"] == r.json()["report_id"]
        assert "B" not in [x["user_id"] for x in c.get("/moderation/blocks", headers=h).json()]  # block defaults off
        r = c.post("/moderation/reports", json={"user_id": "B", "reason": "x", "block": True}, headers=h)
        assert r.status_code == 200
        assert "B" in [x["user_id"] for x in c.get("/moderation/blocks", headers=h).json()]


# -------------------------------------------------------------- call side


def start_answered_call(a, b):
    send(a, "call_initiate", receiver_id="B")
    call_id = expect(a, "call_initiated")["call_id"]
    expect(b, "incoming_call")
    send(b, "answer_call", call_id=call_id)
    expect(a, "call_answered")
    return call_id


@pytest.mark.parametrize("chat", [False, True])
def test_blocked_pair_cannot_call_and_unblock_restores(make_env, chat):
    env = make_env(chat=chat, call=True, moderation=True)
    with env.ws("A") as a, env.ws("B") as b:
        block(a, b)
        for ws, target in ((a, "B"), (b, "A")):
            send(ws, "call_initiate", receiver_id=target)
            err = expect(ws, "error")
            assert err["context"] == "call" and err["error"] == "Cannot call. User is blocked."
        send(a, "unblock", candidate_user_id="B")
        expect(a, "user_unblocked")
        send(b, "call_initiate", receiver_id="A")
        expect(b, "call_initiated")
        expect(a, "incoming_call")


@pytest.mark.parametrize("chat", [False, True])
def test_block_ends_active_call(make_env, chat):
    env = make_env(chat=chat, call=True, moderation=True)
    with env.ws("A") as a, env.ws("B") as b:
        call_id = start_answered_call(a, b)
        send(b, "block", candidate_user_id="A")
        for ws in (a, b):
            ended = expect(ws, "call_ended", call_id=call_id)
            assert ended["end_reason"] == "blocked" and ended["ended_by"] == "B" and ended["status"] == "call_ended"
        if chat:
            assert expect(a, "call_log", call_id=call_id)["status"] == "ended"
        # The call is over: a new call is refused by policy, not "busy".
        send(a, "call_initiate", receiver_id="B")
        assert expect(a, "error")["context"] == "call"


def test_block_ends_ringing_call(make_env):
    env = make_env(chat=False, call=True, moderation=True)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B")
        call_id = expect(a, "call_initiated")["call_id"]
        expect(b, "incoming_call")
        send(b, "report_and_block", candidate_user_id="A", reason="spam call")
        assert expect(a, "call_ended", call_id=call_id)["end_reason"] == "blocked"
        assert expect(b, "call_ended", call_id=call_id)["end_reason"] == "blocked"
        expect(b, "report_received")


def test_unlinked_moderation_does_not_touch_features(make_env):
    env = make_env(chat=True, call=True, moderation=True, link_moderation=False)
    with env.ws("A") as a, env.ws("B") as b:
        block(a, b)
        send(a, "send_message", candidate_user_id="B", content="host policy decides")
        expect(a, "message_sent")


def test_moderation_alone(make_env):
    env = make_env(chat=False, call=False, moderation=True)
    with env.ws("A") as a, env.ws("B") as b:
        block(a, b)
    assert env.client.get("/moderation/blocks", headers=auth_headers("A")).json()[0]["user_id"] == "B"


# ------------------------------------------------------- policy composition


class HostChatPolicy:
    refusal_message = "Consent required."

    async def can_message(self, session, sender, recipient):
        return recipient != "C"

    async def block_status(self, session, viewer, others):
        return {o: (False, True) for o in others if o == "C"}  # legacy host block table

    async def extra_conversation_info(self, session, viewer, other):
        return {"chat_consent_given": other != "C"}


class CountingCallPolicy:
    def __init__(self):
        self.calls = 0

    async def authorize(self, session, caller, receiver, message):
        self.calls += 1
        if receiver == "C":
            return CallDecision.deny("No credits", status=402, info={"credit_balance": 0})
        return CallDecision.allow()


def test_wraps_host_policies(make_env):
    call_policy = CountingCallPolicy()
    env = make_env(chat=True, call=True, moderation=True, chat_policy=HostChatPolicy(), call_policy=call_policy)
    assert isinstance(env.chat.policy, ModerationChatPolicy) and isinstance(env.chat.policy.inner, HostChatPolicy)
    assert isinstance(env.call.policy, ModerationCallPolicy) and env.call.policy.inner is call_policy
    with env.ws("A") as a, env.ws("B") as b:
        # Host refusal message passes through for host refusals.
        send(a, "send_message", candidate_user_id="C", content="hi")
        assert expect(a, "error")["error"] == "Consent required."
        send(a, "get_messages", candidate_user_id="C")
        info = expect(a, "res_messages")["info"]
        assert info["chat_consent_given"] is False and info["blocked_by_other"] is True

        # Host call policy errors pass through untouched.
        send(a, "call_initiate", receiver_id="C")
        err = expect(a, "error")
        assert err["status"] == 402 and err["info"] == {"credit_balance": 0} and err["context"] == "call"
        assert call_policy.calls == 1

        block(a, b)
        send(a, "send_message", candidate_user_id="B", content="hi")
        assert expect(a, "error")["error"] == BLOCKED_CHAT
        send(a, "call_initiate", receiver_id="B")
        assert expect(a, "error")["error"] == "Cannot call. User is blocked."
        assert call_policy.calls == 1  # blocked pair never reaches (= is never charged by) the host policy


def test_link_twice_and_prewrapped(make_env):
    from commskit.integration import link_moderation

    env = make_env(chat=True, call=True, moderation=True)
    with pytest.raises(RuntimeError):
        link_moderation(env.moderation, chat=env.chat, call=env.call)
    wrapped = env.chat.policy
    assert not isinstance(wrapped.inner, ModerationChatPolicy)
