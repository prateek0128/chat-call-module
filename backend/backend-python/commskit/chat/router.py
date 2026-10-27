"""Chat REST routes (PROTOCOL.md section 5), all Bearer-authenticated."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from commskit.core.util import iso

from .dto import message_dto
from .service import ChatActionError, ChatService

if TYPE_CHECKING:
    from .feature import ChatFeature


def build_chat_router(feature: "ChatFeature") -> APIRouter:
    hub = feature.hub
    router = APIRouter(prefix="/chats", tags=["chat"])
    current_user = hub.current_user
    get_session = hub.get_session

    def ensure_self(path_user_id: str, auth_user_id: str) -> None:
        if path_user_id != auth_user_id:
            raise HTTPException(status_code=403, detail="Not allowed")

    @router.post("/start")
    async def start_chat(
        candidate_id: str,
        user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> dict[str, Any]:
        if candidate_id == user_id:
            raise HTTPException(status_code=400, detail="Cannot start a chat with yourself")
        chat = await ChatService(session).get_or_create_chat(user_id, candidate_id)
        return {
            "chat_id": chat.id,
            "user1_id": chat.user1_id,
            "user2_id": chat.user2_id,
            "created_at": iso(chat.created_at),
            "updated_at": iso(chat.updated_at),
        }

    # Skipped when DevicesFeature (commskit.core.devices) is already installed: it mounts these too.
    if feature.devices is not None and "devices" not in hub.features:
        devices = feature.devices

        @router.post("/expo/push/token")
        async def register_push_token(
            payload: dict[str, Any] = Body(...),
            user_id: str = Depends(current_user),
        ) -> Any:
            return await devices.register(user_id, payload)

        @router.post("/expo/push/token/remove")
        async def remove_push_token(
            payload: dict[str, Any] = Body(...),
            user_id: str = Depends(current_user),
        ) -> Any:
            return await devices.remove(user_id, payload)

    def action_error(exc: ChatActionError) -> JSONResponse:
        body = exc.frame()
        body.pop("type", None)
        headers = {"Retry-After": str(exc.extra["retry_after"])} if "retry_after" in exc.extra else None
        return JSONResponse(status_code=exc.status, content={"detail": body, **body}, headers=headers)

    @router.post("/send")
    async def send_message(
        payload: dict[str, Any] = Body(...),
        user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> Any:
        """Same rules and events as WS send_message (policy, limits, push); returns the sender's MessageDto."""
        recipient, content = payload.get("candidate_user_id"), payload.get("content")
        if not recipient or not content:
            raise HTTPException(status_code=422, detail="Missing required fields: candidate_user_id, content")
        try:
            return await feature.handlers.send_text(session, user_id, str(recipient), content,
                                                    reply_to_id=payload.get("reply_to_id"))
        except ChatActionError as exc:
            return action_error(exc)

    @router.post("/read")
    async def mark_read_by_peer(
        payload: dict[str, Any] = Body(...),
        user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> dict[str, str]:
        """{chat_id?} or {candidate_user_id?} (chat_id wins)."""
        service = ChatService(session)
        chat = await feature.handlers.resolve_chat(service, user_id, payload.get("chat_id"),
                                                   payload.get("candidate_user_id"))
        if chat is None:
            raise HTTPException(status_code=404, detail="Chat not found")
        await service.mark_messages_as_read(chat.id, user_id)
        await feature.handlers.notify_read(chat.id, user_id, chat.other(user_id))
        return {"message": "Messages marked as read"}

    @router.get("/{user_id}")
    async def list_chats(
        user_id: str,
        auth_user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> list[dict[str, Any]]:
        ensure_self(user_id, auth_user_id)
        convs = await ChatService(session).get_conversations(user_id)
        profiles = await hub.profiles([c["other_user_id"] for c in convs])
        result = []
        for conv in convs:
            other = conv["other_user_id"]
            profile = profiles.get(other)
            result.append({
                "id": conv["chat_id"],
                "other_user": {
                    "id": other,
                    "username": profile.name if profile and profile.name else other,
                    "avatar": profile.avatar if profile else None,
                },
                "last_message": conv["last_message"],
                "unread_count": conv["unread_count"],
                "updated_at": conv["updated_at"],
            })
        return result

    @router.get("/{chat_id}/messages")
    async def chat_messages(
        chat_id: int,
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0),
        user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> list[dict[str, Any]]:
        service = ChatService(session)
        if await service.get_chat_for_user(chat_id, user_id) is None:
            raise HTTPException(status_code=404, detail="Chat not found")
        rows = await service.get_messages_page(chat_id, limit, offset, viewer_id=user_id)
        previews = await service.get_reply_previews([m.reply_to_id for m in rows if m.reply_to_id])
        return [message_dto(m, user_id, previews.get(m.reply_to_id) if m.reply_to_id else None) for m in rows]

    @router.post("/{chat_id}/read")
    async def mark_read(
        chat_id: int,
        user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> dict[str, str]:
        service = ChatService(session)
        chat = await service.get_chat_for_user(chat_id, user_id)
        if chat is None:
            raise HTTPException(status_code=404, detail="Chat not found")
        await service.mark_messages_as_read(chat_id, user_id)
        await feature.handlers.notify_read(chat_id, user_id, chat.other(user_id))
        return {"message": "Messages marked as read"}

    @router.get("/{user_id}/unread-count")
    async def unread_count(
        user_id: str,
        auth_user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> dict[str, int]:
        ensure_self(user_id, auth_user_id)
        return {"unread_count": await ChatService(session).get_unread_count(user_id)}

    @router.get("/{user_id}/online-status")
    async def online_status(
        user_id: str,
        auth_user_id: str = Depends(current_user),
        session: AsyncSession = Depends(get_session),
    ) -> dict[str, Any]:
        # Only for yourself or someone you chat with.
        if user_id != auth_user_id and not await ChatService(session).get_chat_between(auth_user_id, user_id):
            raise HTTPException(status_code=403, detail="Not allowed")
        return {"user_id": user_id, "is_online": await hub.connections.is_online(user_id)}

    return router
