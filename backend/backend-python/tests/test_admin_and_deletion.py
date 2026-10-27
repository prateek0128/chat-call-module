"""Admin report review (moderation), delete_user_everywhere, and the call_initiate rate limit."""

from __future__ import annotations

import base64
import os
import time

from fastapi import Header, HTTPException

from conftest import auth_headers, expect, send, sync

from commskit.call import CallConfig
from commskit.core import RateLimit

PNG = base64.b64encode(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)).decode()


async def admin_only(x_admin: str | None = Header(None)) -> str:
    if x_admin != "secret":
        raise HTTPException(status_code=403, detail="admins only")
    return "mod-1"


ADMIN = {"X-Admin": "secret"}


def test_admin_routes_not_mounted_without_dependency(make_env):
    env = make_env(chat=True, call=False, moderation=True)
    assert env.client.get("/moderation/admin/reports", headers=ADMIN).status_code == 404


def test_admin_report_review_with_chat_context(make_env):
    env = make_env(chat=True, call=False, moderation=True, moderation_kwargs={"admin_dependency": admin_only})
    resolved = []

    async def on_resolved(report):
        resolved.append(report)

    env.hub.events.on("moderation.report_resolved", on_resolved)
    with env.ws("A") as a, env.ws("B") as b:
        ids = []
        for i in range(6):
            sender, receiver, to = (a, b, "B") if i % 2 == 0 else (b, a, "A")
            send(sender, "send_message", candidate_user_id=to, content=f"m{i}")
            ids.append(expect(sender, "message_sent")["message"]["id"])
            expect(receiver, "new_message")
        send(a, "report_and_block", candidate_user_id="B", reason="rude", category="harassment",
             message_id=ids[3], block=False)
        report_id = expect(a, "report_received")["report_id"]
        send(b, "report_and_block", candidate_user_id="A", reason="spam", block=False)
        other_id = expect(b, "report_received")["report_id"]

    assert env.client.get("/moderation/admin/reports").status_code == 403
    listed = env.client.get("/moderation/admin/reports", params={"status": "open"}, headers=ADMIN).json()
    assert [r["report_id"] for r in listed] == [other_id, report_id]
    first = listed[1]
    assert first == {**first, "reporter_id": "A", "reported_id": "B", "reason": "rude", "category": "harassment",
                     "message_id": ids[3], "status": "open", "resolved_at": None, "resolved_by": None, "note": None}
    assert env.client.get("/moderation/admin/reports", params={"status": "bogus"}, headers=ADMIN).status_code == 422

    ctx = env.client.get(f"/moderation/admin/reports/{report_id}/context", params={"before": 1, "after": 1},
                         headers=ADMIN).json()
    assert ctx["report"]["report_id"] == report_id
    assert [m["id"] for m in ctx["messages"]] == [ids[4], ids[3], ids[2]]  # newest first, around the message
    assert ctx["messages"][1]["sender_type"] == "other"  # relative to the reporter (A); B sent m3

    latest = env.client.get(f"/moderation/admin/reports/{other_id}/context", params={"before": 1, "after": 0},
                            headers=ADMIN).json()
    assert [m["id"] for m in latest["messages"]] == [ids[5], ids[4]]  # no message_id -> latest

    resp = env.client.post(f"/moderation/admin/reports/{report_id}", json={"status": "resolved", "note": "warned"},
                           headers=ADMIN)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "resolved" and body["resolved_by"] == "mod-1" and body["note"] == "warned"
    assert body["resolved_at"] and resolved and resolved[0]["report_id"] == report_id
    assert env.client.post(f"/moderation/admin/reports/{report_id}", json={"status": "nope"},
                           headers=ADMIN).status_code == 422
    assert env.client.post("/moderation/admin/reports/9999", json={"status": "dismissed"},
                           headers=ADMIN).status_code == 404
    assert env.client.get("/moderation/admin/reports/9999/context", headers=ADMIN).status_code == 404
    assert [r["report_id"] for r in env.client.get(
        "/moderation/admin/reports", params={"status": "resolved"}, headers=ADMIN).json()] == [report_id]


def test_admin_context_without_chat_is_empty(make_env):
    env = make_env(chat=False, call=True, moderation=True, moderation_kwargs={"admin_dependency": admin_only})
    with env.ws("A") as a:
        send(a, "report_and_block", candidate_user_id="B", reason="x")
        report_id = expect(a, "report_received")["report_id"]
    ctx = env.client.get(f"/moderation/admin/reports/{report_id}/context", headers=ADMIN).json()
    assert ctx["messages"] == [] and ctx["report"]["report_id"] == report_id


def test_delete_user_everywhere(make_env):
    from commskit.integration import delete_user_everywhere

    env = make_env(chat=True, call=True, moderation=True, devices=True)
    deleted = []

    async def on_deleted(user_id):
        deleted.append(user_id)

    env.hub.events.on("user.deleted", on_deleted)
    assert env.client.post("/devices", json={"device_id": "d-b", "platform": "android", "expo_push_token": "ExpoTok[b]"},
                           headers=auth_headers("B")).status_code == 200
    with env.ws("A") as a, env.ws("B") as b, env.ws("C") as c:
        send(b, "media_upload", target_user_id="A", file_name="p.png", file_data=PNG)
        media = expect(b, "media_upload_success")["message"]
        send(c, "send_message", candidate_user_id="A", content="unrelated")
        expect(c, "message_sent")
        send(b, "call_initiate", receiver_id="A")
        call_id = expect(b, "call_initiated")["call_id"]
        send(b, "end_call", call_id=call_id)
        expect(b, "call_log")
        send(b, "report_and_block", candidate_user_id="C", reason="spam")  # B blocks + reports C
        expect(b, "report_received")
        send(c, "report_and_block", candidate_user_id="B", reason="fake", block=False)  # C reports B
        expect(c, "report_received")
        sync(a)
    path = env.chat.storage.path_for(media["file_url"])
    assert os.path.exists(path)

    results = env.client.portal.call(delete_user_everywhere, env.hub, "B")
    assert list(results) == ["chat", "call", "moderation", "devices"]
    assert results["chat"]["chats"] == 1 and results["chat"]["messages"] >= 2 and results["chat"]["media"] == 1
    assert results["call"] == {"calls": 1}
    assert results["moderation"] == {"blocks": 1, "reports_anonymized": 2}
    assert results["devices"] == {"devices": 1}
    assert deleted == ["B"] and not os.path.exists(path)

    with env.ws("A") as a:
        send(a, "req_users")
        assert [u["user_id"] for u in expect(a, "res_users")["users"]] == ["C"]  # A <-> C untouched

    async def reports():
        from commskit.moderation import ModerationService

        async with env.hub.session_factory() as session:
            return await ModerationService(session).list_reports()

    rows = env.client.portal.call(reports)
    assert {(r["reporter_id"], r["reported_id"]) for r in rows} == {(None, "C"), ("C", None)}


def test_call_initiate_rate_limit(make_env):
    env = make_env(chat=False, call=True, call_config=CallConfig(initiate_rate=RateLimit(1, 60)))
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B")
        call_id = expect(a, "call_initiated")["call_id"]
        send(a, "end_call", call_id=call_id)
        expect(a, "call_ended")
        send(a, "call_initiate", receiver_id="B")
        err = expect(a, "error")
        assert err["context"] == "call" and err["code"] == "rate_limited" and err["retry_after"] >= 1
