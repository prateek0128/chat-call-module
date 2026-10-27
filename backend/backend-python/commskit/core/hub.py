"""CommsHub: WS handler registry, lifecycle hooks, event bus, routers."""

from __future__ import annotations

import inspect
import logging
from typing import Any, AsyncIterator, Awaitable, Callable, Coroutine, Mapping, Sequence

from fastapi import APIRouter, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from .adapters import (
    AuthAdapter,
    NoopPush,
    NullUserDirectory,
    PushSender,
    SessionFactory,
    UserDirectory,
    UserProfile,
    bearer_dependency,
)
from .compat import PONG_TYPE
from .connections import USER_ROLE, ConnectionManager
from .events import EventBus
from .ratelimit import Limiter, RateLimiter
from .util import TaskSet, now_iso

logger = logging.getLogger("commskit.hub")

# Handler(user_id, message, session). Errors propagate to the socket loop, which
# replies {"type":"error","error":"Message processing failed: ..."}.
Handler = Callable[[str, dict, AsyncSession], Awaitable[None]]
ConnectHook = Callable[[str, WebSocket], Awaitable[None]]
DisconnectHook = Callable[[str], Awaitable[None]]
# role_resolver(user_id) -> "user" | any other role (sync or async). Non-user roles (e.g. "admin")
# get no presence, no delivery flush, no user hooks and no user.came_online.
RoleResolver = Callable[[str], "str | Awaitable[str]"]
# on_handler_error(user_id, frame, exc): frame is the parsed message, or the raw text for bad JSON.
HandlerErrorHook = Callable[[str, Any, BaseException], Awaitable[None]]


class CommsHub:
    def __init__(
        self,
        *,
        auth: AuthAdapter,
        session_factory: SessionFactory,
        users: UserDirectory | None = None,
        push: PushSender | None = None,
        connections: ConnectionManager | None = None,
        rate_limiter: Limiter | None = None,
        role_resolver: RoleResolver | None = None,
        on_handler_error: HandlerErrorHook | None = None,
        came_online_cooldown: float | None = None,
    ) -> None:
        self.auth = auth
        self.session_factory = session_factory
        self.users: UserDirectory = users or NullUserDirectory()
        self.push_sender: PushSender = push or NoopPush()
        self.connections = connections or ConnectionManager()
        if came_online_cooldown is not None:
            self.connections.came_online_cooldown = float(came_online_cooldown)
        self.rate_limiter: Limiter = rate_limiter or RateLimiter()
        self.role_resolver = role_resolver
        self.on_handler_error = on_handler_error
        self.events = EventBus()
        self.features: dict[str, Any] = {}
        self.current_user = bearer_dependency(auth)  # FastAPI dependency -> user id
        self._handlers: dict[str, Handler] = {}
        self._connect_hooks: list[tuple[ConnectHook, bool]] = []
        self._routers: list[APIRouter] = []
        self._tasks = TaskSet()
        self.connections.add_offline_hook(self._emit_disconnected)
        self.on("ping", self._handle_ping)
        self.on("user_status", self._handle_user_status)

    # ------------------------------------------------------------ registry

    def on(self, type_: str, handler: Handler | None = None) -> Any:
        """Register a WS handler for frames of ``type_``. Usable as a decorator.

        Registering a type again replaces the previous handler (hosts can override).
        """
        def register(fn: Handler) -> Handler:
            self._handlers[type_] = fn
            return fn

        return register(handler) if handler is not None else register

    def handles(self, type_: str) -> bool:
        return type_ in self._handlers

    async def dispatch(self, user_id: str, message: dict, session: AsyncSession) -> bool:
        """Run the handler for ``message["type"]``. Unknown types are ignored (False)."""
        handler = self._handlers.get(message.get("type"))  # type: ignore[arg-type]
        if handler is None:
            return False
        await handler(user_id, message, session)
        return True

    def on_connect(self, hook: ConnectHook, all_roles: bool = False) -> ConnectHook:
        """``hook(user_id, websocket)`` after a socket is registered (runs before frames).

        Runs for ``"user"`` connections only, unless ``all_roles`` (see ``role_resolver``)."""
        self._connect_hooks.append((hook, all_roles))
        return hook

    def on_disconnect(self, hook: DisconnectHook, all_roles: bool = False) -> DisconnectHook:
        """``hook(user_id)`` when the user's last socket on this worker closes (users only unless ``all_roles``)."""
        self.connections.add_offline_hook(hook, all_roles)
        return hook

    async def role_of(self, user_id: str) -> str:
        """``role_resolver(user_id)``; ``"user"`` without a resolver or when it fails."""
        if self.role_resolver is None:
            return USER_ROLE
        try:
            role = self.role_resolver(user_id)
            if inspect.isawaitable(role):
                role = await role
            return str(role or USER_ROLE)
        except Exception:
            logger.exception("role_resolver failed for %s", user_id)
            return USER_ROLE

    async def report_handler_error(self, user_id: str, frame: Any, exc: BaseException) -> None:
        """Call ``on_handler_error``; never raises (hook failures are logged)."""
        if self.on_handler_error is None:
            return
        try:
            await self.on_handler_error(user_id, frame, exc)
        except Exception:
            logger.exception("on_handler_error hook failed")

    # ---------------------------------------------------------------- rooms

    def join_room(self, user_id: str, room: str) -> bool:
        """Put the user's sockets on this worker in ``room`` (call from a connect hook / WS handler)."""
        return self.connections.join_room(user_id, room)

    def leave_room(self, user_id: str, room: str) -> None:
        self.connections.leave_room(user_id, room)

    async def broadcast_room(self, room: str, frame: dict[str, Any]) -> int:
        """Send ``frame`` as given to every member on every worker (with a room-capable bridge)."""
        return await self.connections.broadcast_room(room, frame)

    def register_feature(self, name: str, feature: Any) -> None:
        if name in self.features:
            raise RuntimeError(f"Feature '{name}' is already installed on this hub")
        self.features[name] = feature

    def include_router(self, router: APIRouter) -> None:
        self._routers.append(router)

    # ------------------------------------------------------------- routers

    def ws_router(self, path: str = "/ws/{token}") -> APIRouter:
        from .websocket import build_ws_router

        return build_ws_router(self, path)

    def rest_router(self) -> APIRouter:
        router = APIRouter()
        for feature_router in self._routers:
            router.include_router(feature_router)
        return router

    async def get_session(self) -> AsyncIterator[AsyncSession]:
        """FastAPI dependency yielding a session from the host's factory."""
        async with self.session_factory() as session:
            yield session

    # ------------------------------------------------------------ services

    def spawn(self, coro: Coroutine[Any, Any, Any]) -> None:
        self._tasks.spawn(coro)

    async def shutdown(self) -> None:
        await self._tasks.cancel_all()
        await self.connections.stop()

    async def send(self, user_id: str, payload: dict[str, Any]) -> bool:
        return await self.connections.send(user_id, payload)

    async def run_connect_hooks(
        self, user_id: str, websocket: WebSocket, role: str = USER_ROLE, came_online: bool = False,
    ) -> None:
        is_user = role == USER_ROLE
        for hook, all_roles in list(self._connect_hooks):
            if not (is_user or all_roles):
                continue
            try:
                await hook(user_id, websocket)
            except Exception:
                logger.exception("on_connect hook failed for %s", user_id)
        if not is_user:
            return
        await self.events.emit("user.connected", user_id)
        if came_online:
            await self.events.emit("user.came_online", user_id)

    async def profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        ids = [u for u in dict.fromkeys(user_ids) if u]
        if not ids:
            return {}
        try:
            return await self.users.get_profiles(ids)
        except Exception:
            logger.exception("UserDirectory.get_profiles failed")
            return {}

    async def profile(self, user_id: str) -> UserProfile | None:
        return (await self.profiles([user_id])).get(user_id)

    async def display_name(self, user_id: str, default: str = "Someone") -> str:
        profile = await self.profile(user_id)
        return profile.name if profile and profile.name else default

    async def push(
        self, user_id: str, title: str, body: str, data: Mapping[str, Any],
        channel: str = "default", ttl: int | None = None,
    ) -> None:
        """Never raises: push failures are logged."""
        try:
            await self.push_sender.send(user_id, title, body, data, channel=channel, ttl=ttl)
        except Exception:
            logger.exception("Push to %s failed", user_id)

    # -------------------------------------------------------- core handlers

    async def _handle_ping(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self.send(user_id, {"type": PONG_TYPE, "timestamp": now_iso()})

    async def _handle_user_status(self, user_id: str, message: dict, session: AsyncSession) -> None:
        await self.connections.set_status(user_id, str(message.get("status", "online")))

    async def _emit_disconnected(self, user_id: str) -> None:
        await self.events.emit("user.disconnected", user_id)
