# Backend (Node) example: the demo server (`examples/backend/demo-server-node`)

The runnable example for the **Node backend** (`backend/backend-node/`, package `commskit-node`). It is a small plain-Node server that wires up the kit
(chat, calls, moderation, devices and push), serves the same plain-HTML test page as the Python demo, and can stand in for the Python demo server in the existing
browser tests and web end-to-end test. The phone example (`examples/expo-app`) and the web example (`examples/web-app`) can log in and chat against it.

> **Dev only.** It hands out login tokens to anyone who asks and uses a throw-away SQLite database. Never deploy it. For a real server see
> [../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md). The Python twin of this example is described in
> [backend-example.md](backend-example.md).

Status of this document: written on 2026-10-26 against the files in `examples/backend/demo-server-node/` as they were that day (`server.mjs` 180 lines, `package.json`, `README.md`, `.gitignore`).
I started the server and called its endpoints (section 5), but did **not** run the browser tests or the web e2e against it (section 7). The demo server was being finished by someone else while this was written: **verify against the final files**.

## Table of contents

1. [What it is, why, for whom](#1-what-it-is-why-for-whom)
2. [File map](#2-file-map)
3. [`server.mjs` in detail](#3-servermjs-in-detail)
4. [How login works](#4-how-login-works)
5. [How to run](#5-how-to-run)
6. [The browser demo page](#6-the-browser-demo-page)
7. [Running the existing tests against it (`DEMO_BACKEND=node`)](#7-running-the-existing-tests-against-it-demo_backendnode)
8. [How it differs from the Python demo and from a real deployment](#8-how-it-differs-from-the-python-demo-and-from-a-real-deployment)
9. [Limitations](#9-limitations)
10. [What to copy into your own backend](#10-what-to-copy-into-your-own-backend)

---

## 1. What it is, why, for whom

| | |
|---|---|
| **What** | A one-file Node server (`server.mjs`) that installs the kit's features with demo settings on a plain `node:http` server. It has no web framework. It serves the browser test page that lives next to the Python demo (`examples/backend/demo-server-python/`). |
| **Why it exists** | So you can try the Node backend exactly like the Python one: two browser tabs are two users who can chat, call, block and report each other. It is also the fixture that lets the existing browser tests and the web e2e run against `commskit-node`, which is how wire compatibility with the Python server is checked from the client side (file 1 of the backend docs, section 12). |
| **Who it is for** | Developers on a Node stack evaluating the kit, developers integrating `commskit-node` (it is the shortest complete wiring example in this repo, next to `backend/backend-node/scripts/dist-smoke.mjs`), and people testing the phone or web examples. |
| **What it is not** | A production template. It has no real login, no real users, no Redis, no S3, no PostgreSQL and no TLS. |

It is a small npm project of its own (`package.json`, private, ESM). `commskit-node` is installed from the folder next to it: `"commskit-node": "file:../../../backend/backend-node"`. That means **`backend/backend-node` must be built first** (its `dist/` folder is generated and git-ignored).

## 2. File map

```text
examples/backend/demo-server-node/
├── server.mjs         the whole server: wires the kit, creates the tables, serves the page, media and dev endpoints
├── package.json       private package; dependencies: commskit-node (file:../../../backend/backend-node), better-sqlite3, kysely, jose; script: npm start
├── package-lock.json
├── README.md          the example's own short README (run, environment, differences)
├── .gitignore         node_modules and .demo_data
├── node_modules/      after npm install (git-ignored)
└── .demo_data/        created on first run: demo.db (SQLite, WAL mode) and media/ (uploaded files). Git-ignored.

examples/backend/demo-server-python/  (the Python demo folder, shared)
├── demo.html, demo.css, demo.js, demo-call.js   the browser page: read from here by the Node server (not copied)
└── ui_tests/_harness.py                         the browser-test launcher; starts the Node server when DEMO_BACKEND=node
examples/web-app/e2e/env.mjs                     the web e2e launcher; starts the Node server when DEMO_BACKEND=node
```

## 3. `server.mjs` in detail

What the file builds, in order (line numbers as of 2026-10-26):

| Step | Code | Notes |
|---|---|---|
| Imports (1 to 17) | `commskit-node/core`, `/chat`, `/call`, `/moderation`, `/integration`, `/push`, and `ensureSchema` from `commskit-node` | Every feature comes from its own sub-entry, as in `dist-smoke.mjs`. |
| Folders (20 to 22) | `PAGE_DIR = ../demo-server-python`, `DATA = COMMS_DEMO_DATA or ./.demo_data`; creates `DATA/media` | The page files are shared with the Python demo. |
| Port and host (24 to 29) | `--port` or `PORT` (default 8000), `--host` (default `127.0.0.1`) | |
| Secret and features (31 to 33) | `SECRET = COMMS_DEMO_SECRET or a built-in demo string`; `FEATURES` from `COMMS_FEATURES` (default `chat,call`) | |
| Demo users (35 to 39) | `USERS = {U1: Alice, U2: Bob, U3: Carol}` used as a `StaticUserDirectory` | The kit's "who are the users" placeholder. |
| Database (41 to 45) | `better-sqlite3` file `DATA/demo.db`, `journal_mode = WAL`, `busy_timeout = 30000`, wrapped in a Kysely `SqliteDialect`; `await ensureSchema(db)` | Tables are created on every start (idempotent). |
| Push (47 to 53) | `DevicePushRouter({ registry: SqlDeviceRegistry, expo: ExpoPushSender({ accessToken }), voip: ApnsVoipSender.fromEnv(devices), androidCallStyle })` | Expo always; Apple VoIP only if the `APNS_*` variables are set; `ANDROID_CALL_STYLE` default `data`. |
| Hub (55) | `new CommsHub({ auth: new JwtAuth(SECRET), db, users, push })` | One hub for the app. |
| Devices (56) | `hub.install(new DevicesFeature(devices))` | Installed **before** chat, so chat does not mount a second copy of the legacy push-token routes. Adds `POST /devices`, `DELETE /devices/:id` and the legacy routes. |
| Chat (60 to 69) | `ChatFeature({ storage: LocalDiskStorage(DATA/media, "/media"), config: { messageRate: RateLimit(200, 10), uploadRate: RateLimit(60, 60), typingRate: RateLimit(60, 5) } })` | Only if `chat` is in `COMMS_FEATURES`. Limits are loosened because the tests send bursts. |
| Calls (70 to 73) | `CallFeature({ config: { turnSecret, turnUris, initiateRate: null } })` | Only if `call` is in `COMMS_FEATURES`. TURN comes from `TURN_SECRET` / `TURN_URIS` (comma separated); call-rate limiting is off. |
| Chat + calls (74) | `linkChatAndCall(chat, call)` | Call logs appear in the chat. Only when both run. |
| Moderation (76 to 79) | `ModerationFeature({ onReport: console.log })` + `linkModeration(moderation, { chat, call })` | Installed in every mode. Reports are printed to the console. No admin routes: no `adminDependency` is given. |
| REST (81) | `const rest = restListener(hub)` | The kit's built-in `node:http` handler for the REST routes of the installed features (taken after all features are installed). |
| CORS (83 to 97) | A hand-written responder, active only for origins listed in `COMMS_CORS_ORIGINS` | Off by default. Only needed for a web client that does not use a proxy. |
| Page and media (99 to 160) | The request handler: `/dev/*`, the allow-listed page files, `/media/*` (path-traversal checked), then `rest(req, res)`, then `404 {"detail":"Not Found"}` | See "Endpoints" below. |
| WebSocket (164) | `hub.attach(server)` | Handles the `/ws/:token` upgrade. |
| Shutdown (166 to 178) | On SIGINT/SIGTERM: `hub.shutdown()`, `push.aclose()`, close the server and the database, exit | |
| Listen (180) | `server.listen(PORT, HOST)` and a `[demo] comms kit demo (node) on http://...  features=...` line | |

It does not call `hub.connections.start()` because there is no Redis bridge.

### Endpoints

| Method and path | Served by | What it does |
|---|---|---|
| `GET /` and `/demo.html`, `/demo.css`, `/demo.js`, `/demo-call.js` | `server.mjs` | The browser page, read from `../demo-server-python/` through an explicit allow-list (`Cache-Control: no-cache`). Nothing else in that folder is served. `/` returns `demo.html` |
| `GET /dev/users` | `server.mjs` | `{ "features": [...], "users": [{id, name}, ...] }` (verified: `features` listed `call` and `chat`, users Alice, Bob, Carol) |
| `GET /dev/token/:id` | `server.mjs` | `{ "token": "<jwt>" }` for `U1`, `U2` or `U3`; `404 {"detail":"unknown demo user"}` for anyone else |
| `GET /media/<path>` | `server.mjs` | Uploaded files from `DATA/media` (public, no auth) |
| `WS /ws/<token>` | the kit (`hub.attach`) | The one WebSocket endpoint |
| `/chats/...`, `/devices...`, `/call/...`, `/moderation/...` | the kit (`restListener`) | The REST routes of the installed features: list in [../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md](../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md), section B.4 |
| anything else | `server.mjs` | `404 {"detail":"Not Found"}` |

### Environment variables it reads

| Variable | Default | What it does |
|---|---|---|
| `COMMS_FEATURES` | `chat,call` | Which features to install: `chat`, `call` or `chat,call`. |
| `COMMS_DEMO_DATA` | `examples/backend/demo-server-node/.demo_data` | Where the SQLite file and uploads live. |
| `COMMS_DEMO_SECRET` | `local-demo-secret-change-me-0000` | The JWT signing secret. Unsafe by design. |
| `COMMS_CORS_ORIGINS` | unset (no CORS) | Comma-separated allowed origins. |
| `EXPO_ACCESS_TOKEN` | unset | Optional Expo push access token. |
| `ANDROID_CALL_STYLE` | `data` | `data` (the app shows its own full-screen call) or `notification`. |
| `APNS_KEY` or `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` | unset | iOS VoIP push. Without them iPhones get a normal push. |
| `TURN_SECRET`, `TURN_URIS` | unset | coturn credentials so calls work across networks. The route answers 503 without `TURN_SECRET`. |
| `PORT` | `8000` | Listen port (the `--port` argument wins). |
| `DEMO_BACKEND` | n/a | **Not read by the server.** It is read by the two test launchers (section 7). |

The full table with explanations is in [../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md](../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md), sections A.4 and A.8.

## 4. How login works

There is no password. The demo mints a token for you (same as the Python demo):

1. `GET /dev/users` returns the installed features and the three demo users.
2. `GET /dev/token/:id` returns `{ "token": "<jwt>" }` for `U1`, `U2` or `U3`. The token is HS256, signed with the demo secret, and carries `{"uid": "<id>"}`. It has **no `exp`** (`server.mjs`: `new SignJWT({ uid }).setProtectedHeader(...).sign(...)`), and the kit accepts tokens without expiry.
3. The client opens `ws://<host>/ws/<token>` and sends the token as a Bearer header on REST calls.

Anyone who can reach the server can get a token for any demo user. That is why the server must stay on your own machine or network.

## 5. How to run

**Prerequisites:** Node 20 or newer, and the kit built once:

```powershell
# PowerShell, from the comms-kit folder
cd backend/backend-node
npm install
npm run build              # creates backend/backend-node\dist (git-ignored; the demo needs it)
cd ..\examples\backend\demo-server-node
npm install
npm start                  # http://localhost:8000   (same as: node server.mjs --port 8000)
```

```bash
# bash / Git Bash / Linux / macOS, from the comms-kit folder
cd backend/backend-node && npm install && npm run build
cd ../examples/backend/demo-server-node && npm install
npm start
```

Then open `http://localhost:8000/#U1` in one tab and `http://localhost:8000/#U2` in another (a private window keeps the two users apart).

```powershell
# one mode only (PowerShell; remove with: Remove-Item Env:COMMS_FEATURES)
$env:COMMS_FEATURES = "chat"      # or "call"
npm start
```

```bash
COMMS_FEATURES=chat npm start
node server.mjs --port 8001 --host 0.0.0.0     # another port; reachable from other devices
```

What I ran (2026-10-26, Windows, Node 22.23.2): `node server.mjs --port 8141` with `COMMS_DEMO_DATA` set to a scratch folder. It printed `[demo] comms kit demo (node) on http://127.0.0.1:8141  features=call,chat`;
`GET /dev/users` returned Alice, Bob and Carol; `GET /dev/token/U1` returned a token; `GET /` answered `200 text/html`; `GET /nope` answered `{"detail":"Not Found"}`.
I did not click through the page in a browser.

| Task | How |
|---|---|
| Use it from phones or other computers | Add `--host 0.0.0.0` and open `http://<your-PC-IP>:8000`. Allow the port in the firewall. Microphone access needs `localhost` or HTTPS, so calls between two computers need an HTTPS tunnel. |
| Reset all data | Stop the server and delete `examples/backend/demo-server-node/.demo_data`. |
| Move the data | Set `COMMS_DEMO_DATA`. |
| Restart after editing the server or the kit | There is no `--reload`: stop and start again. After changing `backend/backend-node/src`, run `npm run build` in `backend/backend-node` first. |
| Try the other examples | Start this server first (use `COMMS_FEATURES=chat` for the web app), then follow [web-example.md](web-example.md) or [mobile-example.md](mobile-example.md). They speak the same protocol; I did not run them against this server by hand. |
| Troubleshooting | `Cannot find package 'commskit-node'` or a missing `dist` file: run `npm run build` in `backend/backend-node` (see 1). `EADDRINUSE`: another process holds the port (use `--port 8001`). A `1008` WebSocket close: bad or missing token. A mode button that looks disabled: the server was started without that feature, check `COMMS_FEATURES` and restart. More in [../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md), section 3.6. |

## 6. The browser demo page

The page is the **same files** as the Python demo's (`examples/backend/demo-server-python/demo.html`, `demo.css`, `demo.js`, `demo-call.js`). Everything in section 6 of [backend-example.md](backend-example.md) applies unchanged: chat, WebRTC voice calls (public STUN, no TURN unless you set it),
themes and wallpapers, the Chat / Calls / Both switch, deep links (`#U1`, `#U1:U2`, `?mode=chat|call|both`), the `</>` frames drawer, and the browser-side storage keys. The page does not know which backend is behind it; that is the point of the protocol.

## 7. Running the existing tests against it (`DEMO_BACKEND=node`)

Two existing test setups start a demo server for you. When the environment variable `DEMO_BACKEND` is `node`, they start this Node server instead of the Python one. The launcher code (read, not changed):

| Suite | Launcher | What `DEMO_BACKEND=node` changes |
|---|---|---|
| 75 headless-Chrome UI tests in `examples/backend/demo-server-python/ui_tests/` | `_harness.py`, class `DemoServer` (line 88) | Runs `node server.mjs --port <free port>` with `cwd = examples/backend/demo-server-node`, a temporary `COMMS_DEMO_DATA` and the same `COMMS_FEATURES` modes (`chat,call`, `chat`, `call`) instead of `uvicorn demo_server:app` |
| 16-step web e2e in `examples/web-app/e2e/` | `env.mjs`, function `startStack` (line 58) | Runs `node server.mjs --port <free port>` in `examples/backend/demo-server-node` with `COMMS_CORS_ORIGINS` set to the preview app URL; the Python virtualenv check is skipped |

Commands (from the `comms-kit` folder; build `backend/backend-node` first and run `npm install` in `examples/backend/demo-server-node`, section 5):

```powershell
# PowerShell
cd examples\backend\demo-server-python
$env:DEMO_BACKEND = "node"
..\..\..\backend\backend-python\.venv\Scripts\python.exe -m pytest -q                     # the 75 browser tests (needs Chrome and the backend venv's Python)
cd ..\web-app
$env:DEMO_BACKEND = "node"
npm run e2e                                                              # the 16-step web e2e
Remove-Item Env:DEMO_BACKEND
```

```bash
# bash / Git Bash
cd examples/backend/demo-server-python && DEMO_BACKEND=node ../../../backend/backend-python/.venv/Scripts/python -m pytest -q
cd ../web-app && DEMO_BACKEND=node npm run e2e
```

The tests themselves still run on Python (pytest) and on Node (the e2e), because they drive Chrome; only the server under test changes. They need Chrome, as described in [backend-example.md](backend-example.md), section 7.

**Results:** I did **not** run either suite against the Node server for this document, so I make no pass or fail claim. The Python server's last recorded result is 75 of 75 in about 2.5 minutes ([backend-example.md](backend-example.md)). The folder README
(`examples/backend/demo-server-node/README.md`) lists the same two commands and reports no numbers. To get a real answer, run the commands above and compare with the Python run.

## 8. How it differs from the Python demo and from a real deployment

### From the Python demo (`examples/backend/demo-server-python/demo_server.py`)

From `examples/backend/demo-server-node/README.md` and the code:

| Python demo | Node demo |
|---|---|
| FastAPI + uvicorn, `--reload` for development | Plain `node:http` + `restListener(hub)` + `hub.attach(server)`; run with `node`, no reload |
| `sqlite+aiosqlite` | SQLite through `better-sqlite3` in WAL mode with a 30 s busy timeout |
| `CORSMiddleware` | A hand-written CORS responder (same behaviour for the listed origins) |
| An unknown path answers `404`, a wrong method on a known path answers `405` | Unknown path: `404 {"detail":"Not Found"}`; a wrong method on a known path is also `404` (the README says FastAPI answers 405) |
| Static page and `/media` through FastAPI | Hand-written allow-listed file serving, path-traversal check on `/media` |
| Same three users, same `/dev/users` and `/dev/token/{id}` endpoints, same environment variables, same chat / call / moderation / devices stack | the same |
| Database clock for call timestamps | Application clock (a kit-level difference, see [../backend/backend-node/01-overview.md](../backend/backend-node/01-overview.md), section 10) |
| `JwtAuth` rejects a token that has an `aud` claim | The Node `JwtAuth` accepts it (kit-level difference); irrelevant for the demo's own tokens |

### From a real deployment

| Demo server | A real app |
|---|---|
| Three fixed users in code | Your user table; implement `UserDirectory` |
| `GET /dev/token/:id` gives anyone a token (no `exp`) | Your login issues short-lived tokens; `JwtAuth` or your own `AuthAdapter` verifies them |
| Built-in JWT secret | A secret from your environment or secret manager |
| SQLite file, tables created on every start | PostgreSQL, with migrations |
| Local-disk uploads, public at `/media` | `S3Storage({ private: true })` with expiring links |
| No Redis, one process | `RedisBridge` and `hub.connections.start()` when you run several processes |
| Loose rate limits, call limit off | The kit's default limits or your own |
| No TURN unless you set it | A real TURN server for mobile data |
| Reports printed to the console | An `onReport` hook that notifies moderators, plus `adminDependency` for the review routes |
| No admin routes | `ModerationFeature({ adminDependency })` with your admin check |
| `http://` and `ws://`, no reverse proxy | HTTPS and WSS behind nginx or your platform's router |
| No health check, no migrations, no logging setup | Your own (see the deploy guide) |

## 9. Limitations

- Single process and single machine; no clustering.
- Browser calls use public STUN only (unless you set `TURN_SECRET`; the page itself still has no TURN, see the Python example), so they can fail between a phone on mobile data and a phone on Wi-Fi.
- The page has no UI for some newer features (for example unsend and clear chat); it ignores those messages. The web example covers them.
- It needs `backend/backend-node/dist` to exist; there is no build step inside the demo.
- Nothing here has been run against real Redis, S3, PostgreSQL, Apple or Expo push. PostgreSQL in particular is not verified for the kit at all.
- Conformance, last run 2026-10-26 against this server: **75 of 75** browser UI tests and **16 of 16** web e2e steps pass. In one earlier full run two call tests (`test_call.py`) failed under load and passed on rerun; the likely cause is a timing race in the test page, not confirmed against the Python server.
- The tests that use it need Chrome (and Windows, macOS or Linux with a Chrome install).

## 10. What to copy into your own backend

Copy the **wiring** from `server.mjs` (the hub, the features in the right order, `restListener` or an adapter, `hub.attach`, the schema creation) and replace each demo piece:

1. `StaticUserDirectory(USERS)` becomes a `UserDirectory` that reads your users.
2. `JwtAuth(SECRET)` becomes `JwtAuth(<your secret>, { claim: <your claim> })`, or an `AuthAdapter` for your own scheme.
3. The `better-sqlite3` Kysely instance becomes a `PostgresDialect` Kysely instance (and `ensureSchema` becomes your migration).
4. `LocalDiskStorage` becomes `S3Storage` (or your own `MediaStorage`).
5. Remove `/dev/*`, the page routes and the `/media` route.
6. Add your own rules through the policies: blocking and consent (`ChatPolicy`), credits (`CallPolicy`).
7. Add `RedisBridge` (and `await hub.connections.start()`) if you run more than one process.
8. Use Fastify or Express through `commskit-node/fastify` or `commskit-node/express` if your project already has one; the demo uses plain `node:http` only to stay dependency-free.

The step-by-step version, with a complete example for each mode and for Fastify, Express and plain `node:http`, is in
[../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md).
