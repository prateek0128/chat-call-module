"""Test apps (chat-only, call-only, chat+call) on SQLite + Starlette TestClient."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

import anyio
import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import WebSocketTestSession

from commskit.core import CommsBase, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, UserProfile

# Register every kit table on CommsBase.metadata before create_all (features import lazily).
import commskit.chat  # noqa: E402,F401
import commskit.call  # noqa: E402,F401
import commskit.core.devices  # noqa: E402,F401
import commskit.moderation  # noqa: E402,F401

SECRET = "test-only-secret-signed-by-the-tests-0001"  # not a real secret; tests sign their own tokens

PROFILES = {
    "A": UserProfile(name="Alice", avatar="https://img/a.png"),
    "B": UserProfile(name="Bob", avatar="https://img/b.png"),
    "C": UserProfile(name="Carol", avatar=None),
}


def token(user_id: str) -> str:
    return jwt.encode({"uid": user_id}, SECRET, algorithm="HS256")


def auth_headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token(user_id)}"}


@dataclass
class RecordingPush:
    sent: list[dict[str, Any]] = field(default_factory=list)

    async def send(self, user_id: str, title: str, body: str, data: Any, channel: str = "default", ttl: int | None = None) -> None:
        self.sent.append({"user_id": user_id, "title": title, "body": body, "data": dict(data), "channel": channel, "ttl": ttl})

    def wait_for(self, predicate: Callable[[dict], bool], timeout: float = 3.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for item in self.sent:
                if predicate(item):
                    return item
            time.sleep(0.02)
        raise AssertionError(f"No matching push; sent={self.sent}")


@dataclass
class Env:
    app: FastAPI
    client: TestClient
    hub: CommsHub
    push: RecordingPush
    chat: Any = None
    call: Any = None
    moderation: Any = None
    devices: Any = None

    def ws(self, user_id: str) -> Any:
        return self.client.websocket_connect(f"/ws/{token(user_id)}")


# ------------------------------------------------------------- ws helpers


def recv(ws: WebSocketTestSession, timeout: float = 5.0) -> dict:
    """receive_json with a timeout (a missing frame fails instead of hanging)."""
    async def _receive() -> Any:
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()

    message = ws.portal.call(_receive)
    ws._raise_on_close(message)
    return json.loads(message["text"])


def expect(ws: WebSocketTestSession, type_: str, timeout: float = 5.0, **match: Any) -> dict:
    """Next frame of ``type_`` (matching ``match``), skipping unrelated frames."""
    deadline = time.monotonic() + timeout
    skipped = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"No {type_} {match}; skipped={skipped}")
        try:
            frame = recv(ws, remaining)
        except TimeoutError:
            raise AssertionError(f"No {type_} {match}; skipped={skipped}") from None
        if frame.get("type") == type_ and all(frame.get(k) == v for k, v in match.items()):
            return frame
        skipped.append(frame)


def expect_none(ws: WebSocketTestSession, type_: str, wait: float = 0.4) -> None:
    """No frame of ``type_`` arrives within ``wait`` seconds."""
    deadline = time.monotonic() + wait
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            frame = recv(ws, remaining)
        except TimeoutError:
            return
        assert frame.get("type") != type_, frame


def send(ws: WebSocketTestSession, type_: str, **payload: Any) -> None:
    ws.send_json({"type": type_, **payload})


def sync(ws: WebSocketTestSession) -> None:
    """Round-trip a ping so earlier frames from this socket are fully processed."""
    send(ws, "ping")
    expect(ws, "PONG")


# ---------------------------------------------------------------- app factory


@pytest.fixture
def make_env(tmp_path: Path) -> Iterator[Callable[..., Env]]:
    clients: list[TestClient] = []
    engines: list[Any] = []
    hubs: list[CommsHub] = []

    def factory(
        *,
        chat: bool = True,
        call: bool = True,
        link: bool | None = None,
        chat_policy: Any = None,
        call_policy: Any = None,
        call_config: Any = None,
        moderation: bool = False,
        moderation_kwargs: dict[str, Any] | None = None,
        link_moderation: bool = True,
        devices: bool = False,
        chat_devices: Any = None,
        push: Any = None,
        chat_config: Any = None,
        hub_kwargs: dict[str, Any] | None = None,
        storage: Any = None,
    ) -> Env:
        db_path = tmp_path / f"comms_{len(clients)}.db"
        sync_engine = create_engine(f"sqlite:///{db_path}")
        CommsBase.metadata.create_all(sync_engine)
        sync_engine.dispose()

        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", connect_args={"timeout": 30})
        engines.append(engine)
        session_factory = async_sessionmaker(engine)  # expire_on_commit=True on purpose

        recording = RecordingPush()
        hub = CommsHub(
            auth=JwtAuth(SECRET),
            session_factory=session_factory,
            users=StaticUserDirectory(PROFILES),
            push=push or recording,
            **(hub_kwargs or {}),
        )
        devices_feature = None
        if devices:
            from commskit.core.devices import DevicesFeature, SqlDeviceRegistry

            devices_feature = DevicesFeature(SqlDeviceRegistry(session_factory)).install(hub)
        chat_feature = call_feature = None
        if chat:
            from commskit.chat import ChatFeature

            chat_feature = ChatFeature(policy=chat_policy,
                                       storage=storage or LocalDiskStorage(str(tmp_path / "media")),
                                       devices=chat_devices(session_factory) if chat_devices else None,
                                       config=chat_config).install(hub)
        if call:
            from commskit.call import CallConfig, CallFeature

            call_feature = CallFeature(policy=call_policy, config=call_config or CallConfig()).install(hub)
        if (link if link is not None else (chat and call)):
            from commskit.integration import link_chat_and_call

            link_chat_and_call(chat_feature, call_feature)
        moderation_feature = None
        if moderation:
            from commskit.moderation import ModerationFeature

            moderation_feature = ModerationFeature(**(moderation_kwargs or {})).install(hub)
            if link_moderation:
                from commskit.integration import link_moderation as link_mod

                link_mod(moderation_feature, chat=chat_feature, call=call_feature)

        app = FastAPI()
        app.include_router(hub.ws_router())
        app.include_router(hub.rest_router())
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        hubs.append(hub)
        return Env(app=app, client=client, hub=hub, push=recording, chat=chat_feature, call=call_feature,
                   moderation=moderation_feature, devices=devices_feature)

    yield factory

    for client, hub, engine in zip(clients, hubs, engines):
        try:
            client.portal.call(hub.shutdown)  # cancel pending timers
            client.portal.call(engine.dispose)
        finally:
            client.__exit__(None, None, None)
