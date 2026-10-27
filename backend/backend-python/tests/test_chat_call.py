"""Chat + call linked through commskit.integration."""

from __future__ import annotations

import pytest

from commskit.call import CallConfig

from conftest import expect, send


def test_linked_app_registers_both(make_env):
    env = make_env(chat=True, call=True)
    assert env.call.chat_bridge is not None
    assert env.hub.handles("send_message") and env.hub.handles("call_initiate")


def test_happy_path_writes_call_log(make_env):
    env = make_env(chat=True, call=True)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B", chat_id=424242)  # client chat_id is not trusted
        initiated = expect(a, "call_initiated")
        incoming = expect(b, "incoming_call")
        chat_id = initiated["chat_id"]
        assert isinstance(chat_id, int) and chat_id != 424242 and incoming["chat_id"] == chat_id
        call_id = initiated["call_id"]

        # Placeholder entry exists while ringing.
        send(b, "get_messages", chat_id=chat_id)
        entry = expect(b, "res_messages")["messages"][0]
        assert entry["content"] == "[Call Initiated]" and entry["message_type"] == "audio_call"
        assert entry["call_id"] == call_id and entry["sender_id"] == "A"

        send(b, "answer_call", call_id=call_id)
        expect(a, "call_answered")
        send(b, "end_call", call_id=call_id)
        ended = expect(a, "call_ended")
        assert ended["ended_by"] == "B" and ended["chat_id"] == chat_id

        for ws in (a, b):
            log = expect(ws, "call_log")
            assert log == {
                "type": "call_log", "call_id": call_id, "chat_id": chat_id, "message_id": entry["id"],
                "content": f"Voice call · 00:{ended['duration_seconds']:02d}", "status": "ended",
                "duration_seconds": ended["duration_seconds"],
            }

        send(a, "get_messages", chat_id=chat_id)
        rewritten = expect(a, "res_messages")["messages"][0]
        assert rewritten["id"] == entry["id"] and rewritten["content"].startswith("Voice call · ")

        # Call partners now see each other in the conversation list.
        send(a, "req_users")
        assert expect(a, "res_users")["users"][0]["chat_id"] == chat_id


@pytest.mark.parametrize(
    ("who", "call_type", "status", "text"),
    [
        ("B", "audio", "rejected", "Declined voice call"),
        ("A", "audio", "missed", "Missed voice call"),
        ("B", "video", "rejected", "Declined video call"),
    ],
)
def test_reject_and_cancel_logs(make_env, who, call_type, status, text):
    env = make_env(chat=True, call=True)
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B", call_type=call_type)
        call_id = expect(a, "call_initiated")["call_id"]
        expect(b, "incoming_call")
        send(b if who == "B" else a, "reject_call", call_id=call_id)
        log = expect(a, "call_log")
        assert log["status"] == status and log["content"] == text
        assert expect(b, "call_log")["content"] == text

        send(a, "get_messages", chat_id=log["chat_id"])
        msg = expect(a, "res_messages")["messages"][0]
        assert msg["message_type"] == f"{call_type}_call" and msg["content"] == text


def test_missed_call_log_on_timeout(make_env):
    env = make_env(chat=True, call=True, call_config=CallConfig(ring_timeout=0.4))
    with env.ws("A") as a, env.ws("B") as b:
        send(a, "call_initiate", receiver_id="B")
        call_id = expect(a, "call_initiated")["call_id"]
        expect(a, "call_missed", timeout=3)
        log = expect(a, "call_log")
        assert log["call_id"] == call_id and log["content"] == "Missed voice call" and log["status"] == "missed"
        expect(b, "call_log", call_id=call_id)


def test_link_requires_same_hub(make_env):
    from commskit.integration import link_chat_and_call

    one = make_env(chat=True, call=False)
    two = make_env(chat=False, call=True)
    with pytest.raises(ValueError):
        link_chat_and_call(one.chat, two.call)
