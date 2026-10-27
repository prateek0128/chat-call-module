# commskit-node backend: overview

Folder: `comms-kit/backend/backend-node`. npm package name: `commskit-node` (version `0.1.0`, `backend/backend-node/package.json`). TypeScript, ESM, Node `>=20`.

This is file 1 of 3.
File 2: [keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md).
File 3: [using, running and deploying](03-using-running-and-deploying.md).

## Contents

1. [What it is](#1-what-it-is)
2. [Why it exists next to the Python backend](#2-why-it-exists-next-to-the-python-backend)
3. [Folder and module map](#3-folder-and-module-map)
4. [Entry points (what you import)](#4-entry-points-what-you-import)
5. [Three usage modes and the import-boundary rule](#5-three-usage-modes-and-the-import-boundary-rule)
6. [Main concepts](#6-main-concepts)
7. [Data it stores](#7-data-it-stores)
8. [How clients talk to it](#8-how-clients-talk-to-it)
9. [What it does NOT do](#9-what-it-does-not-do)
10. [Python vs Node: names and known deviations](#10-python-vs-node-names-and-known-deviations)
11. [Test status](#11-test-status)
12. [How wire parity is proven](#12-how-wire-parity-is-proven)

Everything here was checked against the code in `backend/backend-node/src`, `backend/backend-node/test`, `backend/backend-node/package.json` and
[`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). Anything not checked is marked "not verified".
The Python counterpart of this file is [`../backend-python/01-overview.md`](../backend-python/01-overview.md); the structure is the same on purpose.

---

## 1. What it is

A Node.js library (not a standalone service) that you install into a Node project (Fastify, Express, or plain `node:http`). It adds:

- 1:1 chat (text, files, replies, read receipts, typing, delete/unsend/clear).
- Voice/video call signalling for WebRTC (the server relays offers, answers and ICE candidates).
- Report and block.
- Device registration and push notifications (Expo for everyone, APNs VoIP for iOS CallKit).

Stack (from `package.json`): TypeScript (strict), Node `>=20` (checked here with Node 22.23.2), ESM only, `ws` (WebSocket), `kysely` (SQL query builder),
`jose` (JWT). Fastify and Express are optional adapters. Database drivers (`better-sqlite3` or `pg`), `ioredis`, the AWS SDK and `sharp`
are optional peer dependencies. Built with `tsup`, tested with `vitest`.

It speaks the wire protocol in [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md), so the existing clients (`mobile/`, `web/`, and the page in
`examples/backend/demo-server-python`) work against it unchanged. It is a **port of the Python backend** (`comms-kit/backend/backend-python`, package `commskit`).

## 2. Why it exists next to the Python backend

| Reason | Detail |
|---|---|
| Teams on Node | A team whose server is Node/TypeScript can add chat and calls without adding a Python service. |
| Same protocol | Same WebSocket frames, same REST routes, same error shapes (including FastAPI-style `{"detail": ...}` bodies). A client cannot tell which server it talks to. |
| Same database | Same table names and column names as the Python models (`chats`, `messages`, `calls`, `comms_*`). A database created by either backend works with the other (`backend/backend-node/README.md`; table names checked in `test/schema.test.ts`). |
| Same Redis keys | `presence:{uid}`, `presence_away:{uid}`, `came_online:{uid}`, `user_channel:{uid}`, `room_channel:{room}`, and rate-limit keys `ratelimit:...` (`src/core/redis.ts`, header comment and constants). Python and Node servers can share one Redis, for example during a migration. |

Sharing a database or Redis between a Python and a Node server at the same time is supported by design but **not verified here**
(no test runs both servers against one store). See section 10 for the differences you should know about before you try it.

## 3. Folder and module map

```
comms-kit/backend/backend-node/
  package.json            package metadata, exports map, dependencies, peer dependencies
  README.md               short reference (see the inconsistency note in section 3.9)
  tsconfig.json           strict TypeScript config
  tsup.config.ts          build: one bundle per entry point, ESM, node20 target
  vitest.config.ts        test config
  src/                    the package source
    index.ts              root entry: core + chat + ensureSchema (+ table types)
    schema.ts             ensureSchema(db) and KIT_TABLES: creates every kit table
    core/                 transport, auth, adapters, hub, events, devices, push, redis, s3 (always needed)
    chat/                 1:1 chat feature
    call/                 call signalling feature
    moderation/           block + report feature
    integration/          glue that needs more than one feature
    push/  redis/  s3/    thin entry points that re-export files from core/
    fastify/  express/    framework adapters
  test/                   vitest suite (SQLite in memory, no network) and golden fixtures
  scripts/dist-smoke.mjs  consumer-style check of the BUILT package (npm run smoke)
  dist/                   build output (generated by npm run build; not source)
```

### 3.1 `src/core` (always imported)

| Module | What it does | Main exports |
|---|---|---|
| `hub.ts` | `CommsHub`: registry of WebSocket handlers, hooks, event bus, REST routes, `install`, `attach`, `shutdown`. The object you create first. | `CommsHub`, `Feature`, `Handler`, `RoleResolver` |
| `websocket.ts` | The single `/ws/:token` endpoint (accept, auth, one frame at a time per socket). | used by `hub.attach` / `hub.handleUpgrade` |
| `connections.ts` | `ConnectionManager`: sockets per user, presence, rooms, fan-out, optional cross-worker bridge. | `ConnectionManager`, `PresenceBridge`, `USER_ROLE`, `SocketLike` |
| `adapters.ts` | The interfaces you implement (`AuthAdapter`, `UserDirectory`, `PushSender`, `MediaStorage`, `DeviceRegistry`) and the defaults. | `JwtAuth`, `AuthError`, `NullUserDirectory`, `StaticUserDirectory`, `NoopPush`, `LocalDiskStorage`, `UploadRejected`, `deleteMedia`, `resolveUserId` |
| `events.ts` | Small in-process async event bus (listener errors are logged, not thrown). | `EventBus` |
| `db.ts`, `ddl.ts` | Kysely helpers: `Db` type, dialect detection (sqlite or postgres), timestamp and boolean helpers. | `Db`, `Dialect`, `detectDialect`, `dbNow`, `dbTimestamp`, `dbBool` |
| `ratelimit.ts` | Per-user token-bucket limits, in memory. | `RateLimit`, `RateLimiter`, `Limiter` |
| `rest.ts`, `http.ts` | Framework-neutral REST route type, `HttpError`, path matching, and `restListener(hub)` for plain `node:http`. | `RestRoute`, `HttpError`, `restListener` |
| `logger.ts` | Kit-wide logger (default: warnings and errors to the console, prefixed `[commskit]`; info is silent). | `setLogger`, `silentLogger`, `Logger` |
| `util.ts`, `compat.ts`, `media.ts` | Python-compatible helpers (ISO timestamps, truthiness), the `PONG` legacy constant, media type from file extension. | `nowIso`, `PONG_TYPE`, `detectMediaType` |
| `devices.ts` | `comms_devices` table, `SqlDeviceRegistry`, `DevicesFeature` (`/devices` REST). Exposed through the `./push` entry. | `SqlDeviceRegistry`, `DevicesFeature` |
| `push.ts` | Push senders. Exposed through `./push`. | `ExpoPushSender`, `ApnsVoipSender`, `DevicePushRouter`, `callkitUuid` |
| `redis.ts` | Optional Redis presence + cross-worker delivery, and a shared rate limiter. Exposed through `./redis` (not `./core`). | `RedisBridge`, `RedisRateLimiter` |
| `s3.ts`, `mediaTools.ts` | Optional S3 storage, image thumbnails (`sharp`), video thumbnails and durations (`ffmpeg`/`ffprobe`). Exposed through `./s3`. | `S3Storage`, `makeImageThumbnail`, `probeDuration`, `makeVideoThumbnail` |

### 3.2 `src/chat`

| Module | What it does |
|---|---|
| `feature.ts` | `ChatFeature({ policy, storage, devices, config })`; `ChatConfig` and `defaultChatConfig()`; server-side `sendMessageAs`, `sendSystemMessage`, `deleteUserData`. |
| `handlers.ts` | WebSocket handlers: `req_users`, `get_messages`, `send_message`, `mark_read`, `typing`, `media_upload`, `delete_message`, `clear_chat`. Offline push. |
| `service.ts` | Database queries (`ChatService`), `ChatActionError`. |
| `router.ts` | REST routes under `/chats`. |
| `models.ts` | Tables `chats`, `messages`, `comms_message_hidden`, `comms_chat_cleared` (Kysely types and DDL). |
| `policy.ts` | `ChatPolicy` interface and `AllowAllChatPolicy` default. |
| `dto.ts` | `MessageDto` shaping for the wire. |

### 3.3 `src/call`

| Module | What it does |
|---|---|
| `feature.ts` | `CallFeature({ policy, config })`; `endCallsBetween`; `deleteUserData`. |
| `handlers.ts` | WebSocket handlers: `call_initiate`, `answer_call`, `reject_call`, `end_call`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `start_recording` (ignored). |
| `lifecycle.ts` | Ring timeout, disconnect grace, re-ring on reconnect, incoming/missed-call pushes (timers are `setTimeout` in the process). |
| `service.ts` | Database access (`CallService`), call log text, `CallInfo`. |
| `router.ts` | `POST /call/turn-credentials`, `POST /call/:callId/reject`. |
| `turn.ts` | `turnCredentials()`: coturn REST-API credentials (HMAC-SHA1). |
| `config.ts` | `CallConfig`: timings, push channels, TURN settings, rate limit. |
| `policy.ts` | `CallPolicy` interface, `CallDecision`, `allow()`, `deny()`, `AllowAllCallPolicy` default. |
| `bridge.ts` | `CallChatBridge` interface (implemented by `integration`). |
| `models.ts`, `payloads.ts`, `uuid.ts` | Table `calls`; frame shaping (including the "caller view"); `callkitUuid` (UUIDv5). |

### 3.4 `src/moderation`

| Module | What it does |
|---|---|
| `feature.ts` | `ModerationFeature({ onReport, notifyBlockedUser, adminDependency, contextProvider })`; `chatPolicy()` / `callPolicy()` wrappers; admin helpers `listReports`, `resolveReport`, `reportContext`; `deleteUserData`. |
| `handlers.ts` | WebSocket handlers `report_and_block`, `block`, `unblock`. |
| `router.ts` | REST under `/moderation` (admin routes only when `adminDependency` is set). |
| `policy.ts` | `ModerationChatPolicy` / `ModerationCallPolicy`: put the block list in front of your own policy. |
| `models.ts`, `service.ts` | Tables `comms_blocks`, `comms_reports`; database queries. |

### 3.5 `src/integration` (the only folder that imports several features)

| Export | What it does |
|---|---|
| `linkChatAndCall(chat, call)` | Calls get a `chat_id`, a "[Call Initiated]" chat entry that is rewritten at the end (for example "Voice call · 05:42"), and a `call_log` frame. Throws if the two features are on different hubs or if already linked. |
| `linkModeration(moderation, { chat, call })` | Block list in front of the chat/call policies; a live call between a blocked pair ends (`end_reason: "blocked"`); report context for admins. Throws if linked twice. |
| `deleteUserEverywhere(hub, userId)` | Account deletion across every installed feature that has `deleteUserData`, then emits `user.deleted`. Returns `{ featureName: result }`. |
| `ChatCallBridge`, `ModerationLink`, `CALL_PLACEHOLDER` | The objects behind the above; `CALL_PLACEHOLDER = "[Call Initiated]"`. |

### 3.6 `src/fastify`, `src/express`

| Folder | Exports | What it does |
|---|---|---|
| `src/fastify/index.ts` | `commskitPlugin` (also default export) | `app.register(commskitPlugin, { hub })`: registers every REST route, replaces Fastify's JSON parser so an empty body with a JSON content type is accepted (like FastAPI), attaches `/ws/:token` to `app.server`, and closes the hub on `app.close()` (`shutdownOnClose`, default true). |
| `src/express/index.ts` | `commskitRouter(hub)`, `attach(server, hub)` | A router with `express.json({ limit: "20mb" })` and every REST route; `attach` handles the WebSocket upgrade on the `http.Server` that runs your app. |

### 3.7 `test/` and `scripts/`

| Path | What it is |
|---|---|
| `test/*.test.ts` | 18 test files (section 11). Apps are built on SQLite in memory and driven through real `ws` sockets and `fetch`. |
| `test/golden/` | 76 JSON fixtures recorded from the Python backend (24 chat/REST, 40 call, 12 moderation) plus the three Python scripts that record them: `generate_golden.py`, `generate_call_golden.py`, `generate_moderation_golden.py`. |
| `test/helpers.ts`, `call.helpers.ts`, `moderation-env.ts` | Test harness (WebSocket test client, app builders). |
| `test/imports.test.ts` | Enforces the import-boundary rule (section 5). |
| `scripts/dist-smoke.mjs` | Imports every public entry **by package name** from the built `dist/` and runs chat, a call and a block over a real HTTP + WebSocket server. A working wiring example. |

### 3.8 `package.json` dependencies

| Kind | Packages | Needed for |
|---|---|---|
| Dependencies (installed automatically) | `jose ^5.9.6`, `kysely ^0.27.4`, `ws ^8.18.0` | everything |
| Peer, optional | `better-sqlite3 ^11.0.0` or `pg ^8.11.0` | a database (you need one of them) |
| Peer, optional | `fastify ^4.28 \|\| ^5`, `express ^4.19 \|\| ^5` | the adapters (or use plain `node:http`) |
| Peer, optional | `ioredis ^5.4.0` | `RedisBridge`, `RedisRateLimiter` |
| Peer, optional | `@aws-sdk/client-s3 ^3.600.0`, `@aws-sdk/s3-request-presigner ^3.600.0` | `S3Storage` (presigner only for `private: true`) |
| Peer, optional | `sharp ^0.33.0` | image thumbnails |
| Not a package | `ffmpeg`, `ffprobe` on `PATH` | video thumbnails and audio/video duration |

Push (Expo, APNs) needs no extra package: it uses the global `fetch` and `node:http2` (`src/core/push.ts`).

### 3.9 Inconsistencies noticed in the source tree (not fixed)

- `backend/backend-node/README.md` still says "Status: phase 1 = core + chat" and that call, moderation, devices/push, Redis and S3 "come next". The code contains all of them (this file and the tests cover them).
- `src/core/ratelimit.ts` and `src/core/connections.ts` still carry `TODO(phase2)` comments although `RedisRateLimiter` and `RedisBridge` exist in `src/core/redis.ts`.
- `src/core/adapters.ts` says the SQL `DeviceRegistry` ships "in phase 2"; it does (`SqlDeviceRegistry`).

## 4. Entry points (what you import)

From the `exports` map of `package.json`. Every entry is ESM only (`import`); there is no `require` entry (CommonJS projects must use dynamic `import()`).

| Import | What you get |
|---|---|
| `commskit-node` | Everything in `/core` and `/chat`, plus `ensureSchema`, `KIT_TABLES`, `KitDatabase` and the `calls`/blocks/reports table types. Pulls in chat code. |
| `commskit-node/core` | `CommsHub`, `JwtAuth`, adapters and defaults, `ConnectionManager`, `EventBus`, `RateLimit`, `RateLimiter`, `restListener`, `HttpError`, logger, helpers. **No chat, no call code.** |
| `commskit-node/chat` | `ChatFeature`, `ChatConfig`, `defaultChatConfig`, `ChatPolicy`, `AllowAllChatPolicy`, `ChatService`, `messageDto`, `ChatActionError`. |
| `commskit-node/call` | `CallFeature`, `CallConfig`, `defaultCallConfig`, `CallPolicy`, `CallDecision`, `allow`, `deny`, `AllowAllCallPolicy`, `CallService`, `CallInfo`, `turnCredentials`, `callkitUuid`. |
| `commskit-node/moderation` | `ModerationFeature`, `ModerationChatPolicy`, `ModerationCallPolicy`, `ModerationService`, `REPORT_CATEGORIES`, `REPORT_STATUSES`. |
| `commskit-node/integration` | `linkChatAndCall`, `linkModeration`, `deleteUserEverywhere`, `CALL_PLACEHOLDER`, `ChatCallBridge`, `ModerationLink`. |
| `commskit-node/push` | `SqlDeviceRegistry`, `DevicesFeature`, `ExpoPushSender`, `ApnsVoipSender`, `DevicePushRouter`, `callkitUuid`. |
| `commskit-node/redis` | `RedisBridge`, `RedisRateLimiter`, key prefix constants. Needs `ioredis`. |
| `commskit-node/s3` | `S3Storage`, media tools (`makeImageThumbnail`, `probeDuration`, `makeVideoThumbnail`). Needs the AWS SDK (and `sharp` / `ffmpeg` for thumbnails). |
| `commskit-node/fastify` | `commskitPlugin`. Needs `fastify`. |
| `commskit-node/express` | `commskitRouter`, `attach`. Needs `express`. |
| `commskit-node/package.json` | The package manifest. |

`test/imports.test.ts` and `scripts/dist-smoke.mjs` both check that the root and sub-entries share one class (for example `ChatFeature` from the root equals
`ChatFeature` from `/chat`), so you can mix import styles.

## 5. Three usage modes and the import-boundary rule

| Mode | You install | Notes |
|---|---|---|
| Chat only | `ChatFeature` | No call code is imported. |
| Call only | `CallFeature` | Call payloads carry `chat_id: null`; no chat message, no `call_log`. |
| Chat + call | `ChatFeature`, `CallFeature`, then `linkChatAndCall(chat, call)` | Calls show up inside the chat. |

`ModerationFeature` and `DevicesFeature` work with any of the three.

Import-boundary rule (enforced by `test/imports.test.ts`, which reads the source files):

```
core        ->  imports only core (and never fastify / express)
chat        ->  imports only core and chat
call        ->  imports only core and call (never chat)
moderation  ->  imports only core and moderation
integration ->  the only folder that may import several features
fastify, express -> import only core and themselves
```

So a call-only app that imports from `commskit-node/core` and `commskit-node/call` never loads chat code. Caveat: the root entry `commskit-node`
re-exports chat, so importing from the root loads chat. For a call-only app, import from the sub-entries (`/core`, `/call`, plus `ensureSchema` from the root
only if you accept loading chat). `ensureSchema` creates **all** tables, including chat tables (section 7).

## 6. Main concepts

| Concept | Meaning |
|---|---|
| `CommsHub` (`src/core/hub.ts`) | The one object you create: `new CommsHub({ auth, db, users, push, connections, rateLimiter, roleResolver, onHandlerError, cameOnlineCooldown, dialect, logger })`. It holds the adapters, the connection manager, the event bus, the WebSocket handler table and the REST routes. |
| Feature | A plug-in object with `name` and `install(hub)`: `ChatFeature`, `CallFeature`, `ModerationFeature`, `DevicesFeature`. Installing the same feature name twice throws `Feature '<name>' is already installed on this hub`. |
| `hub.install(feature)` | Calls `feature.install(hub)` and returns the feature: `const chat = hub.install(new ChatFeature({...}))`. Features register WebSocket handlers, REST routes and hooks. |
| Adapter | A small TypeScript interface (any object with the right methods works; no base class needed): `AuthAdapter` (token to user id), `UserDirectory` (names and avatars), `PushSender`, `MediaStorage`, `DeviceRegistry`. Each has a safe default except auth, which you must pass. |
| Policy | A host rule: `ChatPolicy` (may A message B? blocked? extra info) and `CallPolicy` (may A call B? credits?). Default: allow everything. |
| Event bus (`hub.events`) | In-process notifications: `user.connected`, `user.disconnected`, `user.came_online`, `user.deleted`, `chat.message_sent`, `chat.system_message_sent`, `chat.message_deleted`, `call.finalized`, `moderation.blocked`, `moderation.unblocked`, `moderation.reported`, `moderation.report_resolved` (list in the header of `src/core/events.ts`). Listener errors are logged, not raised. |
| Hooks | `hub.on("type", handler)` custom WebSocket frame types (registering again replaces the earlier handler), `hub.onConnect`, `hub.onDisconnect`, `onHandlerError`, `roleResolver`. |
| `Db` handle | Handlers receive `(userId, message, db)`, where `db` is the hub's Kysely instance (see section 10). |

Defaults of every adapter and policy, and what a real implementation does: file 2, section C.

## 7. Data it stores

`ensureSchema(db)` (`src/schema.ts`) creates these tables with `CREATE TABLE IF NOT EXISTS`, in this order (`KIT_TABLES`). Names and columns match the Python models
(checked in `test/schema.test.ts` on SQLite). There are no foreign keys to a users table; user ids are plain strings.

| Table | Module | Contents |
|---|---|---|
| `chats` | `chat/models.ts` | One row per pair of users. `user1_id < user2_id` always (a CHECK constraint); unique per pair. |
| `messages` | `chat/models.ts` | Every message: text or file fields, `message_type`, read/delivered flags, reply link, call-log fields (`is_call`, unique `call_id`). Unsent messages stay as `message_type "deleted"`. |
| `calls` | `call/models.ts` | One row per call: caller, receiver, status (`ringing`, `answered`, `ended`, `missed`, `rejected`), timestamps, duration, `end_reason`, and the SDP offer/answer and ICE candidates as text (these contain IP addresses; the kit never clears them). |
| `comms_devices` | `core/devices.ts` | One row per app install: `user_id`, unique `device_id`, `platform`, `expo_push_token`, `voip_token`, app/OS/model info, timestamps. |
| `comms_blocks` | `moderation/models.ts` | Who blocked whom (unique pair). |
| `comms_reports` | `moderation/models.ts` | Reports: reporter, reported, reason, category, message id, `status` (`open`, `resolved`, `dismissed`), resolution fields. |
| `comms_message_hidden` | `chat/models.ts` | "Delete for me": which user no longer sees which message. |
| `comms_chat_cleared` | `chat/models.ts` | "Clear chat": per user and chat, a watermark `up_to_message_id` and `cleared_at`. |

That is 8 tables, the same 8 as the Python backend. Uploaded files are not in the database, only their URL is; the bytes go to your `MediaStorage`.

Other state (not in the database): who is connected, presence and rooms are in process memory, or in Redis if you use `RedisBridge` (keys in section 2).
Rate-limit buckets are in memory, or in Redis with `RedisRateLimiter`. Call ring and disconnect-grace timers are `setTimeout` timers in the process that started them (see file 3, "scaling").

Database support: SQLite through `better-sqlite3` (what the tests use) and PostgreSQL through `pg`. For PostgreSQL the DDL text is generated and
checked for shape in `test/schema.test.ts`, but **never executed against a real PostgreSQL server in this repo's tests**. PostgreSQL is not verified.

## 8. How clients talk to it

- WebSocket: one endpoint, `wss://<host>/ws/<jwt>`. JSON text frames, each with a string `type`. Used for everything real-time.
- REST (Bearer token in the `Authorization` header): chat lists, history, mark read, device registration, TURN credentials, moderation, decline-from-notification.
- Full contract: [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). Frame and route lists are summarised in file 2, section B.
- Node attaches the WebSocket by listening to the `upgrade` event of an `http.Server` (`hub.attach(server)`); the Fastify and Express adapters do this for you.

## 9. What it does NOT do

Same list as the Python backend, plus Node specifics.

- No user table, no sign-up, no login, no password or token issuing. Your app issues the JWT; the kit only validates it.
- No user profiles. Names and avatars come from your `UserDirectory`; the default knows nobody.
- No admin UI. It has admin REST routes for reports (when you supply `adminDependency`) and nothing else.
- No media for calls: calls are peer-to-peer WebRTC. The server relays only signalling. The kit does not include a TURN server.
- No group chat: conversations are strictly 1:1.
- No call recording (`start_recording` is accepted and ignored).
- No health-check route, no metrics, no migrations. `ensureSchema` only creates missing tables; it never alters existing ones.
- No billing or credits. `CallPolicy` is where you put that.
- No push provider accounts. You bring the Expo token and, for iOS VoIP, the Apple key.
- No end-to-end encryption. Messages are stored in plain text in your database.
- No built-in serving of uploaded files. `LocalDiskStorage` writes files; you must serve them yourself.
- No CommonJS build, no browser build, no serverless support: it needs a long-running Node process with open sockets.
- No `Origin` check on the WebSocket (none in `src/core/websocket.ts`); the token in the path is the only protection.
- It does not call `hub.connections.start()` for you. With a `RedisBridge` you must call it (file 2, B.5; file 3, section 4).

## 10. Python vs Node: names and known deviations

### 10.1 Name mapping

| Python (`commskit`) | Node (`commskit-node`) |
|---|---|
| `CommsHub(auth=, session_factory=, users=, push=, ...)` | `new CommsHub({ auth, db, users, push, connections, rateLimiter, roleResolver, onHandlerError, cameOnlineCooldown })` |
| `ChatFeature(...).install(hub)` | `hub.install(new ChatFeature({ policy, storage, devices, config }))` |
| `ChatConfig(max_upload_bytes=...)` (snake_case) | `config: { maxUploadBytes: ... }` (camelCase, partial object merged over `defaultChatConfig()`) |
| `JwtAuth(secret, algorithm, claim)` | `new JwtAuth(secret, { algorithm, claim })` |
| `user_id_from_token` | `userIdFromToken` |
| `hub.ws_router()` + `hub.rest_router()` | `hub.attach(server)` (or the adapters) + `hub.restRoutes()` / `restListener(hub)` |
| `hub.on_connect`, `hub.on_disconnect` | `hub.onConnect(hook, allRoles?)`, `hub.onDisconnect(hook, allRoles?)` |
| `role_resolver`, `on_handler_error`, `came_online_cooldown` | `roleResolver`, `onHandlerError`, `cameOnlineCooldown` |
| `chat.send_message_as`, `send_system_message`, `delete_user_data` | `chat.sendMessageAs`, `chat.sendSystemMessage`, `chat.deleteUserData` |
| `link_chat_and_call`, `link_moderation`, `delete_user_everywhere` | `linkChatAndCall`, `linkModeration`, `deleteUserEverywhere` |
| `CommsBase.metadata.create_all` | `ensureSchema(db)` |
| `ConnectionManager(bridge=RedisBridge(url=...))` | `new ConnectionManager({ bridge: new RedisBridge({ url }) })` |
| `RedisRateLimiter(bridge)` | `new RedisRateLimiter(bridge)` |
| `ModerationFeature(on_report, admin_dependency, ...)` | `new ModerationFeature({ onReport, adminDependency, ... })`; `adminDependency` receives the REST context, not a FastAPI dependency |
| `bearer_dependency`, `Depends(hub.current_user)` | `hub.authenticate(headers)` returns the user id or throws `HttpError(401)` |
| Event names (`chat.message_sent`, `call.finalized`, ...) | identical |
| Redis keys, table names, wire frames | identical |

### 10.2 Known deviations (verified in the code)

| Topic | Python | Node | Why it matters |
|---|---|---|---|
| Clock | Reads the database clock (`SELECT now()`, `commskit/core/db.py`) | Uses the application clock: `dbNow = () => new Date()` (`src/core/db.ts:30`, used by `call/service.ts` and `chat/service.ts`) | App servers need synchronised clocks (NTP). Mixing Python and Node servers on one database mixes two clocks. |
| Per-frame database handle | One SQLAlchemy session per incoming frame | No session: handlers get the hub's Kysely instance as `db` (`src/core/db.ts` comment: "queries autocommit; use `db.transaction()`"). `CallLifecycle` finalising a call uses a real transaction | A handler of yours that needs atomicity must open `db.transaction()` itself. Size your pool for concurrent frames. |
| Validation error bodies | FastAPI generates `422` bodies for any bad parameter | Approximated: `validationError(...)` builds FastAPI-shaped bodies (`type`, `loc`, `msg`, `input`) only for the parameters the routes check (`int_parsing`, `greater_than_equal`, `less_than_equal`, `missing`); other `422` cases are plain strings (`src/core/rest.ts`, `chat/router.ts`) | A client that parses exact FastAPI `detail` arrays may see differences outside those cases. `test/golden/rest_422_status.json` covers one case. |
| Binary WebSocket frames | Not part of the protocol (not verified what Python does) | Decoded as UTF-8 text and handled like a text frame (`rawToString` in `src/core/websocket.ts`) | Not verified against Python; clients should send text frames only. |
| WebSocket frame size | uvicorn default 16 MiB | The `ws` library default of 100 MiB is used (`new WebSocketServer({ noServer: true })` sets no `maxPayload`; library default checked in `node_modules/ws/lib/websocket-server.js:74`) | Your proxy or `http.Server` setup, not the kit, limits frame size. |
| Server WebSocket pings | uvicorn sends protocol pings every 20 s by default | None: `WsEndpoint` sets no ping interval (`src/core/websocket.ts`) | Dead peers are noticed only when a send fails or the TCP connection closes; a proxy with a short idle timeout can drop quiet sockets. Use the client `ping` frame or raise proxy timeouts (file 2, B.6). |
| JWT checks | PyJWT: a token with an `aud` claim is rejected (no audience passed) | `jose` `jwtVerify` is called without an `audience` option, so a token with an `aud` claim is **accepted** (run once: `{uid, aud}` gave the user id) | Looser than Python. If you need audience checks, write your own `AuthAdapter`. |
| JWT secret length | PyJWT warns about short HS256 keys | `jose` accepted the 5-character secret I tried, without a warning | Choose a 32-byte secret yourself. |
| Token expiry | A token without `exp` is accepted | Same (a token without `exp` was accepted); an expired `exp` is rejected | Issue tokens with a short `exp`. |
| `UploadRejected` | Raise `ValueError` in `MediaStorage.upload` to reject a file | Throw `UploadRejected` (`src/core/adapters.ts:134`) | Any other error is re-thrown by the upload handler (`src/chat/handlers.ts:345-349`) and becomes a generic error frame, not a clean refusal with your text. |
| Cross-worker timers | asyncio tasks in the worker | `setTimeout` timers in the process; `hub.shutdown()` cancels them (`CallFeature.install` wraps `shutdown`) | Same limitation: a restart mid-ring loses that ring timer. |
| Start/stop of the bridge | Done in the FastAPI lifespan by you | Also done by you: `await hub.connections.start()`; `hub.shutdown()` stops it (`connections.stop()`). The Fastify and Express adapters do not call `start()` | Forgetting it means `RedisBridge` never connects (file 3). |
| HTTP framework behaviour | FastAPI: a JSON content type with an empty body is accepted | The Fastify adapter replaces the JSON parser to match; the Express adapter uses `express.json` (empty body gives `{}`); `restListener` returns `undefined` for an empty or invalid JSON body | The route handlers then answer with the same `422`/`400` shape as for a missing body. |
| Case and names | snake_case Python API | camelCase TypeScript API; wire frames stay snake_case | n/a |
| Logging | named `logging` loggers (`commskit.ws`, ...) | one logger with `info`/`warn`/`error`; default prints only warn and error with a `[commskit]` prefix; replace with `setLogger()` or the hub `logger` option | The "WS auth failed" line is `info`, so it is silent by default (file 2, B.2). |

Not compared (not verified): behaviour of PostgreSQL with BIGINT and timestamp columns (the `pg` driver returns BIGINT as a string by default; the code was only run on SQLite), Unicode handling beyond the code-point helpers in `src/core/util.ts`, and
timing details of ring and grace timers under load.

## 11. Test status

Ran once from `comms-kit/backend/backend-node` on 2026-10-26 (Windows 10, Node 22.23.2, npm 10.9.4, `ws` 8.22.0, `kysely` 0.27.6, `jose` 5.10.0):

```powershell
cd backend/backend-node
npx tsc --noEmit        # exit code 0, no errors
npx vitest run          # 18 test files passed; 172 tests passed, 1 skipped (173); duration 8.4 s
npm run build           # tsup: ESM and DTS build success for all 11 entries
npm run smoke           # 10 PASS lines, then "dist smoke test: all checks passed"
```

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed (exit 0) |
| `npx vitest run` | **172 passed, 1 skipped**, 18 files, 8.36 s |
| `npm run build` | success (JS about 0.2 s, type declarations about 16 s) |
| `npm run smoke` | all checks passed (root and `/chat` share one class; push, redis, s3 entries load; chat; call; call log in chat; block and refused message) |

The 1 skipped test is "real redis-server (optional)" in `test/redis.test.ts`: it runs only when a `redis-server` binary is available (`describe.skipIf(!haveRedisServer())`).
All other Redis tests use a hand-written in-memory fake (`FakeRedis`), so **a real Redis server was not exercised**.

Not verified in this repo's tests: real PostgreSQL (DDL text only), real Redis, real S3 (a fake `S3Operations` is injected), real Expo/APNs calls (injected `fetch` and HTTP/2 session fakes),
coturn, nginx, Docker, systemd, and mixed Python + Node servers on one database.

## 12. How wire parity is proven

| Evidence | What it shows | Status |
|---|---|---|
| Golden fixtures (`test/golden/**`, 76 JSON files) | Frames and REST bodies were recorded from the **Python** backend by `generate_golden.py`, `generate_call_golden.py` and `generate_moderation_golden.py`. `test/golden.test.ts`, `test/call-golden.test.ts` and `test/moderation-golden.test.ts` replay the same scripted exchanges against the Node server and require equal JSON after normalising ids and timestamps | Part of the 172 passing tests (checked here) |
| Schema test (`test/schema.test.ts`) | Table and column names equal the Python models | Passing |
| Redis fakes (`test/redis.test.ts`) | Key names and envelope shape (`{"origin","data"}`) | Passing against a fake; not against real Redis |
| Browser conformance: the 75 browser UI tests and the 16-step web e2e run against the Node demo server | Existing clients and tests, written for the Python server, pass unchanged | **Passing.** Last run on 2026-10-26: all 75 browser UI tests and all 16 web e2e steps pass against the Node demo server (`DEMO_BACKEND=node`; see [`../../example/backend-node-example.md`](../../example/backend-node-example.md)). Two call tests (`test_call.py`) failed once in an earlier full run under load and passed on rerun; the likely cause is a timing race in the test page, not the server (not confirmed against Python)|

The re-recording command (needs the Python backend installed) is in `backend/backend-node/README.md`: `python test/golden/generate_golden.py` (the three scripts are in `test/golden/`).
