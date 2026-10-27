# Backend example: the demo server (`examples/backend/demo-server-python`)

The runnable example for the **backend** half of the kit. It is a small FastAPI app that wires up
`commskit` (chat, calls, moderation, devices and push), serves a plain-HTML test page, and has a browser
test suite. The phone example (`examples/expo-app`) and the web example (`examples/web-app`) both log in
and chat against it.

> **Dev only.** It hands out login tokens to anyone who asks and uses a throw-away SQLite database. Never
> deploy it. For a real server see [../backend/backend-python/03-using-running-and-deploying.md](../backend/backend-python/03-using-running-and-deploying.md).

## Table of contents

1. [What it is, why, for whom](#1-what-it-is-why-for-whom)
2. [File map](#2-file-map)
3. [`demo_server.py` in detail](#3-demo_serverpy-in-detail)
4. [How login works](#4-how-login-works)
5. [How to run](#5-how-to-run)
6. [The browser demo page](#6-the-browser-demo-page)
7. [The browser UI tests](#7-the-browser-ui-tests)
8. [How it differs from a real deployment](#8-how-it-differs-from-a-real-deployment)
9. [Limitations](#9-limitations)
10. [What to copy into your own backend](#10-what-to-copy-into-your-own-backend)

---

## 1. What it is, why, for whom

| | |
|---|---|
| **What** | A one-file FastAPI server (`demo_server.py`) that installs the kit's features with demo settings, plus a plain-HTML client page (`demo.html`, `demo.css`, `demo.js`, `demo-call.js`) and a headless-Chrome UI test suite (`ui_tests/`). |
| **Why it exists** | So you can see and try everything the backend does without building anything: two browser tabs are two users who can chat, call, block and report each other. It is also the server every other example needs, and the fixture the browser tests run against. |
| **Who it is for** | Developers evaluating the kit, developers integrating the backend into their own project (it is the shortest complete wiring example), and people testing the phone or web examples. |
| **What it is not** | A production template. It has no real login, no real users, no Redis, no S3 and no TLS. |

It uses the backend's virtualenv (`backend/backend-python/.venv`), where `commskit` is installed in editable mode. The folder
has no `requirements.txt` of its own.

## 2. File map

```text
examples/backend/demo-server-python/
├── demo_server.py     the FastAPI app: wires the kit, creates the tables, serves the page and dev endpoints
├── demo.html          the test page markup (sign-in, list and chat panes, call screen, sheets, dev drawer)
├── demo.css           styles; CSS variables mirror design/tokens.json (checked by a test)
├── demo.js            page logic: sign-in, WebSocket, chat, appearance, mode switch
├── demo-call.js       WebRTC voice calls; loaded only when the server has the call feature
├── pytest.ini         pytest config for the UI tests (asyncio auto mode; the tests live outside backend/)
├── .demo_data/        created on first run: demo.db (SQLite) and media/ (uploaded files). Git-ignored.
└── ui_tests/
    ├── _harness.py    starts a demo server per mode, drives headless Chrome over the DevTools protocol,
    │                  and provides scripted WebSocket users
    ├── conftest.py    fixtures: Chrome, servers, a seeded chat history
    ├── test_layout.py, test_interactions.py, test_modes.py, test_mode_switch.py,
    │   test_call.py, test_appearance.py, test_tokens.py
    └── screenshots/   written by the tests; git-ignored
```

## 3. `demo_server.py` in detail

What the file builds, in order:

| Step | Code | Notes |
|---|---|---|
| Data folder | `DATA = COMMS_DEMO_DATA or examples/backend/demo-server-python/.demo_data` | Holds `demo.db` and `media/`. |
| Demo users | `USERS = {U1: Alice, U2: Bob, U3: Carol}` as a `StaticUserDirectory` | The kit's "who are the users" placeholder. |
| Database | `sqlite+aiosqlite` file at `DATA/demo.db`, `async_sessionmaker` | Tables come from `CommsBase.metadata.create_all` at startup. |
| Auth | `JwtAuth(SECRET)` with `SECRET = COMMS_DEMO_SECRET` or a built-in demo string | HS256, user id in the `uid` claim. |
| Push | `DevicePushRouter(SqlDeviceRegistry, ExpoPushSender, ApnsVoipSender.from_env())` | Expo always; Apple VoIP only if the `APNS_*` variables are set; `ANDROID_CALL_STYLE` default `data`. |
| Hub | `CommsHub(auth, session_factory, users, push)` | One hub for the app. |
| Devices | `DevicesFeature(devices)` | Adds `POST /devices`, `DELETE /devices/{id}` and the legacy push-token routes. |
| Chat | `ChatFeature(LocalDiskStorage(DATA/media, base_url="/media"), ChatConfig(...))` | Only if `chat` is in `COMMS_FEATURES`. Rate limits are loosened (200 messages per 10 s, 60 uploads per minute) because the tests send bursts. |
| Calls | `CallFeature(CallConfig(turn_secret, turn_uris, initiate_rate=None))` | Only if `call` is in `COMMS_FEATURES`. TURN comes from env; call-rate limiting is off. |
| Chat + calls | `link_chat_and_call(chat, call)` | Call logs appear in the chat. Only when both run. |
| Moderation | `ModerationFeature(on_report=...)` + `link_moderation(moderation, chat, call)` | Reports are printed to the console (a real app would notify moderators). No admin routes: no `admin_dependency` is given. |
| CORS | `CORSMiddleware` if `COMMS_CORS_ORIGINS` is set | Off by default. Only needed for a web client that does not use a proxy. |
| Routers | `hub.ws_router()` and `hub.rest_router()` | `/ws/{token}` plus the REST routes of the installed features. |
| Media | `StaticFiles(DATA/media)` mounted at `/media` | Uploaded files are publicly readable. |
| Dev endpoints | `GET /dev/users`, `GET /dev/token/{id}` | See section 4. |
| Page | `GET /`, `/demo.html`, `/demo.css`, `/demo.js`, `/demo-call.js` | An explicit allow-list, so `demo_server.py` and `.demo_data` are never served. `Cache-Control: no-cache`, so edits show on a normal reload. |

### Environment variables it reads

| Variable | Default | What it does |
|---|---|---|
| `COMMS_FEATURES` | `chat,call` | Which features to install: `chat`, `call` or `chat,call`. |
| `COMMS_DEMO_DATA` | `examples/backend/demo-server-python/.demo_data` | Where the SQLite file and uploads live. |
| `COMMS_DEMO_SECRET` | a built-in demo string | The JWT signing secret. Unsafe by design. |
| `COMMS_CORS_ORIGINS` | unset (no CORS) | Comma-separated allowed origins. |
| `EXPO_ACCESS_TOKEN` | unset | Optional Expo push access token. |
| `ANDROID_CALL_STYLE` | `data` | `data` (the app shows its own full-screen call) or `notification`. |
| `APNS_KEY` or `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` | unset | iOS VoIP push. Without them iPhones get a normal push. |
| `TURN_SECRET`, `TURN_URIS` | unset | coturn credentials so calls work across networks. The route answers 503 without `TURN_SECRET`. |

The full table with explanations is in [../backend/backend-python/02-keys-secrets-websockets-and-placeholders.md](../backend/backend-python/02-keys-secrets-websockets-and-placeholders.md).

## 4. How login works

There is no password. The demo mints a token for you:

1. `GET /dev/users` returns `{ "features": [...], "users": [{id, name}, ...] }` (the installed features and the three demo users).
2. `GET /dev/token/{id}` returns `{ "token": "<jwt>" }` for `U1`, `U2` or `U3` (404 for anyone else). The token is signed with the demo secret and carries `{"uid": "<id>"}`.
3. The client opens `ws://<host>/ws/<token>` and sends the token as a Bearer header on REST calls.

Anyone who can reach the server can get a token for any demo user. That is why the server must stay on your
own machine or network.

## 5. How to run

**Prerequisites:** the backend virtualenv with the kit installed (from `comms-kit/backend/backend-python`:
`python -m venv .venv`, then `pip install -e ".[dev,redis,push]" "uvicorn[standard]"`). See
[../backend/backend-python/03-using-running-and-deploying.md](../backend/backend-python/03-using-running-and-deploying.md).

Run these **from the `comms-kit` folder**:

```powershell
# PowerShell
.\backend\backend-python\.venv\Scripts\python.exe -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --reload --port 8000

# one mode only
$env:COMMS_FEATURES = "chat"      # or "call"; remove it with: Remove-Item Env:COMMS_FEATURES
```

```bash
# bash / Git Bash (Windows: backend/backend-python/.venv/Scripts/python, Linux and macOS: backend/backend-python/.venv/bin/python)
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --reload --port 8000

COMMS_FEATURES=chat backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --port 8000
```

Then open `http://localhost:8000/#U1` in one tab and `http://localhost:8000/#U2` in another (a private window
keeps the two users apart).

| Task | How |
|---|---|
| Use it from phones or other computers | Add `--host 0.0.0.0` and open `http://<your-PC-IP>:8000`. Allow port 8000 in the firewall. Microphone access needs `localhost` or HTTPS, so calls between two computers need an HTTPS tunnel. |
| Reset all data | Stop the server and delete `examples/backend/demo-server-python/.demo_data`. |
| Move the data | Set `COMMS_DEMO_DATA`. |
| Try the other examples | Start this server first, then follow [mobile-example.md](mobile-example.md) or [web-example.md](web-example.md). |
| Troubleshooting | "Address already in use" means another process holds port 8000 (use `--port 8001`). A `1008` WebSocket close means a bad or missing token. A mode button that looks disabled means the server was started without that feature, so check `COMMS_FEATURES` and restart. |

## 6. The browser demo page

`demo.html` + `demo.css` + `demo.js` (+ `demo-call.js`) are a plain client for the kit's protocol. No build
step and no libraries: the server just serves the files.

- **What it does:**
  - **Chat:** list, search, messages, ticks, typing, files and images, "jump to latest", loading older messages, reconnect banner.
  - **Calls:** WebRTC voice calls with ringtones. They use Google's public STUN server and no TURN, so they can fail across mobile networks.
  - **Looks:** light and dark themes, 7 colour themes, and wallpapers including your own image.
  - **Layout:** responsive, from a 320 px phone to a desktop.
- **Chat / Calls / Both switch:** on the sign-in card and under the search box. It reloads the page in that mode (chat-only never loads `demo-call.js`) and greys out what the server doesn't run.
- **Deep links:** `#U1` signs in as Alice, `#U1:U2` also opens the chat with Bob, `?mode=chat|call|both` picks the mode.
- **`</>` button:** opens a drawer with every WebSocket message in and out.
- **Saved in the browser (`localStorage`):** `commsDemo.theme`, `commsDemo.mode`, `commsDemo.appearance` and `commsDemo.appearance.image`.
- **Not in this page:** the page does not use `commskit-web` or `commskit` (the npm packages). It is a separate, dependency-free implementation of the protocol, which is why it also proves the protocol is usable without them.

## 7. The browser UI tests

`ui_tests/` drives real Chrome against real demo servers. **75 tests**; the last run passed 75 of 75 in about
2½ minutes.

### How they work

| Piece | What it does |
|---|---|
| `DemoServer` (in `_harness.py`) | Starts `uvicorn demo_server:app` on a **free port (never 8000)** with its own temporary data folder, once per feature mode (`chat,call`, `chat`, `call`). Your running server and `.demo_data` are never touched. |
| Chrome driver | Launches headless Chrome and talks to it over the DevTools protocol with the `websockets` package (no Selenium or Playwright). Uses `CHROME_PATH` or the default install path; **tests are skipped when Chrome is not found**. |
| `WsUser` | A scripted WebSocket user (for example Bob sending a message or Carol ringing Alice) so tests can check what appears in the page. |
| Seeded history | A small realistic conversation (text, a photo, a file, read ticks, and a missed call plus a note from Carol). |

### What they cover

| File | Covers |
|---|---|
| `test_layout.py` | Seven screen sizes from 320×568 to 1920×1080: no horizontal overflow, header, composer and call controls on screen and clickable. |
| `test_interactions.py` | Incoming messages and unread badges, ticks to read, typing, paging older messages, "jump to latest", keyboard navigation, back button, attachments and the 10 MB limit, dark mode, reduced motion, the reconnect banner, the frames drawer, and that the server serves the page files but not its own folder. |
| `test_modes.py`, `test_mode_switch.py` | Chat-only never loads call code or the microphone; call-only has no message box; the switch reloads into each mode, remembers the choice and greys out unavailable modes. |
| `test_call.py` | A real two-browser call (accept, mute, hang up) and the declined, busy, no-answer and microphone-blocked screens. |
| `test_appearance.py` | Colour themes, wallpapers (solid, gradient, image with dim), per-chat override, saving, storage-full handling, the sheet layout at four sizes. |
| `test_tokens.py` | The CSS values equal `design/tokens.json` (colours in light and dark, scale, breakpoints, theme presets, wallpapers). |

### Run them

```powershell
cd examples\backend\demo-server-python
..\..\..\backend\backend-python\.venv\Scripts\python.exe -m pytest -q          # all 75
..\..\..\backend\backend-python\.venv\Scripts\python.exe -m pytest -q ui_tests/test_tokens.py   # just one file
```

```bash
cd examples/backend/demo-server-python
../../../backend/backend-python/.venv/Scripts/python -m pytest -q
```

Screenshots of key states are written to `ui_tests/screenshots/` (git-ignored). If one wallpaper test fails
once in a full run, rerun it alone; it passed alone and on a rerun, so it is a timing flake under load.

The backend's own unit tests are a separate suite: `cd backend` then `python -m pytest -q tests` (130 tests).

## 8. How it differs from a real deployment

| Demo server | A real app |
|---|---|
| Three fixed users in code | Your user table; implement `UserDirectory` |
| `GET /dev/token/{id}` gives anyone a token | Your login issues tokens; `JwtAuth` or your own `AuthAdapter` verifies them |
| Built-in JWT secret | A secret from your environment |
| SQLite file, tables created on every start | PostgreSQL, with managed tables and upgrade SQL |
| Local-disk uploads, public at `/media` | S3 (private bucket with expiring links) via `S3Storage` |
| No Redis, one process | `RedisBridge` when you run several workers |
| Loose rate limits, call limit off | The kit's default limits or your own |
| No TURN unless you set it | A real TURN server for mobile data |
| Reports printed to the console | `on_report` hook that notifies moderators, plus an admin review route |
| No admin routes | `ModerationFeature(admin_dependency=...)` with your admin check |
| `http://` and `ws://` | HTTPS and WSS |

## 9. Limitations

- Single process and single machine; no clustering.
- Browser calls use public STUN only, so they can fail between a phone on mobile data and a phone on Wi-Fi.
- The page has no UI for some newer features (for example unsend and clear chat); it ignores those messages. The web example covers them.
- Nothing here has been run against real Redis, S3, PostgreSQL, Apple or Expo push.
- The tests need Chrome (and Windows, macOS or Linux with a Chrome install).

## 10. What to copy into your own backend

Copy the **wiring** from `demo_server.py` (the hub, the features, `include_router`, the table creation) and
replace each demo piece:

1. `StaticUserDirectory(USERS)` → a `UserDirectory` that reads your users.
2. `JwtAuth(SECRET)` → `JwtAuth(<your secret>, claim=<your claim>)`, or an `AuthAdapter` for your own scheme.
3. `sqlite+aiosqlite` engine → your PostgreSQL async engine and session factory.
4. `LocalDiskStorage` → `S3Storage` (or your own `MediaStorage`).
5. Remove `/dev/*`, the page routes and the `/media` mount.
6. Add your own rules through the policies: blocking and consent (`ChatPolicy`), credits (`CallPolicy`).
7. Add `RedisBridge` if you run more than one worker.

The step-by-step version, with a minimal integration example for each mode, is in
[../backend/backend-python/03-using-running-and-deploying.md](../backend/backend-python/03-using-running-and-deploying.md).
