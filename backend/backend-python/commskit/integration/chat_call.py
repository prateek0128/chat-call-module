"""Chat + call wiring: calls live in the chat as call-log entries."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from commskit.call import CallFeature, CallInfo, call_log_text
from commskit.chat import ChatFeature, ChatService

CALL_PLACEHOLDER = "[Call Initiated]"


class ChatCallBridge:
    """Implements ``commskit.call.CallChatBridge`` on top of the chat tables."""

    def __init__(self, chat: ChatFeature, call: CallFeature) -> None:
        self.chat = chat
        self.call = call

    async def resolve_chat_id(
        self, session: AsyncSession, caller_id: str, receiver_id: str, requested_chat_id: object
    ) -> int | None:
        # Always the pair's chat; a client-sent chat_id is never trusted.
        return (await ChatService(session).get_or_create_chat(caller_id, receiver_id)).id

    async def on_call_created(self, session: AsyncSession, info: CallInfo) -> None:
        if info.chat_id is None:
            return
        await ChatService(session).send_message(
            info.chat_id, info.caller_id, CALL_PLACEHOLDER, f"{info.call_type}_call", call_id=info.call_id
        )

    async def on_call_finalizing(self, session: AsyncSession, info: CallInfo) -> None:
        text = call_log_text(info.status, info.is_video_call, info.duration, info.end_reason)
        info.message_id = await ChatService(session).rewrite_call_message(info.call_id, text)
        info.log_text = text

    async def send_call_log(self, info: CallInfo) -> None:
        """``call.finalized`` listener: both parties' chat entry now reads e.g. "Voice call · 05:42"."""
        if not info.message_id:
            return
        payload = {
            "type": "call_log",
            "call_id": info.call_id,
            "chat_id": info.chat_id,
            "message_id": info.message_id,
            "content": info.log_text,
            "status": info.status,
            "duration_seconds": info.duration,
        }
        hub = self.call.hub
        await hub.send(info.caller_id, payload)
        await hub.send(info.receiver_id, payload)


def link_chat_and_call(chat: ChatFeature, call: CallFeature) -> ChatCallBridge:
    """Both features must already be installed on the same hub."""
    if chat.hub is not call.hub:
        raise ValueError("chat and call must be installed on the same CommsHub")
    if call.chat_bridge is not None:
        raise RuntimeError("call feature is already linked to a chat bridge")
    bridge = ChatCallBridge(chat, call)
    call.chat_bridge = bridge
    call.hub.events.on("call.finalized", bridge.send_call_log)
    return bridge
