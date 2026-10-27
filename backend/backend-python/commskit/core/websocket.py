"""The single ``/ws/{token}`` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .adapters import resolve_user_id

if TYPE_CHECKING:
    from .hub import CommsHub

logger = logging.getLogger("commskit.ws")


def build_ws_router(hub: "CommsHub", path: str = "/ws/{token}") -> APIRouter:
    router = APIRouter()

    @router.websocket(path)
    async def comms_socket(websocket: WebSocket, token: str) -> None:
        # Accept first, then authenticate: clients expect close code 1008 on a bad token.
        await websocket.accept()
        try:
            user_id = await resolve_user_id(hub.auth, token)
        except Exception as exc:
            logger.info("WS auth failed: %s", exc)
            await websocket.close(code=1008, reason="Invalid token")
            return

        connections = hub.connections
        heartbeat: asyncio.Task[None] | None = None
        try:
            role = await hub.role_of(user_id)
            came_online = await connections.register(user_id, websocket, role=role)
            await hub.run_connect_hooks(user_id, websocket, role=role, came_online=came_online)

            bridge = connections.bridge
            if bridge is not None:
                async def _beat() -> None:
                    while True:
                        await asyncio.sleep(bridge.heartbeat_seconds)
                        await connections.heartbeat(user_id)

                heartbeat = asyncio.create_task(_beat())

            while True:
                try:
                    raw = await websocket.receive_text()
                except WebSocketDisconnect:
                    break
                await _handle_frame(hub, user_id, websocket, raw)
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("WS loop for %s crashed", user_id)
            try:
                await websocket.close(code=1011, reason="Internal server error")
            except Exception:
                pass
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
            connections.disconnect(user_id, websocket)

    return router


async def _handle_frame(hub: "CommsHub", user_id: str, websocket: WebSocket, raw: str) -> None:
    send = hub.connections.send_to_socket
    try:
        message = json.loads(raw)
    except ValueError as exc:
        await hub.report_handler_error(user_id, raw, exc)
        await send(websocket, {"type": "error", "error": "Invalid JSON"})
        return
    if not isinstance(message, dict):
        await hub.report_handler_error(user_id, message, TypeError("Message must be a JSON object"))
        await send(websocket, {"type": "error", "error": "Message must be a JSON object"})
        return
    try:
        async with hub.session_factory() as session:
            await hub.dispatch(user_id, message, session)
    except WebSocketDisconnect:
        raise
    except Exception as exc:
        logger.exception("Handler for %r failed", message.get("type"))
        await hub.report_handler_error(user_id, message, exc)
        try:
            await hub.send(user_id, {"type": "error", "error": f"Message processing failed: {exc}"})
        except Exception:
            pass
