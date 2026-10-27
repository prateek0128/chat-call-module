"""Chat-only app (no call feature installed)."""

from __future__ import annotations

import base64

from conftest import auth_headers, expect, expect_none, send, sync

MESSAGE_DTO_KEYS = {
    "id", "chat_id", "sender_id", "sender_type", "content", "message_type", "timestamp",
    "file_url", "file_name", "file_size", "file_type", "thumbnail_url", "duration",
    "is_read", "is_delivered", "call_id", "reply_to",
}


def chat_env(make_env, **kw):
    return make_env(chat=True, call=False, **kw)


def test_chat_only_app_has_no_call(make_env):
    env = chat_env(make_env)
    assert env.hub.handles("send_message") and not env.hub.handles("call_initiate")
    assert env.client.post("/call/turn-credentials", headers=auth_headers("A")).status_code == 404


def test_send_and_receive_shapes(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "send_message", candidate_user_id="B", content="hi Bob", chat_id=999)
        new = expect(b, "new_message")
        sent = expect(a, "message_sent")

        msg = new["message"]
        assert set(new) == {"type", "message"} and set(msg) == MESSAGE_DTO_KEYS
        assert msg["sender_id"] == "A" and msg["sender_type"] == "other"
        assert msg["content"] == "hi Bob" and msg["message_type"] == "text"
        assert msg["is_read"] is False and msg["is_delivered"] is True
        assert isinstance(msg["chat_id"], int) and msg["timestamp"]
        assert msg["reply_to"] is None and msg["call_id"] is None

        mine = sent["message"]
        assert set(mine) == MESSAGE_DTO_KEYS
        assert mine["id"] == msg["id"] and mine["sender_type"] == "user"
        assert mine["is_delivered"] is True

        # Reply preview
        send(b, "send_message", candidate_user_id="A", content="hey", reply_to_id=msg["id"])
        reply = expect(a, "new_message")["message"]
        assert reply["reply_to"] == {
            "id": msg["id"], "sender_id": "A", "content": "hi Bob", "message_type": "text", "file_name": None,
        }
    assert env.push.sent == []  # both were online


def test_validation_errors(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a:
        send(a, "send_message", candidate_user_id="B")
        assert expect(a, "error")["error"] == "Missing required fields: candidate_user_id, content"
        send(a, "send_message", candidate_user_id="A", content="me")
        assert expect(a, "error")["error"] == "Cannot send a message to yourself."
        send(a, "get_messages", chat_id=12345)
        assert expect(a, "error")["error"] == "Chat not found"


def test_offline_push_and_delivery_receipt(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a:
        send(a, "send_message", candidate_user_id="B", content="x" * 200)
        sent = expect(a, "message_sent")["message"]
        assert sent["is_delivered"] is False
        push = env.push.wait_for(lambda p: p["user_id"] == "B")
        assert push["title"] == "Alice" and push["body"] == "x" * 120
        assert push["channel"] == "messages"
        assert push["data"] == {"type": "chat", "cid": "messaging:A", "chat_id": sent["chat_id"], "sender_id": "A"}

        with env.ws("B"):
            receipt = expect(a, "delivery_status")
        assert receipt["chat_id"] == sent["chat_id"]
        assert receipt["message_ids"] == [sent["id"]] and receipt["status"] == "delivered"


def test_get_messages_pagination(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        for i in range(15):
            send(a, "send_message", candidate_user_id="B", content=f"m{i}")
            expect(a, "message_sent")

        send(b, "get_messages", candidate_user_id="A", limit=10)
        page1 = expect(b, "res_messages")
        assert [m["content"] for m in page1["messages"]] == [f"m{i}" for i in range(14, 4, -1)]
        assert page1["offset"] == 0 and page1["has_more"] is True
        assert all(m["sender_type"] == "other" for m in page1["messages"])
        info = page1["info"]
        assert info["user_id"] == "A" and info["username"] == "Alice" and info["avatar"] == "https://img/a.png"
        assert info["status"] == "online" and info["last_seen"] == page1["messages"][0]["timestamp"]
        assert info["chat_consent_given"] is True
        assert info["is_blocked"] is False and info["blocked_by_other"] is False

        chat_id = page1["messages"][0]["chat_id"]
        send(b, "get_messages", chat_id=chat_id, offset=10, limit=10)
        page2 = expect(b, "res_messages")
        assert [m["content"] for m in page2["messages"]] == [f"m{i}" for i in range(4, -1, -1)]
        assert page2["offset"] == 10 and page2["has_more"] is False

        send(b, "get_messages", candidate_user_id="C")  # no chat yet
        empty = expect(b, "res_messages")
        assert empty["messages"] == [] and empty["has_more"] is False and empty["info"]["username"] == "Carol"

        # REST pagination, same DTO shape
        rest = env.client.get(f"/chats/{chat_id}/messages", params={"limit": 3, "offset": 1}, headers=auth_headers("A"))
        assert rest.status_code == 200
        assert [m["content"] for m in rest.json()] == ["m13", "m12", "m11"]
        assert set(rest.json()[0]) == MESSAGE_DTO_KEYS and rest.json()[0]["sender_type"] == "user"
        assert env.client.get(f"/chats/{chat_id}/messages", headers=auth_headers("C")).status_code == 404


def test_mark_read_events(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "send_message", candidate_user_id="B", content="read me")
        chat_id = expect(b, "new_message")["message"]["chat_id"]

        assert env.client.get("/chats/B/unread-count", headers=auth_headers("B")).json() == {"unread_count": 1}
        send(b, "mark_read", chat_id=chat_id, candidate_user_id="A")
        assert expect(b, "chat_read") == {"type": "chat_read", "chat_id": chat_id}
        assert expect(a, "messages_read") == {"type": "messages_read", "chat_id": chat_id, "read_by": "B"}
        assert env.client.get("/chats/B/unread-count", headers=auth_headers("B")).json() == {"unread_count": 0}

        send(a, "get_messages", chat_id=chat_id)
        assert expect(a, "res_messages")["messages"][0]["is_read"] is True

        # REST variant emits the same events
        send(b, "send_message", candidate_user_id="A", content="back")
        expect(a, "new_message")
        resp = env.client.post(f"/chats/{chat_id}/read", headers=auth_headers("A"))
        assert resp.json() == {"message": "Messages marked as read"}
        expect(a, "chat_read", chat_id=chat_id)
        expect(b, "messages_read", read_by="A")


def test_typing_status(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "typing", target_user_id="B", is_typing=True)  # no chat yet: dropped
        sync(a)
        send(a, "send_message", candidate_user_id="B", content="hi")
        chat_id = expect(b, "new_message")["message"]["chat_id"]

        send(a, "typing", target_user_id="B", is_typing=True)
        typing = expect(b, "typing_status")
        assert typing["user_id"] == "A" and typing["chat_id"] == chat_id and typing["is_typing"] is True
        assert typing["timestamp"]
        send(a, "typing", target_user_id="B", is_typing=False)
        assert expect(b, "typing_status")["is_typing"] is False


def test_req_users_and_presence(make_env):
    env = chat_env(make_env)
    with env.ws("A") as a:
        with env.ws("B") as b:
            send(a, "send_message", candidate_user_id="B", content="first")
            expect(b, "new_message")
            send(b, "user_status", status="away")
            assert expect(a, "user_status", user_id="B")["status"] == "away"
            send(b, "user_status", status="online")
            expect(a, "user_status", user_id="B", status="online")

            send(b, "req_users")
            users = expect(b, "res_users")["users"]
            assert len(users) == 1
            entry = users[0]
            assert entry["user_id"] == "A" and entry["username"] == "Alice" and entry["status"] == "online"
            assert entry["unread_count"] == 1 and entry["last_message"]["content"] == "first"
            assert entry["is_blocked"] is False and entry["blocked_by_other"] is False
            assert entry["updated_at"] == entry["last_message"]["timestamp"]
        expect(a, "user_status", user_id="B", status="offline")

        # REST list + presence
        convs = env.client.get("/chats/A", headers=auth_headers("A")).json()
        assert convs[0]["other_user"]["username"] == "Bob" and convs[0]["unread_count"] == 0
        assert env.client.get("/chats/B", headers=auth_headers("A")).status_code == 403
        status = env.client.get("/chats/B/online-status", headers=auth_headers("A")).json()
        assert status == {"user_id": "B", "is_online": False}
        assert env.client.get("/chats/C/online-status", headers=auth_headers("A")).status_code == 403


def test_policy_refusal(make_env):
    class Blocking:
        refusal_message = "Cannot send message. User is blocked."

        async def can_message(self, session, sender_id, recipient_id):
            return recipient_id != "C"

        async def block_status(self, session, viewer_id, other_ids):
            return {o: (True, False) for o in other_ids if o == "C"}

        async def extra_conversation_info(self, session, viewer_id, other_id):
            return {"chat_consent_given": False}

    env = chat_env(make_env, chat_policy=Blocking())
    with env.ws("A") as a, env.ws("C") as c:
        send(a, "send_message", candidate_user_id="C", content="hello?")
        assert expect(a, "error") == {"type": "error", "error": "Cannot send message. User is blocked."}
        send(a, "typing", target_user_id="C", is_typing=True)
        expect_none(c, "typing_status")
        send(a, "get_messages", candidate_user_id="C")
        info = expect(a, "res_messages")["info"]
        assert info["is_blocked"] is True and info["chat_consent_given"] is False


def test_media_upload(make_env):
    env = chat_env(make_env)
    data = base64.b64encode(b"\x89PNG fake image bytes").decode()
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "media_upload", target_user_id="B", file_name="photo.png", file_data=data)
        ok = expect(a, "media_upload_success")["message"]
        assert ok["content"] is None and ok["message_type"] == "image"
        assert ok["file_name"] == "photo.png" and ok["file_size"] == 21 and ok["file_type"] == "image/png"
        assert ok["file_url"].startswith("/media/chat/")

        new = expect(b, "new_message")["message"]
        assert new["content"] == "[IMAGE] photo.png" and new["sender_type"] == "other"
        sent = expect(a, "message_sent")["message"]
        assert sent["content"] is None and sent["is_delivered"] is True

        send(a, "media_upload", target_user_id="B", file_name="voice.m4a", file_data=data, media_type="voice")
        assert expect(b, "new_message")["message"]["message_type"] == "voice"

        send(a, "media_upload", target_user_id="B", file_name="virus.exe", file_data=data)
        assert expect(a, "error")["error"] == "Unsupported file type: virus.exe"


def test_media_too_large(make_env):
    from commskit.chat import ChatConfig  # noqa: F401  (config is per feature)

    env = chat_env(make_env)
    env.chat.config.max_upload_bytes = 10
    with env.ws("A") as a:
        send(a, "media_upload", target_user_id="B", file_name="a.png", file_data=base64.b64encode(b"x" * 11).decode())
        assert expect(a, "error")["error"].startswith("File too large")


def test_rest_start_chat(make_env):
    env = chat_env(make_env)
    first = env.client.post("/chats/start", params={"candidate_id": "B"}, headers=auth_headers("A")).json()
    again = env.client.post("/chats/start", params={"candidate_id": "A"}, headers=auth_headers("B")).json()
    assert first["chat_id"] == again["chat_id"]
    assert (first["user1_id"], first["user2_id"]) == ("A", "B")

