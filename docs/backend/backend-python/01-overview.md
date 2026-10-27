# commskit backend: overview

Folder: `comms-kit/backend/backend-python`. Python package name: `commskit` (version `0.1.0`, `backend/backend-python/pyproject.toml`).

This is file 1 of 3.
File 2: [keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md).
File 3: [using, running and deploying](03-using-running-and-deploying.md).

## Contents

1. [What it is](#1-what-it-is)
2. [Why the app needs it](#2-why-the-app-needs-it)
3. [Folder and module map](#3-folder-and-module-map)
4. [Three usage modes and the dependency rule](#4-three-usage-modes-and-the-dependency-rule)
5. [Main concepts](#5-main-concepts)
6. [Data it stores](#6-data-it-stores)
7. [How clients talk to it](#7-how-clients-talk-to-it)
8. [What it does NOT do](#8-what-it-does-not-do)
9. [Test status](#9-test-status)

Everything here was checked against the code in `backend/backend-python/commskit` and `docs/archive/PROTOCOL.md`.
Anything not checked is marked "not verified".

---

## 1. What it is

A Python library (not a standalone service) that you install into a FastAPI app. It adds:

- 1:1 chat (text, files, replies, read receipts, typing, delete/unsend/clear).
- Voice/video call signalling for WebRTC (the server relays offers, answers and ICE candidates).
- Report and block.
- Device registration and push notifications (Expo for everyone, APNs VoIP for iOS CallKit).

Requirements, from `backend/backend-python/pyproject.toml`: Python `>=3.11`, `fastapi>=0.110`, `sqlalchemy[asyncio]>=2.0`, `pyjwt>=2.8`.
It speaks the wire protocol in [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). It was extracted from the Smart Matrimony
backend (`matrimonial-backend-v2`), so old clients of that app still work.

## 2. Why the app needs it

The mobile/web client packages (`mobile/`, `web/`) are only the user interface and the client side of the protocol.
They cannot work alone, because a phone cannot talk to another phone directly without a server in the middle.
The backend gives the clients these things:

| Need | What the backend does |
|---|---|
| Real-time delivery | Keeps one WebSocket per device (`/ws/<token>`), pushes new messages, typing, read receipts and presence to the right users. |
| Storage | Saves chats, messages and call records in your SQL database; saves uploaded files through a storage adapter (disk or S3). |
| Call signalling | Creates the call, relays `sdp_offer` / `sdp_answer` / `ice_candidate`, rings, times out, ends, writes the call log. |
| TURN credentials | Hands out short-lived coturn credentials (`POST /call/turn-credentials`) so calls connect across networks. |
| Push | When the other user is offline or the app is in the background, sends an Expo push (and an APNs VoIP push for incoming iOS calls). |
| Moderation | Stores blocks and reports, enforces blocks in chat and calls, lets an admin review reports. |

Without it: no messages between devices, no ringing, no push, no history.

## 3. Folder and module map

```
comms-kit/backend/backend-python/
  pyproject.toml          package metadata, dependencies, extras, pytest config
  README.md               the original backend reference (long; this docs set builds on it)
  commskit/               the package
    __init__.py           __version__ = "0.1.0"
    core/                 transport, auth, adapters, hub, events, devices, push (always needed)
    chat/                 1:1 chat feature
    call/                 call signalling feature
    moderation/           block + report feature
    integration/          glue that needs more than one feature
  tests/                  pytest suite (SQLite, no network)
  (the demo server now lives outside this folder: ../../examples/backend/demo-server-python/)
```

### 3.1 `commskit/core` (always imported)

| Module | What it does | Main exports |
|---|---|---|
| `hub.py` | `CommsHub`: registry of WebSocket handlers, hooks, event bus, routers. The object you create first. | `CommsHub` |
| `websocket.py` | The single `/ws/{token}` endpoint (accept, auth, receive loop). | built by `hub.ws_router()` |
| `connections.py` | `ConnectionManager`: sockets per user, presence, rooms, fan-out, optional cross-worker bridge. | `ConnectionManager`, `PresenceBridge`, `USER_ROLE` |
| `adapters.py` | The interfaces you implement (`AuthAdapter`, `UserDirectory`, `PushSender`, `MediaStorage`, `DeviceRegistry`) and the defaults. | `JwtAuth`, `AuthError`, `NullUserDirectory`, `StaticUserDirectory`, `UserProfile`, `NoopPush`, `LocalDiskStorage`, `MediaInfo`, `bearer_dependency`, `delete_media` |
| `events.py` | Small in-process async event bus. | `EventBus` |
| `db.py` | The SQLAlchemy base class that owns every kit table, plus the DB-clock helper. | `CommsBase`, `db_now` |
| `ratelimit.py` | Per-user token-bucket limits, in memory or in Redis. | `RateLimit`, `RateLimiter`, `RedisRateLimiter` |
| `redis_bridge.py` | Optional Redis presence and cross-worker delivery. Imported only when you use it. | `RedisBridge` |
| `devices.py` | Optional. `comms_devices` table, `SqlDeviceRegistry`, `DevicesFeature` (`/devices` REST). | `Device`, `SqlDeviceRegistry`, `DevicesFeature` |
| `push.py` | Optional. Push senders. | `ExpoPushSender`, `ApnsVoipSender`, `DevicePushRouter` |
| `s3.py` | Optional. S3 media storage (needs boto3). | `S3Storage` |
| `media_tools.py` | Optional. Image thumbnails (Pillow), video thumbnails and durations (ffmpeg/ffprobe). Each returns `None` if the tool is missing. | `make_image_thumbnail`, `probe_duration`, `make_video_thumbnail` |
| `media.py` | Media type from file extension. | `detect_media_type` |
| `util.py`, `compat.py` | Small helpers; `PONG` legacy constant; `callkit_uuid(call_id)`. | `callkit_uuid` |

`devices`, `push`, `redis_bridge`, `s3` and `media_tools` are imported only when you use them, so their tables and
optional dependencies are not pulled in otherwise (`commskit/core/__init__.py` docstring).

### 3.2 `commskit/chat`

| Module | What it does |
|---|---|
| `feature.py` | `ChatFeature(policy, storage, devices, config).install(hub)`; `ChatConfig` (limits); server-side `send_message_as`, `send_system_message`, `delete_user_data`. |
| `handlers.py` | WebSocket handlers: `req_users`, `get_messages`, `send_message`, `mark_read`, `typing`, `media_upload`, `delete_message`, `clear_chat`. Offline push. |
| `service.py` | Database queries (`ChatService`). |
| `router.py` | REST routes under `/chats`. |
| `models.py` | Tables `chats`, `messages`, `comms_message_hidden`, `comms_chat_cleared`. |
| `policy.py` | `ChatPolicy` interface and `AllowAllChatPolicy` default. |
| `dto.py` | `MessageDto` shaping for the wire. |

Exports: `ChatFeature`, `ChatConfig`, `ChatPolicy`, `AllowAllChatPolicy`, `ChatService`, `Chat`, `Message`, `MessageHidden`, `ChatCleared`, `ChatActionError`, `message_dto`.

### 3.3 `commskit/call`

| Module | What it does |
|---|---|
| `feature.py` | `CallFeature(policy, config).install(hub)`; `delete_user_data`. |
| `handlers.py` | WebSocket handlers: `call_initiate`, `answer_call`, `reject_call`, `end_call`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `start_recording` (ignored). |
| `lifecycle.py` | Ring timeout, disconnect grace, re-ring on reconnect, incoming/missed-call pushes. |
| `service.py` | Database access (`CallService`), call log text. |
| `router.py` | `POST /call/turn-credentials`, `POST /call/{call_id}/reject`. |
| `turn.py` | `turn_credentials()`: coturn REST-API credentials (HMAC-SHA1). |
| `config.py` | `CallConfig`: timings, push channels, TURN settings, rate limit. |
| `policy.py` | `CallPolicy` interface, `CallDecision`, `AllowAllCallPolicy` default. |
| `bridge.py` | `CallChatBridge` interface (implemented by `integration`). |
| `models.py` | Table `calls`. |

Exports: `CallFeature`, `CallConfig`, `CallPolicy`, `CallDecision`, `AllowAllCallPolicy`, `CallService`, `CallInfo`, `Call`, `turn_credentials`, `callkit_uuid`.

### 3.4 `commskit/moderation`

| Module | What it does |
|---|---|
| `feature.py` | `ModerationFeature(on_report, notify_blocked_user, admin_dependency, context_provider).install(hub)`; `chat_policy()` / `call_policy()` wrappers; admin helpers. |
| `handlers.py` | WebSocket handlers `report_and_block`, `block`, `unblock`. |
| `router.py` | REST under `/moderation` (admin routes only when `admin_dependency` is set). |
| `policy.py` | Policy wrappers that put the block list in front of your own policy. |
| `models.py` | Tables `comms_blocks`, `comms_reports`. |
| `service.py` | Database queries, `ReportInfo`. |

### 3.5 `commskit/integration` (loads its submodules lazily)

| Export | What it does |
|---|---|
| `link_chat_and_call(chat, call)` | Calls get a `chat_id`, a "[Call Initiated]" chat entry that is rewritten at the end (for example "Voice call · 05:42"), and a `call_log` frame. |
| `link_moderation(moderation, chat=, call=)` | Block list in front of chat/call policies; live call between a blocked pair ends; report context for admins. |
| `delete_user_everywhere(hub, user_id)` | Account deletion across every installed feature, then emits `user.deleted`. |
| `ChatCallBridge`, `ModerationLink`, `CALL_PLACEHOLDER` | The objects behind the above; `CALL_PLACEHOLDER = "[Call Initiated]"`. |

### 3.6 `tests/`

Pytest suite, 13 files (`conftest.py` plus `test_chat.py`, `test_call.py`, `test_chat_call.py`, `test_moderation.py`, `test_devices.py`, `test_push.py`, `test_core.py`, `test_core_extras.py`, `test_chat_extras.py`, `test_media_and_receipts.py`, `test_admin_and_deletion.py`, `test_imports.py`).
It builds three apps (chat only, call only, chat + call) on SQLite through Starlette's `TestClient`; push tests use `httpx.MockTransport` (no network).
`test_imports.py` enforces the dependency rule below. Redis, S3, real APNs, real Expo and coturn are not exercised
by these tests (`RedisBridge` is tested only against a fake in-memory Redis object in `tests/test_core_extras.py`, never a real server).

### 3.7 The demo server (`comms-kit/examples/backend/demo-server-python/`, outside `backend/`)

| Path | What it is |
|---|---|
| `examples/backend/demo-server-python/demo_server.py` | Runnable FastAPI app using the kit with SQLite and three fixed users. **Dev only.** |
| `examples/backend/demo-server-python/demo.html`, `demo.css`, `demo.js`, `demo-call.js` | Browser demo served by the demo server. |
| `examples/backend/demo-server-python/ui_tests/` | Headless-Chrome UI tests (run from `examples/backend/demo-server-python` with its own `pytest.ini`), skipped without Chrome. Not part of the backend test run. |
| `examples/backend/demo-server-python/.demo_data/` | SQLite db and uploaded files of the demo. Git-ignored. |

### 3.8 `pyproject.toml` extras

| Extra | Installs | Needed for |
|---|---|---|
| (none) | `fastapi`, `sqlalchemy[asyncio]`, `pyjwt` | core + chat + call + moderation |
| `redis` | `redis>=5.0` | `RedisBridge`, multi-worker |
| `s3` | `boto3>=1.28`, `pillow>=10` | `S3Storage` |
| `media` | `pillow>=10` | thumbnails (ffmpeg/ffprobe optional, on `PATH`) |
| `push` | `httpx>=0.27` | `ExpoPushSender`, `DevicePushRouter` |
| `apns` | `httpx[http2]>=0.27`, `cryptography>=42` | `ApnsVoipSender` (iOS VoIP) |
| `dev` | `pytest`, `pytest-asyncio`, `httpx`, `aiosqlite`, `cryptography`, `pillow` | running the tests |

Not in any extra: a database driver (`aiosqlite`, `asyncpg`, ...) and an ASGI server (`uvicorn`). You add them yourself.

## 4. Three usage modes and the dependency rule

| Mode | You install | Notes |
|---|---|---|
| Chat only | `ChatFeature` | No call code is imported. |
| Call only | `CallFeature` | Call payloads carry `chat_id: null`; no chat message, no `call_log`. |
| Chat + call | `ChatFeature`, `CallFeature`, then `link_chat_and_call(chat, call)` | Calls show up inside the chat. |

`ModerationFeature` and `DevicesFeature` work with any of the three.

Dependency rule (enforced by `tests/test_imports.py`):

```
chat, call, moderation  ->  import only core
integration             ->  the only package that imports several features (lazily)
core                    ->  imports none of them
```

So a chat-only app never loads `call`, and the other way round.

## 5. Main concepts

| Concept | Meaning |
|---|---|
| `CommsHub` (`core/hub.py`) | The one object you create. It holds the adapters, the connection manager, the event bus, the WebSocket handler table and the REST routers. Features register themselves on it with `feature.install(hub)`. |
| Feature | A plug-in: `ChatFeature`, `CallFeature`, `ModerationFeature`, `DevicesFeature`. `install(hub)` registers WebSocket handlers and REST routes. Installing the same feature name twice raises `RuntimeError`. |
| Adapter | A small interface (a `typing.Protocol`, no subclassing needed) that you implement to connect the kit to your app: `AuthAdapter` (token -> user id), `UserDirectory` (names and avatars), `PushSender`, `MediaStorage`, `DeviceRegistry`. Each has a safe default. |
| Policy | A host rule: `ChatPolicy` (may A message B? blocked? extra info) and `CallPolicy` (may A call B? credits?). Default: allow everything. |
| Event bus (`hub.events`) | In-process notifications such as `chat.message_sent`, `call.finalized`, `user.came_online`, `moderation.reported`. Listener errors are logged, not raised. Full list in `core/events.py`. |
| Hooks | `hub.on("type")` custom WebSocket frame types, `hub.on_connect`, `hub.on_disconnect`, `on_handler_error`, `role_resolver`. |

The adapter and policy defaults are listed (with what a real implementation should do) in file 2, section C.

## 6. Data it stores

All tables hang on `commskit.core.CommsBase.metadata`. A table exists in the metadata only after its module is imported.
There are no foreign keys to a users table; user ids are plain strings (max 50 characters).

| Table | Module | Contents |
|---|---|---|
| `chats` | `chat/models.py` | One row per pair of users. `user1_id < user2_id` always; unique per pair. |
| `messages` | `chat/models.py` | Every message: text or file fields, `message_type`, read/delivered flags, reply link, call-log fields (`is_call`, unique `call_id`). Unsent messages stay as `message_type "deleted"`. |
| `comms_message_hidden` | `chat/models.py` | "Delete for me": which user no longer sees which message. |
| `comms_chat_cleared` | `chat/models.py` | "Clear chat": per user and chat, a watermark `up_to_message_id` and `cleared_at`. |
| `calls` | `call/models.py` | One row per call: caller, receiver, status (`ringing`, `answered`, `ended`, `missed`, `rejected`), timestamps, duration, `end_reason`, and the SDP offer/answer and ICE candidates as text (these contain IP addresses; the kit never clears them). |
| `comms_devices` | `core/devices.py` | One row per app install: `user_id`, unique `device_id`, `platform`, `expo_push_token`, `voip_token`, app/OS/model info, timestamps. |
| `comms_blocks` | `moderation/models.py` | Who blocked whom (unique pair). |
| `comms_reports` | `moderation/models.py` | Reports: reporter, reported, reason, category, message id, `status` (`open`, `resolved`, `dismissed`), resolution fields. |

That is 8 tables. Uploaded files are not in the database: only their URL is (`messages.file_url`, `thumbnail_url`); the bytes go to your `MediaStorage`.

Other state (not in the database): who is connected and presence are in process memory, or in Redis if you use `RedisBridge`.
Rate-limit buckets are in memory, or in Redis with `RedisRateLimiter`. Call ring/disconnect timers are in-process asyncio tasks (see file 3, "scaling").

## 7. How clients talk to it

- WebSocket: one endpoint, `wss://<host>/ws/<jwt>`. JSON frames, each with a string `type`. Used for everything real-time.
- REST (Bearer token in the `Authorization` header): chat lists, history, mark read, device registration, TURN credentials, moderation, decline-from-notification.
- Full contract: [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). Frame and route lists are summarised in file 2, section B.

## 8. What it does NOT do

- No user table, no sign-up, no login, no password or token issuing. Your app issues the JWT; the kit only validates it.
- No user profiles. Names and avatars come from your `UserDirectory`; the default knows nobody (shows the id, or "Someone").
- No admin UI. It has admin REST routes for reports (when you supply `admin_dependency`) and nothing else.
- No media for calls: calls are peer-to-peer WebRTC. Audio/video never touch the server. The server relays only signalling and, if you run coturn, the TURN server relays media when a direct path is impossible. The kit does not include a TURN server.
- No group chat: conversations are strictly 1:1.
- No call recording (`start_recording` is accepted and ignored).
- No health-check route, no metrics, no migrations (Alembic or other). You create tables with `create_all` or your own migrations.
- No billing or credits. `CallPolicy` is where you put that.
- No push provider accounts. You bring the Expo token and, for iOS VoIP, the Apple key.
- No end-to-end encryption. Messages are stored in plain text in your database (the kit does not encrypt them).
- No built-in serving of uploaded files. `LocalDiskStorage` writes files; you must serve them yourself.

## 9. Test status

Ran once from `comms-kit/backend/backend-python` on 2026-10-26 (Windows, Python 3.12.10, SQLAlchemy 2.1.6, FastAPI 0.162.0):

```powershell
.venv\Scripts\python -m pytest -q tests
```

Result: **130 passed, 1 warning in about 54 s** (the warning is a Starlette deprecation notice about `httpx` in `TestClient`).

The browser UI tests in `examples/backend/demo-server-python/ui_tests` were not run for this document.
Not verified in this repo's tests: real Redis, real S3, real Expo/APNs calls, coturn, PostgreSQL (the suite uses SQLite only).
