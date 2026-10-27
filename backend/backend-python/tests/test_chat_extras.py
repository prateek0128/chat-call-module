"""PROTOCOL.md section 9: limits, delete / unsend / clear, read by peer, system + REST send, user deletion."""

from __future__ import annotations

import base64
import os
import time
from datetime import datetime

from sqlalchemy import update

from conftest import PROFILES, auth_headers, expect, expect_none, send, sync

from commskit.chat import ChatConfig, ChatActionError
from commskit.chat.models import Message
from commskit.core import RateLimit

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def chat_env(make_env, **kw):
    return make_env(chat=True, call=False, **kw)


def run(env, fn):
    """Run an async no-arg function on the app's event loop."""
    return env.client.portal.call(fn)


def send_text(sender_ws, receiver_ws, to: str, text: str) -> dict:
    send(sender_ws, "send_message", candidate_user_id=to, content=text)
    msg = expect(sender_ws, "message_sent")["message"]
    if receiver_ws is not None:
        expect(receiver_ws, "new_message")
    return msg


# ------------------------------------------------------------------- limits


def test_message_rate_limit_ws_and_rest(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(message_rate=RateLimit(3, 60)))
    with env.ws("A") as a:
        for i in range(3):
            send_text(a, None, "B", f"m{i}")
        send(a, "send_message", candidate_user_id="B", content="too many")
        err = expect(a, "error")
        assert err["code"] == "rate_limited" and isinstance(err["retry_after"], int) and err["retry_after"] >= 1
        expect_none(a, "message_sent")

        resp = env.client.post("/chats/send", json={"candidate_user_id": "B", "content": "rest"},
                               headers=auth_headers("A"))
        assert resp.status_code == 429 and resp.json()["code"] == "rate_limited"
        assert int(resp.headers["Retry-After"]) >= 1
    # Another user has their own bucket.
    ok = env.client.post("/chats/send", json={"candidate_user_id": "A", "content": "hi"}, headers=auth_headers("B"))
    assert ok.status_code == 200 and ok.json()["sender_type"] == "user"


def test_text_length_limit(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(max_text_length=10))
    with env.ws("A") as a:
        send(a, "send_message", candidate_user_id="B", content="x" * 11)
        err = expect(a, "error")
        assert err["code"] == "too_long" and err["max"] == 10
        send_text(a, None, "B", "x" * 10)
    resp = env.client.post("/chats/send", json={"candidate_user_id": "B", "content": "y" * 11}, headers=auth_headers("A"))
    assert resp.status_code == 422 and resp.json()["code"] == "too_long" and resp.json()["max"] == 10


def test_typing_over_limit_is_dropped_silently(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(typing_rate=RateLimit(2, 60)))
    with env.ws("A") as a, env.ws("B") as b:
        send_text(a, b, "B", "hi")
        for _ in range(4):
            send(a, "typing", target_user_id="B", is_typing=True)
        sync(a)
        expect(b, "typing_status", is_typing=True)
        expect(b, "typing_status", is_typing=True)
        # Stop frames are never limited (so an indicator can't get stuck) and nothing errors.
        send(a, "typing", target_user_id="B", is_typing=False)
        expect(b, "typing_status", is_typing=False)
        expect_none(a, "error")


def test_upload_rate_limit(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(upload_rate=RateLimit(1, 60)))
    data = base64.b64encode(PNG).decode()
    with env.ws("A") as a:
        send(a, "media_upload", target_user_id="B", file_name="a.png", file_data=data)
        expect(a, "media_upload_success")
        send(a, "media_upload", target_user_id="B", file_name="b.png", file_data=data)
        assert expect(a, "error")["code"] == "rate_limited"


def test_client_cannot_send_reserved_types(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a:
        send(a, "send_message", candidate_user_id="B", content="sneaky", message_type="system")
        msg = expect(a, "message_sent")["message"]
        assert msg["message_type"] == "text" and msg["sender_type"] == "user"


# --------------------------------------------------------- delete / unsend


def test_delete_for_me_hides_only_for_requester(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        m1 = send_text(a, b, "B", "one")
        m2 = send_text(a, b, "B", "two")
        send(b, "delete_message", message_id=m2["id"])
        assert expect(b, "message_deleted") == {"type": "message_deleted", "chat_id": m2["chat_id"],
                                                "message_id": m2["id"], "for_everyone": False}
        expect_none(a, "message_deleted")

        send(b, "get_messages", candidate_user_id="A")
        assert [m["content"] for m in expect(b, "res_messages")["messages"]] == ["one"]
        send(a, "get_messages", candidate_user_id="B")
        assert [m["content"] for m in expect(a, "res_messages")["messages"]] == ["two", "one"]

        send(b, "req_users")
        conv = expect(b, "res_users")["users"][0]
        assert conv["last_message"]["content"] == "one" and conv["unread_count"] == 1
        assert env.client.get("/chats/B/unread-count", headers=auth_headers("B")).json() == {"unread_count": 1}
        rest = env.client.get(f"/chats/{m1['chat_id']}/messages", headers=auth_headers("B")).json()
        assert [m["id"] for m in rest] == [m1["id"]]

        # Not a participant -> not_found
        with env.ws("C") as c:
            send(c, "delete_message", message_id=m1["id"])
            assert expect(c, "error")["code"] == "not_found"
        send(b, "delete_message", message_id=999999)
        assert expect(b, "error")["code"] == "not_found"


def test_unsend_for_everyone_rewrites_row_and_deletes_media(make_env, tmp_path):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "media_upload", target_user_id="B", file_name="pic.png", file_data=base64.b64encode(PNG).decode())
        media = expect(a, "media_upload_success")["message"]
        expect(b, "new_message")
        path = env.chat.storage.path_for(media["file_url"])
        assert path and os.path.exists(path)

        send(b, "delete_message", message_id=media["id"], for_everyone=True)  # not the sender
        assert expect(b, "error")["code"] == "not_allowed"

        send(a, "delete_message", message_id=media["id"], for_everyone=True)
        event = {"type": "message_deleted", "chat_id": media["chat_id"], "message_id": media["id"], "for_everyone": True}
        assert expect(a, "message_deleted") == event
        assert expect(b, "message_deleted") == event

        send(b, "get_messages", candidate_user_id="A")
        row = expect(b, "res_messages")["messages"][0]
        assert row["id"] == media["id"] and row["message_type"] == "deleted" and row["content"] is None
        assert row["file_url"] is None and row["file_name"] is None and row["file_size"] is None
        deadline = time.monotonic() + 3
        while os.path.exists(path) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not os.path.exists(path)

        # Deleted messages don't count as unread; unsending twice just repeats the event.
        assert env.client.get("/chats/B/unread-count", headers=auth_headers("B")).json() == {"unread_count": 0}
        send(a, "delete_message", message_id=media["id"], for_everyone=True)
        expect(a, "message_deleted", message_id=media["id"])


def test_unsend_window(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(unsend_window_seconds=60))
    with env.ws("A") as a, env.ws("B") as b:
        old = send_text(a, b, "B", "old")

        async def age_it() -> None:
            async with env.hub.session_factory() as session:
                await session.execute(update(Message).where(Message.id == old["id"])
                                      .values(created_at=datetime(2000, 1, 1)))
                await session.commit()

        run(env, age_it)
        send(a, "delete_message", message_id=old["id"], for_everyone=True)
        assert expect(a, "error")["code"] == "window_expired"
        send(a, "delete_message", message_id=old["id"])  # delete for me still works
        expect(a, "message_deleted", for_everyone=False)

    disabled = chat_env(make_env, chat_config=ChatConfig(unsend_window_seconds=-1))
    with disabled.ws("A") as a:
        msg = send_text(a, None, "B", "x")
        send(a, "delete_message", message_id=msg["id"], for_everyone=True)
        assert expect(a, "error")["code"] == "not_allowed"


def test_clear_chat(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        send_text(a, b, "B", "one")
        m2 = send_text(b, a, "A", "two")
        send(a, "clear_chat", candidate_user_id="B")
        cleared = expect(a, "chat_cleared")
        assert cleared["chat_id"] == m2["chat_id"] and cleared["cleared_at"]
        expect_none(b, "chat_cleared")

        send(a, "get_messages", chat_id=m2["chat_id"])
        assert expect(a, "res_messages")["messages"] == []
        send(a, "req_users")
        conv = expect(a, "res_users")["users"][0]
        assert conv["last_message"] is None and conv["unread_count"] == 0 and conv["chat_id"] == m2["chat_id"]
        assert env.client.get("/chats/A/unread-count", headers=auth_headers("A")).json() == {"unread_count": 0}
        assert env.client.get(f"/chats/{m2['chat_id']}/messages", headers=auth_headers("A")).json() == []
        listed = env.client.get("/chats/A", headers=auth_headers("A")).json()
        assert listed[0]["last_message"] is None

        send(b, "get_messages", chat_id=m2["chat_id"])  # the other person keeps theirs
        assert [m["content"] for m in expect(b, "res_messages")["messages"]] == ["two", "one"]

        send_text(b, a, "A", "three")  # new messages show up again
        send(a, "get_messages", chat_id=m2["chat_id"])
        assert [m["content"] for m in expect(a, "res_messages")["messages"]] == ["three"]

        send(a, "clear_chat", chat_id=987654)
        assert expect(a, "error")["code"] == "not_found"


# ------------------------------------------------------------ read by peer


def test_mark_read_by_candidate_user_id(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        msg = send_text(a, b, "B", "read me")
        send(b, "mark_read", chat_id=None, candidate_user_id="A")
        assert expect(b, "chat_read") == {"type": "chat_read", "chat_id": msg["chat_id"]}
        expect(a, "messages_read", read_by="B")

        send_text(b, a, "A", "back")
        resp = env.client.post("/chats/read", json={"candidate_user_id": "B"}, headers=auth_headers("A"))
        assert resp.status_code == 200
        expect(b, "messages_read", read_by="A")
        assert env.client.post("/chats/read", json={"candidate_user_id": "C"}, headers=auth_headers("A")).status_code == 404

        send(a, "mark_read", candidate_user_id="C")
        assert expect(a, "error")["error"] == "Chat not found"


# ----------------------------------------------------- system + server send


def test_system_message(make_env):
    env = chat_env(make_env)
    events = []

    async def on_system(dto):
        events.append(dto)

    env.hub.events.on("chat.system_message_sent", on_system)
    with env.ws("B") as b:
        dto = run(env, lambda: env.chat.send_system_message("B", "You matched with Alice", about_user_id="A",
                                                            data={"kind": "match"}))
        live = expect(b, "new_message")["message"]
        assert live["message_type"] == "system" and live["sender_type"] == "system"
        assert live["content"] == "You matched with Alice" and live["data"] == {"kind": "match"}
        assert dto["id"] == live["id"] and dto["is_delivered"] is True
        assert events and events[0]["id"] == live["id"]

        send(b, "get_messages", candidate_user_id="A")
        assert expect(b, "res_messages")["messages"][0]["sender_type"] == "system"

    # The about-user doesn't see it and gets no delivery receipt for it.
    with env.ws("A") as a:
        send(a, "get_messages", candidate_user_id="B")
        assert expect(a, "res_messages")["messages"] == []
        send(a, "req_users")
        assert expect(a, "res_users")["users"][0]["last_message"] is None

    # Offline recipient -> push with the about-user's name and the extra data.
    run(env, lambda: env.chat.send_system_message("C", "Alice viewed your profile", about_user_id="A"))
    push = env.push.wait_for(lambda p: p["user_id"] == "C")
    assert push["title"] == PROFILES["A"].name and push["data"]["system"] is True
    assert push["data"]["type"] == "chat" and push["data"]["sender_id"] == "A"
    with env.ws("A") as a:
        expect_none(a, "delivery_status")

    try:
        run(env, lambda: env.chat.send_system_message("B", "no partner"))
    except ValueError:
        pass
    else:
        raise AssertionError("about_user_id is required without system_sender_id")


def test_system_sender_id_config(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(system_sender_id="__system__", system_push_title="App"))
    with env.ws("B") as b:
        run(env, lambda: env.chat.send_system_message("B", "Welcome!"))
        msg = expect(b, "new_message")["message"]
        assert msg["sender_id"] == "__system__" and msg["sender_type"] == "system"


def test_send_message_as_and_rest_send(make_env):
    env = chat_env(make_env, chat_config=ChatConfig(message_rate=RateLimit(1, 60)))
    with env.ws("A") as a, env.ws("B") as b:
        dto = run(env, lambda: env.chat.send_message_as("A", "B", "from the server"))
        assert dto["sender_type"] == "user" and dto["content"] == "from the server"
        assert expect(b, "new_message")["message"]["content"] == "from the server"
        expect(a, "message_sent")
        # Trusted helper: no rate limit.
        run(env, lambda: env.chat.send_message_as("A", "B", "again"))
        expect(b, "new_message")

        resp = env.client.post("/chats/send", json={"candidate_user_id": "A", "content": "rest hi",
                                                    "reply_to_id": dto["id"]}, headers=auth_headers("B"))
        assert resp.status_code == 200
        body = resp.json()
        assert body["content"] == "rest hi" and body["reply_to"]["id"] == dto["id"]
        assert expect(a, "new_message")["message"]["id"] == body["id"]
        expect(b, "message_sent")

    assert env.client.post("/chats/send", json={"candidate_user_id": "B"}, headers=auth_headers("A")).status_code == 422
    try:
        run(env, lambda: env.chat.send_message_as("A", "A", "self"))
    except ChatActionError as exc:
        assert exc.status == 400
    else:
        raise AssertionError("self message must fail")


def test_rest_send_respects_policy(make_env):
    class Deny:
        refusal_message = "Nope."

        async def can_message(self, session, sender, recipient):
            return False

        async def block_status(self, session, viewer, others):
            return {}

        async def extra_conversation_info(self, session, viewer, other):
            return {}

    env = chat_env(make_env, chat_policy=Deny())
    resp = env.client.post("/chats/send", json={"candidate_user_id": "B", "content": "x"}, headers=auth_headers("A"))
    assert resp.status_code == 403 and resp.json()["error"] == "Nope."
    # send_message_as skips the policy unless asked.
    run(env, lambda: env.chat.send_message_as("A", "B", "ok"))
    try:
        run(env, lambda: env.chat.send_message_as("A", "B", "no", enforce_policy=True))
    except ChatActionError as exc:
        assert exc.error == "Nope."
    else:
        raise AssertionError("policy must refuse")
