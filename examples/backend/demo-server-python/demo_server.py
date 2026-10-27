"""Local demo server for the comms kit. DEV ONLY - it hands out tokens to anyone.

Run from the comms-kit folder (it uses the Python backend's virtualenv, where commskit is installed):
    backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --reload --port 8000     (Windows)
    backend/backend-python/.venv/bin/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --reload --port 8000   (Linux / macOS)
then open http://localhost:8000 in two browser tabs (one per user).

The page is demo.html + demo.css + demo.js (+ demo-call.js, loaded only when the call feature is on).
UI tests: examples/backend/demo-server-python/ui_tests (see the repo README, "Test it locally").

COMMS_FEATURES picks the mode: "chat,call" (default), "chat" or "call".
COMMS_DEMO_DATA moves the SQLite db + uploaded files (default examples/backend/demo-server-python/.demo_data).

Phones (examples/expo-app) also use these, all optional:
  devices + push    always on: POST /devices; pushes go through Expo (EXPO_ACCESS_TOKEN optional).
  ANDROID_CALL_STYLE  "data" (default: the app shows its own full-screen call) or "notification".
  APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_USE_SANDBOX=1
                    iOS VoIP push (CallKit when the app is closed). Without them iOS gets a normal push.
  TURN_SECRET, TURN_URIS (comma-separated)
                    coturn REST credentials so calls work across networks (mobile data).
  moderation        always on: report & block (WS + /moderation REST).
  COMMS_CORS_ORIGINS  comma-separated origins allowed by CORS (only for a web client that does not use a proxy).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

import jwt
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from commskit.core import CommsBase, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, UserProfile

HERE = Path(__file__).parent
DATA = Path(os.environ.get("COMMS_DEMO_DATA", HERE / ".demo_data"))
DATA.mkdir(parents=True, exist_ok=True)

SECRET = os.environ.get("COMMS_DEMO_SECRET", "local-demo-secret-change-me-0000")
FEATURES = {f.strip() for f in os.environ.get("COMMS_FEATURES", "chat,call").split(",") if f.strip()}

USERS = {
    "U1": UserProfile(name="Alice", avatar=None),
    "U2": UserProfile(name="Bob", avatar=None),
    "U3": UserProfile(name="Carol", avatar=None),
}

engine = create_async_engine(f"sqlite+aiosqlite:///{DATA / 'demo.db'}", connect_args={"timeout": 30})
session_factory = async_sessionmaker(engine, expire_on_commit=False)

# Devices + push: Expo for everything; iOS VoIP only when the APNS_* variables are set.
from commskit.core.devices import DevicesFeature, SqlDeviceRegistry
from commskit.core.push import ApnsVoipSender, DevicePushRouter, ExpoPushSender

devices = SqlDeviceRegistry(session_factory)
push = DevicePushRouter(
    devices,
    expo=ExpoPushSender(access_token=os.environ.get("EXPO_ACCESS_TOKEN")),
    voip=ApnsVoipSender.from_env(),
    android_call_style=os.environ.get("ANDROID_CALL_STYLE", "data"),
)

hub = CommsHub(auth=JwtAuth(SECRET), session_factory=session_factory, users=StaticUserDirectory(USERS), push=push)
DevicesFeature(devices).install(hub)

chat = call = None
if "chat" in FEATURES:
    from commskit.chat import ChatFeature

    from commskit.chat import ChatConfig
    from commskit.core import RateLimit

    # Generous limits: the UI tests drive one shared server hard (e.g. 70 messages in a burst).
    chat = ChatFeature(storage=LocalDiskStorage(root=str(DATA / "media"), base_url="/media"),
                       config=ChatConfig(message_rate=RateLimit(200, 10), upload_rate=RateLimit(60, 60),
                                         typing_rate=RateLimit(60, 5))).install(hub)
if "call" in FEATURES:
    from commskit.call import CallConfig, CallFeature

    turn_uris = [u.strip() for u in os.environ.get("TURN_URIS", "").split(",") if u.strip()]
    call = CallFeature(config=CallConfig(turn_secret=os.environ.get("TURN_SECRET") or None, turn_uris=turn_uris,
                                         initiate_rate=None)).install(hub)
if chat and call:
    from commskit.integration import link_chat_and_call

    link_chat_and_call(chat, call)

# Report & block, wired into whichever of chat / call is running.
from commskit.integration import link_moderation
from commskit.moderation import ModerationFeature


async def _on_report(report) -> None:
    print(f"[demo] report {report}", flush=True)  # a real app would notify its moderators


moderation = ModerationFeature(on_report=_on_report).install(hub)
link_moderation(moderation, chat=chat, call=call)


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(CommsBase.metadata.create_all)
    yield
    await push.aclose()
    await engine.dispose()


app = FastAPI(title="comms kit demo", lifespan=lifespan)
# Optional: a separately hosted web client (examples/web-app without its dev proxy) needs CORS.
# COMMS_CORS_ORIGINS="http://localhost:5173,http://localhost:4173" (comma-separated; unset = off).
_cors = [o.strip() for o in os.environ.get("COMMS_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(CORSMiddleware, allow_origins=_cors, allow_methods=["*"], allow_headers=["*"])
app.include_router(hub.ws_router())
app.include_router(hub.rest_router())
(DATA / "media").mkdir(exist_ok=True)
app.mount("/media", StaticFiles(directory=DATA / "media"), name="media")


@app.get("/dev/users")
async def dev_users() -> dict:
    return {"features": sorted(FEATURES), "users": [{"id": uid, "name": p.name} for uid, p in USERS.items()]}


@app.get("/dev/token/{user_id}")
async def dev_token(user_id: str) -> dict:
    if user_id not in USERS:
        raise HTTPException(404, "unknown demo user")
    return {"token": jwt.encode({"uid": user_id}, SECRET, algorithm="HS256")}


# The demo page and its assets. An explicit allow-list (not a StaticFiles mount of this folder), so
# demo_server.py and .demo_data are never served. no-cache: edits show up on a plain reload.
PAGE_FILES = {
    "demo.html": "text/html; charset=utf-8",
    "demo.css": "text/css; charset=utf-8",
    "demo.js": "text/javascript; charset=utf-8",
    "demo-call.js": "text/javascript; charset=utf-8",  # loaded by demo.js only when "call" is enabled
}
NO_CACHE = {"Cache-Control": "no-cache"}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(HERE / "demo.html", media_type=PAGE_FILES["demo.html"], headers=NO_CACHE)


def _asset_route(name: str):
    async def asset() -> FileResponse:
        return FileResponse(HERE / name, media_type=PAGE_FILES[name], headers=NO_CACHE)

    return asset


for _name in PAGE_FILES:
    app.add_api_route(f"/{_name}", _asset_route(_name), methods=["GET"], include_in_schema=False)
