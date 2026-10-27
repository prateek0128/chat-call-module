# commskit backend: using, running and deploying

File 3 of 3. Previous: [keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md). Start: [overview](01-overview.md).

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Installing into an existing FastAPI project](#2-installing-into-an-existing-fastapi-project)
3. [Running locally from a clean machine](#3-running-locally-from-a-clean-machine)
4. [Deploying to a server](#4-deploying-to-a-server)
5. ["What do I need" checklist](#5-what-do-i-need-checklist)
6. [Go-live checklist](#6-go-live-checklist)

Verification legend: code samples that reuse names from the repo were checked against the code. Server configs (nginx, systemd, coturn, Docker, compose)
were **not run** in this repo; they are marked "untested". Anything involving real Redis, S3, PostgreSQL, coturn, APNs or Expo is
**not verified in this repo's tests** (the test suite uses SQLite and fakes).

---

## 1. Prerequisites

| Need | Version / detail | Source |
|---|---|---|
| Python | **3.11 or newer** (`requires-python = ">=3.11"`). The repo's own venv is 3.12.10 | `backend/backend-python/pyproject.toml` |
| FastAPI, SQLAlchemy 2 (async), PyJWT | `fastapi>=0.110`, `sqlalchemy[asyncio]>=2.0`, `pyjwt>=2.8` (installed automatically) | `pyproject.toml` |
| Async DB driver | `aiosqlite` (SQLite, dev) or `asyncpg` (PostgreSQL, production). Not installed by any extra | see file 2, A.2 |
| ASGI server | `uvicorn` (not in any extra: install it yourself) | demo uses it |
| Redis 5+ (optional) | Needed only for more than one worker/instance | `redis>=5.0` extra |
| S3 bucket (optional) | For production media storage | `s3` extra |
| coturn (optional but needed for mobile data calls) | Your own TURN server | file 2, A.3 |
| ffmpeg/ffprobe (optional) | Video thumbnails and audio/video duration | file 2, A.7 |
| Node.js (optional) | Only to run the web/Expo example clients | `examples/*/README.md` |
| Chrome (optional) | Only for `examples/backend/demo-server-python/ui_tests` | root `README.md` |

---

## 2. Installing into an existing FastAPI project

### 2.1 Get the package

The package is not published on PyPI (nothing in the repo says it is; `pyproject.toml` has no release metadata beyond version `0.1.0`). Install from the folder or from git.

From a local copy of the repo (editable, good while you develop):

```powershell
# Windows PowerShell, inside your project's activated venv
pip install -e "..\comms-kit\backend\backend-python"
pip install -e "..\comms-kit\backend\backend-python[redis,s3,push,apns,media]"
```

```bash
# Linux / macOS
pip install -e "../comms-kit/backend/backend-python"
pip install -e "../comms-kit/backend/backend-python[redis,s3,push,apns,media]"
```

From a git URL (pip supports `#subdirectory=` for a package that is not at the repo root; the URL below is a placeholder, and this form was **not tested here**):

```bash
pip install "commskit[redis,s3,push] @ git+https://github.com/YOUR-ORG/YOUR-REPO.git@v0.1.0#subdirectory=backend/backend-python"
```

In `requirements.txt` the same line works without the `pip install` and quotes. Pin a tag or commit.

Extras (all optional, combine as needed):

| Extra | Use it when |
|---|---|
| `redis` | more than one worker or server (`RedisBridge`, `RedisRateLimiter`) |
| `s3` | `S3Storage` (installs boto3 and Pillow) |
| `media` | image thumbnails with local storage (Pillow) |
| `push` | `ExpoPushSender`, `DevicePushRouter` (httpx) |
| `apns` | `ApnsVoipSender`, iOS CallKit VoIP pushes (httpx with HTTP/2, cryptography) |
| `dev` | running the kit's own tests |

Also install a database driver (`aiosqlite` or `asyncpg`) and `uvicorn`.

### 2.2 Order of operations (applies to all modes)

1. Create the async engine and `async_sessionmaker(engine, expire_on_commit=False)`.
2. Create the `CommsHub` with your auth adapter and session factory (and, optionally, `users=`, `push=`, `connections=`).
3. Install features: `ChatFeature(...).install(hub)`, `CallFeature(...).install(hub)`, `ModerationFeature(...).install(hub)`, `DevicesFeature(...).install(hub)`.
4. Link them: `link_chat_and_call`, then `link_moderation`.
5. **Only then** call `hub.ws_router()` and `hub.rest_router()` and include them in the app. `rest_router()` collects the routers of the features installed at that moment (`commskit/core/hub.py:163-167`); a feature installed later is missing.
6. In the app lifespan: create tables (dev only), `await hub.connections.start()`, and on shutdown `await hub.shutdown()` (plus `await push.aclose()` if you made a push router, and `await engine.dispose()`).

Installing the same feature twice raises `RuntimeError`.

### 2.3 Mode A: chat only

```python
# app/comms.py  (names verified against commskit/ ; secrets come from the environment)
import os
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from commskit.core import CommsHub, JwtAuth, LocalDiskStorage
from commskit.chat import ChatFeature

engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

hub = CommsHub(
    auth=JwtAuth(secret=os.environ["JWT_SECRET"]),     # or your own AuthAdapter, see 2.7
    session_factory=SessionLocal,
)
chat = ChatFeature(storage=LocalDiskStorage(root="/var/lib/myapp/media", base_url="/media")).install(hub)
```

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.comms import hub, engine

@asynccontextmanager
async def lifespan(_: FastAPI):
    await hub.connections.start()          # starts the Redis bridge if one is configured
    yield
    await hub.shutdown()
    await engine.dispose()

app = FastAPI(lifespan=lifespan)
app.include_router(hub.ws_router())        # /ws/{token}
app.include_router(hub.rest_router())      # /chats/...
```

`ChatFeature()` with no arguments uses `AllowAllChatPolicy` and `LocalDiskStorage("comms_media")` (relative to the working directory, and not served; see file 2, C.1).

### 2.4 Mode B: call only

```python
from commskit.call import CallConfig, CallFeature

hub = CommsHub(auth=JwtAuth(secret=os.environ["JWT_SECRET"]), session_factory=SessionLocal,
               users=MyUserDirectory(), push=my_push)      # names and push make calls usable
call = CallFeature(config=CallConfig(
    turn_secret=os.environ.get("TURN_SECRET"),
    turn_uris=["turn:turn.example.com:3478?transport=udp",
               "turns:turn.example.com:5349?transport=tcp"],
)).install(hub)
app.include_router(hub.ws_router())
app.include_router(hub.rest_router())      # /call/turn-credentials, /call/{id}/reject
```

Without chat, call frames carry `chat_id: null`, no chat message is written and no `call_log` frame is sent.

### 2.5 Mode C: chat + call (with moderation, devices and push)

```python
import os
from commskit.core import CommsHub, JwtAuth
from commskit.core.devices import DevicesFeature, SqlDeviceRegistry
from commskit.core.push import ApnsVoipSender, DevicePushRouter, ExpoPushSender
from commskit.chat import ChatFeature, ChatConfig
from commskit.call import CallConfig, CallFeature
from commskit.moderation import ModerationFeature
from commskit.integration import link_chat_and_call, link_moderation

devices = SqlDeviceRegistry(SessionLocal)
push = DevicePushRouter(
    devices,
    expo=ExpoPushSender(access_token=os.getenv("EXPO_ACCESS_TOKEN")),
    voip=ApnsVoipSender.from_env(),          # None unless the APNS_* variables are set
    android_call_style="data",               # default is "notification"
)

hub = CommsHub(auth=JwtAuth(secret=os.environ["JWT_SECRET"]), session_factory=SessionLocal,
               users=MyUserDirectory(), push=push)

DevicesFeature(devices).install(hub)                         # POST /devices, DELETE /devices/{id}, legacy token routes
chat = ChatFeature(policy=MyChatPolicy(), storage=my_storage, config=ChatConfig()).install(hub)
call = CallFeature(policy=MyCallPolicy(),
                   config=CallConfig(turn_secret=os.getenv("TURN_SECRET"), turn_uris=TURN_URIS)).install(hub)
link_chat_and_call(chat, call)               # chat_id, "[Call Initiated]" entry, call_log

async def on_report(report):                 # runs in the background; errors are logged
    ...                                      # notify your moderators

moderation = ModerationFeature(on_report=on_report).install(hub)
link_moderation(moderation, chat=chat, call=call)

# lifespan shutdown: await push.aclose(); await hub.shutdown()
```

Rules that matter:

- Do not combine `DevicesFeature` with `ChatFeature(devices=...)`; install only one (the kit skips chat's copy if `DevicesFeature` was installed first).
- `link_chat_and_call` and `link_moderation` require every feature to be on the same hub, and can be called once each (a second call raises).
- `ModerationFeature` alone does nothing to chat/call. `link_moderation` is what makes blocks enforced.
- `ModerationFeature(admin_dependency=...)` is required for the admin review routes (file 2, C.2).

### 2.6 Create the tables

All kit tables live on `CommsBase.metadata`, and a table is registered only when its module is imported. Import the features first, then create:

```python
from commskit.core import CommsBase
import commskit.chat, commskit.call, commskit.moderation, commskit.core.devices   # registers all tables

async with engine.begin() as conn:
    await conn.run_sync(CommsBase.metadata.create_all)
```

The tables are `chats`, `messages`, `calls`, `comms_devices`, `comms_blocks`, `comms_reports`, `comms_message_hidden`, `comms_chat_cleared` (file 1, section 6).

- **Name clash warning:** `chats`, `messages` and `calls` are plain generic names with no prefix option (`commskit/chat/models.py`, `call/models.py`). If your project already has tables with these names, `create_all` skips them and the kit will fail or misbehave on different columns. Check before you install. (These names are the Smart Matrimony originals on purpose.)
- `create_all` creates missing tables only; it never alters existing ones. In production use migrations. With Alembic you can point `target_metadata` at `CommsBase.metadata` after importing the modules (general Alembic practice; **not tested here**).
- **Manual upgrade note** (from `backend/backend-python/README.md`, "Admin report review", Upgrading): `comms_reports` gained `resolved_at`, `resolved_by`, `note`, and `reporter_id` / `reported_id` became nullable; `comms_message_hidden` and `comms_chat_cleared` are new tables. On a database created with an older version of the kit, `create_all` only adds the two new tables. Add the three columns by hand and drop NOT NULL on the two id columns:

```sql
ALTER TABLE comms_reports ADD COLUMN resolved_at TIMESTAMP, ADD COLUMN resolved_by VARCHAR(50), ADD COLUMN note TEXT;
-- PostgreSQL, for the two id columns:
ALTER TABLE comms_reports ALTER COLUMN reporter_id DROP NOT NULL;
ALTER TABLE comms_reports ALTER COLUMN reported_id DROP NOT NULL;
```

(The first statement is the README's, written in PostgreSQL syntax. The two `DROP NOT NULL` lines are my PostgreSQL translation of the README's sentence; not run.)

### 2.7 Auth wiring with your existing JWT

The kit needs one thing: given a token string, return the user id (or raise). The same adapter protects the WebSocket (token in the path) and all REST routes (`Authorization: Bearer`).

If your tokens are HS256 with the user id in a claim, use the built-in class (set `claim` to your claim name; the token must not have an `aud` claim, see file 2, A.1):

```python
JwtAuth(secret=os.environ["JWT_SECRET"], algorithm="HS256", claim="sub")
```

Otherwise write an adapter (sync or async; any exception means "invalid"):

```python
class HostAuth:
    def user_id_from_token(self, token: str) -> str:
        payload = decode_my_token(token)       # your existing function; raises when invalid or expired
        return str(payload["user_id"])

hub = CommsHub(auth=HostAuth(), session_factory=SessionLocal)
```

You can also reuse the kit's FastAPI dependency in your own routes: `Depends(hub.current_user)` returns the user id (401 otherwise).

### 2.8 Plugging policies (blocking, credits)

```python
from commskit.call import CallDecision

class MyChatPolicy:
    refusal_message = "You cannot message this user."

    async def can_message(self, session, sender_id, recipient_id) -> bool:
        return await my_rules.may_chat(session, sender_id, recipient_id)     # your tables

    async def block_status(self, session, viewer_id, other_ids):
        return {}                          # {other_id: (is_blocked, blocked_by_other)}; missing = (False, False)

    async def extra_conversation_info(self, session, viewer_id, other_id):
        return {"chat_consent_given": True}   # merged into res_messages.info

class MyCallPolicy:
    async def authorize(self, session, caller_id, receiver_id, message) -> CallDecision:
        if not await my_billing.has_credit(session, caller_id):
            return CallDecision.deny("Not enough credits.", status=402, info={"credit_balance": 0})
        return CallDecision.allow()
```

`CallPolicy.authorize` runs after busy detection and before the call row exists, so charging here does not charge for busy receivers. If you use moderation, the block list runs first and your policy second. Details: file 2, C.1.

### 2.9 Mounting order and route conflicts

The kit adds these top-level paths: `/ws/{token}`, `/chats/...`, `/call/...`, `/moderation/...`, `/devices...` (full list: file 2, B.4).

- If your app already has a `/ws/...` route or a `/chats/...`, `/devices` or `/call` router, **the one registered first wins** for the same method and path. Note that the kit's `GET /chats/{user_id}` matches any single path segment after `/chats/`, so it can shadow a host route like `GET /chats/archived` if the kit router is included first. Include your more specific routes first, or rename yours.
- The WebSocket path can be changed with `hub.ws_router(path="/realtime/{token}")`; the client must then connect to the same path (the Expo/web client's path configuration was not checked here).
- `include_router(hub.rest_router(), prefix="/comms")` would shift all REST URLs; clients would have to use the same prefix (not verified against the mobile/web clients).
- Include `hub.rest_router()` after all features are installed (2.2).

### 2.10 Middleware and cache pitfalls

General FastAPI/ASGI advice (not specific code in this repo; not tested here):

- **Response caching** middleware (for example `fastapi-cache`, Cloudflare page rules, CDN caches) must never cache `/chats/...`, `/call/...`, `/moderation/...` or `/devices...`. The responses are per user and depend on the `Authorization` header; a cache that ignores it can show one user's chat list to another.
- Custom ASGI middleware that assumes every request has `scope["type"] == "http"` can break the WebSocket route. Pass `websocket` scopes through untouched.
- Auth middleware that blocks requests without a header will reject `/ws/<token>` (browsers cannot set headers on WebSockets). Exempt `/ws/`.
- Request-logging or APM middleware records the URL: redact `/ws/` paths (file 2, A.11).
- Compression/GZip middleware is fine for REST; do not apply it to the WebSocket route.
- If you use `CORSMiddleware` for a web client on another origin, list exact origins. WebSocket connections are not subject to CORS, and the kit does not check the `Origin` header (no origin check found in `commskit/core/websocket.py`); the token in the path is the only protection.

### 2.11 Server-side helpers you may need

- `await chat.send_message_as("U1", "U2", "hello")` and `await chat.send_system_message("U2", "You matched with Asha", about_user_id="U1")` send messages from your own code.
- `await commskit.integration.delete_user_everywhere(hub, user_id)` in your delete-account flow.
- `hub.events.on("call.finalized", fn)` and other events (file 1, section 5; list in `commskit/core/events.py`).

---

## 3. Running locally from a clean machine

This runs the **demo server** (`examples/backend/demo-server-python/demo_server.py`): SQLite, three fixed users, tokens handed to anyone. Development only.

### 3.1 Install and test

```powershell
# Windows PowerShell
git clone <your-repo-url> comms-kit
cd comms-kit\backend\backend-python
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1                  # if blocked: Set-ExecutionPolicy -Scope Process Bypass
python -m pip install -e ".[dev,redis,push,apns,media]"
python -m pip install uvicorn
python -m pytest -q tests                   # expect: 130 passed (as of 2026-10-26)
```

```bash
# Linux / macOS
git clone <your-repo-url> comms-kit
cd comms-kit/backend/backend-python
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev,redis,push,apns,media]"
python -m pip install uvicorn
python -m pytest -q tests                   # expect: 130 passed (as of 2026-10-26)
```

`python3.11` or newer works. The test run takes about a minute. The `redis` extra is only needed if you want to experiment with `RedisBridge`; the demo does not use it.

### 3.2 Start the demo server

Run from the `examples/backend/demo-server-python` folder, using the backend's venv (the module is `demo_server:app`):

```powershell
# Windows PowerShell
cd ..\..\examples\backend\demo-server-python     # from backend\backend-python\
..\..\..\backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app --reload --port 8000
# chat only:  $env:COMMS_FEATURES="chat"; ..\..\..\backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app --reload --port 8000
```

```bash
# Linux / macOS
cd ../../examples/backend/demo-server-python      # from backend/backend-python/
../../../backend/backend-python/.venv/bin/python -m uvicorn demo_server:app --reload --port 8000
# chat only:  COMMS_FEATURES=chat ../../../backend/backend-python/.venv/bin/python -m uvicorn demo_server:app --reload --port 8000
```

`COMMS_FEATURES` values: `chat`, `call`, `chat,call` (default). In PowerShell the variable stays set for that window; clear it with `Remove-Item Env:COMMS_FEATURES`.

### 3.3 Test with two users in the browser

1. Open `http://localhost:8000/#U1` in one tab (Alice) and `http://localhost:8000/#U2` in a second tab or another browser (Bob). `#U1:U2` opens the chat with Bob directly. `U3` is Carol.
2. Send messages, files (max 10 MB), try typing, read ticks.
3. For a call: press the phone button in one tab, **Accept** in the other, allow the microphone. Use headphones, or the two tabs echo.
4. The `</>` button shows every WebSocket frame.
5. The **Chat / Calls / Both** switch on the page (or `?mode=chat|call|both`) only offers what the server runs.

Microphone access works only on `localhost` or HTTPS. For two devices on a LAN, start with `--host 0.0.0.0` and open `http://<PC-IP>:8000` (chat works; calls need HTTPS, for example a tunnel). The root `README.md` ("Test it locally") has the full list.

### 3.4 Web and Expo example clients

- Web (React): [`examples/web-app/README.md`](../../../examples/web-app/README.md). Start the demo server with `COMMS_FEATURES=chat`, then `cd examples/web-app && npm install && npm run dev` (`http://localhost:5173`, a Vite proxy talks to the server, so no CORS setup).
  If the web app is hosted separately without the proxy, set `COMMS_CORS_ORIGINS="http://localhost:5173"` on the server.
- Expo (phones): [`examples/expo-app/README.md`](../../../examples/expo-app/README.md). Start the server with `--host 0.0.0.0 --port 8000` and sign in with `http://<your-PC-LAN-IP>:8000`. Needs a development build (not Expo Go).
- Other example docs for the kit live in [`docs/example/`](../../example/) if that folder has been filled in by the time you read this (it was empty when this file was written).

### 3.5 Where data lives, and how to reset

| What | Where |
|---|---|
| Database | `examples/backend/demo-server-python/.demo_data/demo.db` (SQLite) |
| Uploaded files | `examples/backend/demo-server-python/.demo_data/media/` |
| Change the folder | `COMMS_DEMO_DATA=<folder>` |

Reset: stop the server, delete the folder, start again (tables are recreated on startup).

```powershell
Remove-Item -Recurse -Force examples\backend\demo-server-python\.demo_data   # from comms-kit\
```

```bash
rm -rf examples/backend/demo-server-python/.demo_data    # from comms-kit/
```

The folder is git-ignored.

### 3.6 Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `ModuleNotFoundError: demo_server` or `commskit` | Start the demo from `comms-kit/examples/backend/demo-server-python` with the backend venv's Python (`..\..\..\backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app`); the package must be installed in that venv (`pip install -e .` in `backend/`) |
| `No module named uvicorn` / `aiosqlite` / `asyncpg` | Not installed by default. `pip install uvicorn` (and the driver, `aiosqlite` is in `[dev]`) |
| Port already in use (`[Errno 10048]` / `Address already in use`) | Use `--port 8001`, or find the process: PowerShell `Get-NetTCPConnection -LocalPort 8000`, bash `lsof -i :8000` |
| `Activate.ps1 cannot be loaded` | `Set-ExecutionPolicy -Scope Process Bypass` in that window |
| WebSocket closes at once with code **1008** | The token was rejected: wrong secret, expired `exp`, missing claim (default `uid`), or it has an `aud` claim. The reason is logged by logger `commskit.ws` at INFO level ("WS auth failed: ..."), which you only see if logging is set to INFO (`logging.basicConfig(level=logging.INFO)`) |
| WebSocket closes with **1011** | Server error in the socket loop; check the server log |
| `ValueError: JwtAuth needs a non-empty secret` | `JWT_SECRET` (or your variable) is not set |
| REST `401 Not authenticated` / `Invalid token` | Missing `Authorization: Bearer <token>` header, or bad token |
| REST `403 Not allowed` on `/chats/{user_id}` | The path user id is not the token's user (only your own list is allowed) |
| REST `404 Chat not found` | The chat does not exist or you are not a participant |
| REST `422` | Missing field: `candidate_id` (query) on `/chats/start`; `candidate_user_id` and `content` on `/chats/send`; `reason` on `/moderation/reports`; `device_id` / `platform` (ios, android, web) on `/devices` |
| REST `429` | Rate limit; see the `Retry-After` header. Limits: file 2, A.9 |
| `503 TURN is not configured` on `/call/turn-credentials` | `CallConfig.turn_secret` is not set |
| Browser CORS error | Only for a web client on another origin: set `COMMS_CORS_ORIGINS` in the demo, or add `CORSMiddleware` with exact origins in your app. WebSockets are not blocked by CORS |
| `database is locked` (SQLite) | SQLite allows one writer. The demo sets a 30 s timeout. Do not use SQLite for real load; use PostgreSQL |
| `no such table: chats` (or `relation "chats" does not exist`) | Tables not created. Import the feature modules, then run `CommsBase.metadata.create_all` (2.6) |
| `RuntimeError: Feature 'chat' is already installed` | Feature installed twice on one hub |
| Messages saved but not live, or users seem offline, with several workers | No Redis bridge. Run one worker, or configure `RedisBridge` (file 2, B.5) |
| Uploaded image links give 404 | `LocalDiskStorage` does not serve files. Mount the folder (the demo mounts `/media`) or use S3 |
| "File too large" | Over `ChatConfig.max_upload_bytes` (10 MiB) |
| No push notifications | Default `NoopPush` sends nothing. Configure `DevicePushRouter`; the device must have registered a token (`POST /devices`) |
| Call connects on Wi-Fi, not on mobile data | No TURN. Set up coturn and `TURN_SECRET` / `TURN_URIS` |
| Microphone permission never appears | Browsers allow the microphone only on `localhost` or HTTPS |
| Demo page shows old code after editing | The demo serves files with `no-cache`; do a normal reload |

---

## 4. Deploying to a server

### 4.1 What hosting works

You need a **long-running process that accepts WebSocket connections** and keeps state in memory between requests.

- Works: a VPS (Ubuntu), a container platform with persistent processes (Render web service, Railway, Fly.io, ECS, Kubernetes, a plain Docker host).
- Does **not** work: serverless functions with short timeouts and no persistent sockets (Vercel serverless functions, AWS Lambda, Netlify functions, Cloudflare Workers running the Python code). They cannot hold `/ws/<token>` open or run the call timers.
- Static front-ends (web app) can sit on any static host; only the API process needs the above.

Recommended starting stack (a suggestion, not a requirement in the repo): one Ubuntu 22.04/24.04 VPS or one PaaS web service + managed PostgreSQL + (when scaling) managed Redis + S3 + a **separate small VM for coturn** (it needs a public IP and a UDP port range).

### 4.2 Production app skeleton

Your project's `app/main.py` (not part of the kit). Mode C wiring from 2.5 plus a health route and no demo endpoints:

```python
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy import text
from app.comms import hub, engine          # your module from section 2

logging.basicConfig(level=logging.INFO)    # makes commskit.* logs visible

@asynccontextmanager
async def lifespan(_: FastAPI):
    await hub.connections.start()
    yield
    await hub.shutdown()
    await engine.dispose()

app = FastAPI(lifespan=lifespan)
app.include_router(hub.ws_router())
app.include_router(hub.rest_router())

@app.get("/healthz")                       # the kit has no health route (verified); add your own
async def healthz():
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"ok": True}
```

Do not run `create_all` at startup in production once you have migrations.

### 4.3 Environment file template

Save as `.env.example` in your project; copy to the server as `/etc/myapp/comms.env` (mode 600) and fill in. All values are dummies. Your code must read these (the kit itself reads only `APNS_*`, `FFMPEG_PATH`, `FFPROBE_PATH`, `HOSTNAME`; file 2, A.0).

```ini
# --- required ---
DATABASE_URL=postgresql+asyncpg://comms:CHANGE_ME@127.0.0.1:5432/comms
JWT_SECRET=CHANGE_ME_64_HEX_CHARS

# --- several workers or servers ---
REDIS_URL=redis://:CHANGE_ME@127.0.0.1:6379/0

# --- media (S3 via boto3's default credential chain) ---
S3_BUCKET=my-app-chat-media
AWS_DEFAULT_REGION=ap-south-1
# AWS_ACCESS_KEY_ID=AKIADUMMYDUMMY0000        # not needed on AWS with an IAM role
# AWS_SECRET_ACCESS_KEY=CHANGE_ME

# --- calls ---
TURN_SECRET=CHANGE_ME_64_HEX_CHARS
TURN_URIS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp

# --- push ---
EXPO_ACCESS_TOKEN=CHANGE_ME
APNS_KEY_PATH=/etc/myapp/AuthKey_ABC123DEFG.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_BUNDLE_ID=com.example.myapp
# APNS_USE_SANDBOX=1                          # only for development builds

# --- optional ---
# FFMPEG_PATH=/usr/bin/ffmpeg
# FFPROBE_PATH=/usr/bin/ffprobe
```

Generate secrets: `python -c "import secrets; print(secrets.token_hex(32))"` (works in PowerShell and bash).
Add `.env` to `.gitignore`. Do not use the demo variables (`COMMS_*`) in production.

### 4.4 PostgreSQL

```bash
sudo apt install postgresql
sudo -u postgres psql -c "CREATE USER comms WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE comms OWNER comms;"
```

URL for the app: `postgresql+asyncpg://comms:CHANGE_ME@127.0.0.1:5432/comms` (install `asyncpg`). For a managed database add TLS parameters as your provider documents (asyncpg uses `ssl=require`-style options; check the provider docs, not verified here).
Create tables with migrations (2.6). A first-time setup can run `create_all` once from a one-off script.
Tune the SQLAlchemy pool (`pool_size`, `max_overflow`) so that workers times pool size stays below Postgres `max_connections`.
PostgreSQL is **not verified in this repo's tests**.

### 4.5 Redis

Needed only for more than one worker/instance (file 2, B.5).

```bash
sudo apt install redis-server           # then set 'requirepass' and 'bind 127.0.0.1' in /etc/redis/redis.conf
```

In code: `CommsHub(..., connections=ConnectionManager(bridge=RedisBridge(url=os.environ["REDIS_URL"])), rate_limiter=RedisRateLimiter(bridge))`, with `hub.connections.start()` in the lifespan.
Remember: if Redis is down at startup, the kit only logs a warning and runs single-worker. Alert on the log line `Redis unavailable`.
Not verified against a real Redis in this repo's tests.

### 4.6 S3 bucket

- Create a **private** bucket, turn on "Block all public access" and default encryption (SSE).
- Use `S3Storage("my-app-chat-media", region="ap-south-1", prefix="prod", private=True)`. The default is `private=False`, which produces public-style URLs that will not work on a private bucket (file 2, A.6).
- Give the app an IAM role (or user) with this minimal policy (derived from the S3 calls the code makes; not tested against real S3):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::my-app-chat-media/prod/*"
  }]
}
```

- Presigned URLs are stored at upload time and last at most 7 days; plan to refresh them with `storage.presign(url)` when you return messages (file 2, C.4).
- Add a lifecycle rule that matches your retention policy.

### 4.7 TURN server (coturn)

Needed for calls over mobile data and strict networks. Run it on its own VM with a public IP.

```bash
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf` (untested sample; replace the placeholders):

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=CHANGE_ME_SAME_AS_TURN_SECRET   # must equal CallConfig.turn_secret / TURN_SECRET
realm=turn.example.com
server-name=turn.example.com
external-ip=203.0.113.10                           # public IP (use PUBLIC/PRIVATE if behind NAT)
min-port=49152
max-port=65535
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
total-quota=200
no-cli
```

Firewall (ufw example):

```bash
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp && sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

In the API: `TURN_SECRET` = the same string as `static-auth-secret`; `TURN_URIS` = `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`.
The clients fetch temporary credentials from `POST /call/turn-credentials`. Test with a client on mobile data, or with the "Trickle ICE" page in a browser using a relay-only test. Not verified in this repo.

### 4.8 TLS, HTTPS and WSS (nginx + certbot)

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

Then use the server block in file 2, section B.6 (WebSocket upgrade, long `proxy_read_timeout`) and the redacted access log in file 2, A.11. Browsers and apps then use `https://api.example.com` and `wss://api.example.com/ws/<token>`. Certbot renews automatically via a systemd timer or cron (check with `sudo certbot renew --dry-run`).

### 4.9 Process manager

Run uvicorn directly behind nginx. With no Redis use **exactly one worker**; with Redis you may use more.

`/etc/systemd/system/myapp.service` (untested sample):

```ini
[Unit]
Description=My app with commskit
After=network.target postgresql.service

[Service]
User=myapp
Group=myapp
WorkingDirectory=/srv/myapp
EnvironmentFile=/etc/myapp/comms.env
ExecStart=/srv/myapp/.venv/bin/uvicorn app.main:app \
    --host 127.0.0.1 --port 8000 --workers 1 \
    --proxy-headers --forwarded-allow-ips=127.0.0.1 \
    --no-access-log
Restart=always
RestartSec=3
LimitNOFILE=65535
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now myapp
journalctl -u myapp -f
```

- `--no-access-log` keeps the token out of uvicorn's log (file 2, A.11); nginx logs requests with the redacted format.
- `--workers N` (N above 1) only with Redis. `--ws-max-size` only if you raised the upload limit above about 12 MB.
- `LimitNOFILE` matters: every open WebSocket is a file descriptor.
- Gunicorn with a uvicorn worker class also works in general; it was not tried here and is not needed.
- Restarting the process drops all sockets; clients reconnect. A call ringing in a restarted worker loses its ring timer (file 2, B.5).

### 4.10 Docker (untested)

`Dockerfile` for **your** app, with a copy of this repo's `backend/backend-python/` folder in the build context (adjust paths):

```dockerfile
FROM python:3.12-slim
WORKDIR /srv
# optional: ffmpeg for video thumbnails / durations
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY vendor/commskit-backend /tmp/commskit-backend
RUN pip install --no-cache-dir "/tmp/commskit-backend[redis,s3,push,apns,media]" uvicorn asyncpg
COPY app ./app
RUN useradd -r app && chown -R app /srv
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-access-log"]
```

`docker-compose.yml` (untested; nginx/TLS and coturn are not included):

```yaml
services:
  app:
    build: .
    env_file: .env                 # see 4.3; set DATABASE_URL host to "db" and REDIS_URL host to "redis"
    depends_on: [db, redis]
    ports: ["8000:8000"]           # put nginx or your platform's router in front for TLS
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: comms
      POSTGRES_PASSWORD: CHANGE_ME
      POSTGRES_DB: comms
    volumes: [dbdata:/var/lib/postgresql/data]
  redis:
    image: redis:7
    command: ["redis-server", "--requirepass", "CHANGE_ME"]
volumes:
  dbdata:
```

If you use `LocalDiskStorage` in a container, mount a volume for its folder (it writes relative to the working directory by default). Prefer S3.
The `pip install` of the package path relies on `pyproject.toml` with `packages.find include = ["commskit*"]` (verified); the rest is untested.

### 4.11 Logging and redaction

- Logger names used by the kit: `commskit.ws`, `commskit.hub`, `commskit.connections`, `commskit.redis`, `commskit.call`, `commskit.push`/`commskit.devices`, `commskit.s3`, `commskit.media`, `commskit.events`, `commskit.ratelimit`. Set `logging.basicConfig(level=logging.INFO)` or your own config; by default INFO messages are not shown.
- Redact `/ws/<token>` in every access log (file 2, A.11).
- Do not log message contents; the kit does not log them (it logs errors and exceptions).
- Use `CommsHub(on_handler_error=...)` to forward handler exceptions to your error tracker.

### 4.12 Scaling to multiple workers or servers

1. Install the `redis` extra, create `RedisBridge(url=...)`, pass `ConnectionManager(bridge=bridge)` and `RedisRateLimiter(bridge)` into `CommsHub`.
2. `await hub.connections.start()` in the lifespan; `await hub.shutdown()` on exit.
3. Raise `--workers` or add instances behind the load balancer. No sticky sessions needed.
4. Remember the in-process call timers (file 2, B.5) and that the per-worker `server_id` uses `HOSTNAME` + pid.
5. Load-test before launch (not done in this repo).

### 4.13 Backups and monitoring

| Topic | Suggestion |
|---|---|
| Database | Automated daily backups plus point-in-time recovery if your provider offers it; run a restore test. This is where chats, messages and calls live |
| Media | S3 versioning or cross-region replication if the files matter |
| Redis | Holds only presence, pub/sub and rate-limit buckets; no backup needed |
| Secrets | Keep a copy of `JWT_SECRET`, `TURN_SECRET` and the APNs `.p8` in your secret manager (the `.p8` can be downloaded from Apple only once) |
| Health | Uptime check on `/healthz` (your route, 4.2) |
| Logs | journald or your platform logs; alert on `Redis unavailable`, `Handler for ... failed`, `Push to ... failed`, `Background task failed` (messages found in the code) |
| Errors | `on_handler_error` to Sentry or similar |
| Capacity | Watch open file descriptors, DB connections, memory (each socket and in-memory bucket costs RAM) |
| TURN | coturn logs and bandwidth; quotas in `turnserver.conf` |
| Push | Check logs after testing with an uninstalled app: invalid tokens should be removed |

---

## 5. "What do I need" checklist

| Item | Local (minimum) | Production | Why | Where to get it |
|---|---|---|---|---|
| Python 3.11+ | Required | Required | Runs the code | python.org, or your OS packages |
| Package install | `pip install -e backend/backend-python[dev]` | `pip install` of the package with needed extras | The kit | file 2 / section 2 |
| ASGI server (`uvicorn`) | Required | Required | Serves HTTP and WebSocket | `pip install uvicorn` |
| Database | SQLite + `aiosqlite` | PostgreSQL + `asyncpg`, backups | Chats, messages, calls | Managed Postgres or your VPS |
| `JWT_SECRET` (or own `AuthAdapter`) | Demo secret (dev only) | Your real secret, in a secret manager | Validates user tokens | Your login system; `python -c "import secrets; print(secrets.token_hex(32))"` |
| Login endpoint that issues tokens | Demo `/dev/token/{id}` | Your own | The kit does not log anyone in | Your app |
| `UserDirectory` | Demo `StaticUserDirectory` | Your own | Names and avatars | Your user table |
| Policies (`ChatPolicy`, `CallPolicy`) | Allow-all | Your rules (blocking, credits) | Who may talk or call | Your product logic |
| Reverse proxy + TLS | Not needed (`localhost`) | nginx or platform router, certbot | `wss://`, browser mic needs HTTPS | Let's Encrypt |
| Redis | Not needed | Needed for more than 1 worker/instance | Cross-worker delivery and presence | Managed Redis or your VPS |
| Media storage | `LocalDiskStorage` (demo mounts it) | S3 `private=True` | Files and thumbnails | AWS S3 + IAM role |
| TURN server | Not needed on one LAN | coturn + `TURN_SECRET` + `TURN_URIS` | Calls over mobile data / NAT | Own VM, coturn |
| Device registration + Expo push | Optional | `SqlDeviceRegistry`, `ExpoPushSender`, `EXPO_ACCESS_TOKEN` | Notifications when the app is closed | expo.dev |
| APNs VoIP key | Optional (iOS CallKit) | `.p8`, key id, team id, bundle id | Ringing on a closed iPhone | Apple Developer account |
| Moderation hook (`on_report`) and admin auth | Prints | Notify a real queue; `admin_dependency` | App-store rules on user-generated content | Your ops |
| Migrations | `create_all` | Alembic or similar | Safe schema changes | Alembic |
| Health check, logging, redaction, error tracking | Not needed | Required | Operations and privacy | Sections 4.2, 4.11 |
| Account deletion flow | n/a | `delete_user_everywhere` | Privacy and store requirements | Your app |

---

## 6. Go-live checklist

Short version of the go-live steps.

- [ ] `examples/backend/demo-server-python/demo_server.py` and `/dev/token/{id}` are not deployed.
- [ ] `JWT_SECRET` is a fresh random value; tokens have a short `exp`.
- [ ] No secrets in git or in client bundles (file 2, A.11).
- [ ] HTTPS and WSS work; proxy timeouts at least 120 s; `/ws/<token>` redacted from logs.
- [ ] PostgreSQL with backups and a tested restore; tables created by migrations; no table-name clash with `chats`, `messages`, `calls`.
- [ ] `S3Storage(private=True)` with a private bucket and minimal IAM; the presigned-URL expiry is handled.
- [ ] Redis configured and monitored if more than one worker; otherwise exactly one worker.
- [ ] coturn reachable on 3478/5349 and the relay port range; `TURN_SECRET` matches; a call works on mobile data.
- [ ] Push works end to end: Expo token registered, a message push arrives, an incoming-call push arrives (iOS VoIP only if APNs is set up).
- [ ] Policies implemented (blocking, credits, consent) instead of allow-all.
- [ ] `on_report` goes to a monitored place; admin review route protected; you review reports in time.
- [ ] Account deletion calls `delete_user_everywhere`; a retention job clears call SDP/ICE data.
- [ ] Health check route, error tracking and log alerts in place.
- [ ] Load test with realistic socket counts (not done in this repo).
- [ ] Privacy policy and store paperwork completed for your app.

Not verified in this repo's tests: real Redis, real S3, PostgreSQL, coturn, APNs, Expo, nginx, systemd, Docker.
