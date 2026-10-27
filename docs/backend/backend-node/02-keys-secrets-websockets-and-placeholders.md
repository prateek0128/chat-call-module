# commskit-node backend: keys, secrets, WebSockets and placeholders

File 2 of 3. Previous: [overview](01-overview.md). Next: [using, running and deploying](03-using-running-and-deploying.md).

## Contents

- [A. Keys, secrets and configuration values](#a-keys-secrets-and-configuration-values)
  - [A.0 How configuration works in this kit](#a0-how-configuration-works-in-this-kit)
  - [A.1 Auth (JWT)](#a1-auth-jwt)
  - [A.2 Database](#a2-database)
  - [A.3 TURN (calls across networks)](#a3-turn-calls-across-networks)
  - [A.4 Push: Expo and APNs](#a4-push-expo-and-apns)
  - [A.5 Redis](#a5-redis)
  - [A.6 S3 / media storage](#a6-s3--media-storage)
  - [A.7 Media tools (ffmpeg, sharp)](#a7-media-tools-ffmpeg-sharp)
  - [A.8 Demo-server variables](#a8-demo-server-variables)
  - [A.9 Tunable settings with defaults](#a9-tunable-settings-with-defaults)
  - [A.10 Private vs public summary](#a10-private-vs-public-summary)
  - [A.11 Never do this](#a11-never-do-this)
- [B. WebSockets and REST](#b-websockets-and-rest)
  - [B.1 Endpoint and handshake](#b1-endpoint-and-handshake)
  - [B.2 Close codes, heartbeat, framing](#b2-close-codes-heartbeat-framing)
  - [B.3 Frame types](#b3-frame-types)
  - [B.4 REST routes](#b4-rest-routes)
  - [B.5 Scaling notes](#b5-scaling-notes)
  - [B.6 Reverse proxy for WebSockets](#b6-reverse-proxy-for-websockets)
- [C. Placeholders the integrator must replace or implement](#c-placeholders-the-integrator-must-replace-or-implement)
  - [C.1 Adapters and policies with default behaviour](#c1-adapters-and-policies-with-default-behaviour)
  - [C.2 Hooks and settings that default to "off"](#c2-hooks-and-settings-that-default-to-off)
  - [C.3 Demo-only values](#c3-demo-only-values)
  - [C.4 Things the kit leaves to you](#c4-things-the-kit-leaves-to-you)
  - [C.5 Where Smart Matrimony plugs in](#c5-where-smart-matrimony-plugs-in)

Source references use `file:line` relative to `comms-kit/backend/backend-node/` (line numbers as of 2026-10-26; they will drift).
All secret values below are dummies. Never copy them. Python counterpart: [`../backend-python/02-keys-secrets-websockets-and-placeholders.md`](../backend-python/02-keys-secrets-websockets-and-placeholders.md).

---

## A. Keys, secrets and configuration values

### A.0 How configuration works in this kit

The library reads very few environment variables itself. Almost everything is a constructor argument or an options object that your app fills in.

Environment variables read by `src/` code (verified with a search for `process.env` and `env.`):

| Variable | Read at | Purpose |
|---|---|---|
| `APNS_KEY`, `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` | `src/core/push.ts:431-438` (`ApnsVoipSender.fromEnv`) | iOS VoIP push. Returns `null` when not fully set |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `src/core/mediaTools.ts:31` (`findTool`: `<NAME>_PATH`) | optional path to ffmpeg/ffprobe |
| `HOSTNAME` | `src/core/connections.ts:92` | part of the per-process server id (`<HOSTNAME or "server">-<pid>-<random>`) |
| `PATH` / `Path`, `PATHEXT` | `src/core/mediaTools.ts:33-34` | where to look for `ffmpeg` / `ffprobe` |

Names such as `JWT_SECRET`, `DATABASE_URL`, `TURN_SECRET`, `TURN_URIS`, `REDIS_URL`, `EXPO_ACCESS_TOKEN`, `S3_BUCKET` are only a convention used in these docs and in
`examples/backend/demo-server-node/server.mjs`: your own code reads them and passes the values in. Use any names you like. Node does not load `.env` files by itself in older
versions; use your process manager's `EnvironmentFile`, `node --env-file=.env server.js` (Node 20.6+; not verified here), or `dotenv`.

### A.1 Auth (JWT)

Class: `new JwtAuth(secret, { algorithm = "HS256", claim = "uid" })` at `src/core/adapters.ts:27-52` (a plain string as the second argument is taken as the algorithm).
You can replace it with any object that has `userIdFromToken(token): string | Promise<string>`; see C.1.

| Item | Detail |
|---|---|
| Name (convention) | `JWT_SECRET` (the kit does not read it; you pass it to `new JwtAuth(...)`) |
| Read at | `adapters.ts:33` (constructor). An empty secret throws `JwtAuth needs a non-empty secret` |
| Required | Yes, if you use `JwtAuth`. Not needed if you write your own `AuthAdapter` |
| Purpose | Verifies the signature of the token the client sends. The kit never creates tokens |
| How to get | It must be the same secret your app already uses to sign login tokens. For a new app: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (works in PowerShell and bash) |
| Example (dummy) | `JWT_SECRET=0f3c...dummy...9a21` (64 hex chars) |
| Default | None |
| Visibility | **PRIVATE** (server only) |
| Security notes | Use at least 32 bytes. Node does **not** warn about a short secret (a 5-character secret was accepted when I tried). Anyone who has it can sign a token for any user id. Rotating it logs everyone out |

Related settings:

| Setting | Default | Notes |
|---|---|---|
| `algorithm` | `"HS256"` | Only this algorithm is accepted (`jwtVerify(..., { algorithms: [algorithm] })`, `adapters.ts:43`). The secret is encoded as UTF-8 bytes (`adapters.ts:36`), so it works for HMAC algorithms only. For RS256 you would need your own `AuthAdapter`; **not verified** |
| `claim` | `"uid"` | The token field holding the user id. Converted to a string (`5` becomes `"5"`). A missing or empty claim throws `AuthError` (`adapters.ts:47-48`) |

Behaviour I checked by running the built `JwtAuth` directly (2026-10-26):

| Token | Result |
|---|---|
| `{uid: "U1"}` without `exp` | accepted (the kit does not require expiry: your login code must set a short `exp`) |
| `{uid: "U1", aud: "x"}` | **accepted**. Differs from the Python backend, which rejects tokens with `aud`. `jwtVerify` is called without an `audience` option (`adapters.ts:43`) |
| `exp` in the past | rejected (`"exp" claim timestamp check failed`) |
| `{sub: "U1"}` with the default claim | rejected (`Token has no 'uid' claim`) unless you set `claim: "sub"` |
| `{uid: 5}` | accepted as `"5"` |

The token is checked once, when the WebSocket connects. A socket that is already open stays open after the token expires. The kit has no function that closes one user's
socket (none found in `src/`); use a short token lifetime and reconnect, or close the socket yourself through `hub.connections.userSockets` (not part of a documented API).

Where the token travels: in the WebSocket path (`/ws/<token>`) and, for REST, in the `Authorization: Bearer <token>` header (`src/core/hub.ts:181-192`, `hub.authenticate`).

### A.2 Database

The kit does not read a database URL. Your app creates a Kysely instance and passes it as `db`.

| Item | Detail |
|---|---|
| Name (convention) | `DATABASE_URL` |
| Read at | Your code. SQLite: `new Kysely({ dialect: new SqliteDialect({ database: new Database(path) }) })`. PostgreSQL: `new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }) })`. Passed as `new CommsHub({ db })` (`src/core/hub.ts:41`) |
| Required | Yes |
| Purpose | Stores chats, messages, calls, devices, blocks, reports |
| Drivers | SQLite: `better-sqlite3` (peer dependency). PostgreSQL: `pg` (peer dependency). Neither is installed for you |
| Example (dummy) | `postgresql://comms:CHANGE_ME@db.internal:5432/comms` |
| Default | None |
| Visibility | **PRIVATE** (contains the password) |
| Security notes | Use a dedicated DB user with only the rights the app needs. Require TLS to the database |

Dialect detection (`src/core/db.ts:8-13`) looks at the Kysely adapter name: it must contain `postgres` or `sqlite`, otherwise the hub constructor throws and you pass
`dialect: "postgres" | "sqlite"` yourself. Tables are created with `await ensureSchema(db)`.

Tested only on SQLite (`test/*.test.ts`). For PostgreSQL the DDL text is generated and its shape is checked in `test/schema.test.ts`, but it is **never executed against a real
PostgreSQL server in this repo**: PostgreSQL is **not verified**. The `pg` driver returns `BIGINT` columns as strings by default; whether every code path copes is not verified.
The kit uses the **application** clock (`new Date()`, `src/core/db.ts:30`), not the database clock, for call and message timestamps: keep your servers on NTP.

### A.3 TURN (calls across networks)

Calls are peer-to-peer. A TURN relay is needed when two phones cannot reach each other directly (mobile data, strict NAT). The kit hands out
credentials for your own coturn server using coturn's "REST API / `use-auth-secret`" scheme (`src/call/turn.ts`). The kit does not run TURN.

| Item | Detail |
|---|---|
| Name (convention) | `TURN_SECRET` |
| Read at | `CallConfig.turnSecret` (`src/call/config.ts:13`); used by `POST /call/turn-credentials` (`src/call/router.ts:11-16`) |
| Required | Optional. While unset, the route answers `503 {"detail":"TURN is not configured"}`. Calls on the same network or with friendly NATs can still work through public STUN (a client-side setting; not checked here) |
| Purpose | Shared secret between your API and coturn. The API signs a temporary username with it (HMAC-SHA1, base64) |
| How to get | You choose it (same command as for the JWT secret). Put the **same** value in coturn as `static-auth-secret` |
| Example (dummy) | `TURN_SECRET=7d1e...dummy...c03b` |
| Default | `null` |
| Visibility | **PRIVATE**. The temporary credentials that the route returns are public to the logged-in caller and expire |

| Setting | Default | Notes |
|---|---|---|
| `CallConfig.turnUris` (convention `TURN_URIS`, comma-separated) | `[]` | For example `turn:turn.example.com:3478?transport=udp` and `turns:turn.example.com:5349?transport=tcp`. Public information. You split the comma string yourself |
| `CallConfig.turnTtl` | `3600` seconds | Lifetime of each credential |

Response shape: `{ username, password, ttl, uris }`. The username is just the expiry timestamp (`"<unix expiry>"`): `router.ts:15` does not pass a user id to `turnCredentials()`,
although the function supports one (same as Python). Any logged-in user can request credentials; there is no per-user rate limit on this route. coturn setup is in file 3.

### A.4 Push: Expo and APNs

| Name | Read at | Required | Purpose | How to get | Example (dummy) | Default | Visibility |
|---|---|---|---|---|---|---|---|
| `EXPO_ACCESS_TOKEN` | Your code: `new ExpoPushSender({ accessToken })` (`src/core/push.ts:55`, `:105`) | Optional. Needed only if "Enhanced push security" is on in your Expo account | Sent as `Authorization: Bearer <token>` to `https://exp.host/--/api/v2/push/send` | expo.dev, account settings, access tokens | `EXPO_ACCESS_TOKEN=expo_dummy_0000` | `null` (no header sent) | **PRIVATE** |
| `APNS_KEY` | `push.ts:432` | One of `APNS_KEY` / `APNS_KEY_PATH` is required for iOS VoIP | Contents of the `.p8` key. Literal `\n` is turned into newlines (`push.ts:440`) | Apple Developer portal, Keys, create a key with APNs enabled; download `AuthKey_<KEYID>.p8` (downloadable once) | `-----BEGIN PRIVATE KEY-----\nDUMMY\n-----END PRIVATE KEY-----` | None | **PRIVATE** |
| `APNS_KEY_PATH` | `push.ts:433` | See above | Path to the `.p8` file (read when the sender is created, `push.ts:418`) | as above | `/etc/myapp/AuthKey_ABC123DEFG.p8` | None | **PRIVATE** (the file) |
| `APNS_KEY_ID` | `push.ts:434` | Yes for VoIP | 10-character key id (JWT `kid`) | shown next to the key | `ABC123DEFG` | None | Not secret, keep private anyway |
| `APNS_TEAM_ID` | `push.ts:435` | Yes for VoIP | Apple team id (JWT `iss`) | Apple Developer account, Membership | `TEAM123456` | None | Not secret |
| `APNS_BUNDLE_ID` | `push.ts:436` | Yes for VoIP | App bundle id. Topic becomes `<bundle>.voip` (not doubled if it already ends in `.voip`) | Xcode / app config | `com.example.myapp` | None | Public |
| `APNS_USE_SANDBOX` | `push.ts:438` | Optional | `1`, `true` or `yes` selects `api.sandbox.push.apple.com` (dev builds). Otherwise `api.push.apple.com` | n/a | `APNS_USE_SANDBOX=1` | off (production host) | Public |

How it behaves (read from `src/core/push.ts`; none of it run against Apple or Expo here):

- `ApnsVoipSender.fromEnv(registry?)` returns `null` unless (`APNS_KEY` or `APNS_KEY_PATH`) and `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` are all set. Then you simply do not get VoIP pushes.
- The provider JWT (ES256) is cached and re-signed every 50 minutes (`tokenRefresh`, must be under 60 minutes). Requests go over HTTP/2 (`node:http2`) with `apns-push-type: voip`, priority 10.
- `410`, `BadDeviceToken` and `Unregistered` remove the stored voip token. `ExpiredProviderToken` re-signs once and retries.
- Expo: batches of at most 100 messages; `DeviceNotRegistered` tickets remove that token; ticket ids are remembered and `pollReceipts()` / `startReceiptPoller(900)` check them later.
- Push failures never throw into your handlers (`hub.push` logs and swallows).
- `DevicePushRouter` picks the transport per device (`push.ts` header comment and class doc): iOS device with a voip token and a `voip` sender gets APNs VoIP for incoming calls (visible Expo push as fallback); Android with `androidCallStyle: "data"` gets a data-only Expo push; everything else a visible Expo push.
- Close senders on shutdown: `await push.aclose()` (`DevicePushRouter.aclose`).

### A.5 Redis

| Item | Detail |
|---|---|
| Name (convention) | `REDIS_URL` |
| Read at | Your code: `new RedisBridge({ url })` (`src/core/redis.ts:55-62`, `:81-94`), passed as `new ConnectionManager({ bridge })` into `new CommsHub({ connections })` |
| Required | Only when you run more than one process. Optional for one process |
| Purpose | Presence, cross-process message delivery (pub/sub), room broadcasts, `user.came_online` de-duplication; with `RedisRateLimiter`, shared rate limits |
| How to get | Managed Redis (Upstash, ElastiCache, Redis Cloud...) or your own server |
| Example (dummy) | `redis://:CHANGE_ME@redis.internal:6379/0` (use `rediss://` for TLS) |
| Default | None. Without a bridge everything is in-process memory |
| Visibility | **PRIVATE** |
| Needs | the `ioredis` package (optional peer dependency; imported lazily; the bridge throws `RedisBridge needs ioredis: npm install ioredis` if missing). You can also inject a client: `new RedisBridge({ client })` |
| Security notes | Set a password and keep Redis off the public internet. The kit stores only presence keys and pub/sub messages (which include message payloads in transit), plus rate-limit buckets |

Redis keys used (same as the Python backend): `presence:{uid}` (hash serverId to heartbeat epoch), `presence_away:{uid}`, `came_online:{uid}` (SET NX PX), `ratelimit:{action}:{uid}` (rate limiter, prefix configurable),
pub/sub channels `user_channel:{uid}` and `room_channel:{room}` (envelope `{"origin","data"}`) (`src/core/redis.ts:16-22`).

Important behaviours:

- You must call **`await hub.connections.start()`** after building the hub. Nothing in the kit, the Fastify plugin or the Express adapter calls it. Without it a configured `RedisBridge` never connects (searched `src/` for `.start()` calls).
- If Redis is unreachable when `start()` runs, the bridge only **logs a warning** (`Redis unavailable (...); running single-worker`, `redis.ts:128`, level `warn`, so it is visible with the default logger) and carries on without it. On several processes this silently breaks cross-process delivery. Alert on that log line.
- After a successful first connect, `ioredis` reconnects with backoff (200 ms steps up to 2 s). While down, bridge calls are logged and ignored and `RedisRateLimiter` falls back to memory.
- Defaults: heartbeat 30 s, stale after 90 s, presence key TTL 120 s, away key TTL 12 h (`redis.ts:90-93`).
- Tested only against a hand-written fake Redis (`test/redis.test.ts`) and, if a `redis-server` binary is found, one real-server test (skipped in my run). A real shared Redis is **not verified**.

### A.6 S3 / media storage

| Item | Detail |
|---|---|
| Class | `new S3Storage({ bucket, region?, client?, prefix = "", publicBaseUrl?, private = false, presignExpires = 604800, thumbnails = true, durations = true, extraPutArgs? })` (`src/core/s3.ts:53-65`, `:112`). Import from `commskit-node/s3` |
| Needs | `@aws-sdk/client-s3` (and `@aws-sdk/s3-request-presigner` when `private: true`), both optional peers, imported lazily. `sharp` for image thumbnails, `ffmpeg` for video thumbnails |
| Bucket name | Required (an empty value throws `S3Storage needs a bucket`). Example `my-app-chat-media` |
| Region | Optional, passed to `new S3Client({ region })` (`s3.ts:72`). If omitted, the AWS SDK decides (for example `AWS_REGION`) |
| Credentials | **Not handled by the kit.** The AWS SDK v3 default credential chain: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), `AWS_PROFILE`, shared credentials file, or an IAM role (best on AWS) |
| Needed IAM actions | `s3:PutObject`, `s3:GetObject` (also needed to make presigned GET URLs work), `s3:DeleteObject` on `arn:aws:s3:::BUCKET/PREFIX*`. Derived from the commands the code sends (`PutObjectCommand`, `DeleteObjectCommand`, `GetObjectCommand` presigned) |
| Example (dummy) | `AWS_ACCESS_KEY_ID=AKIADUMMYDUMMY0000`, `AWS_SECRET_ACCESS_KEY=dummy/dummy/dummy` |
| Visibility | **PRIVATE** (credentials). Object URLs are public only if you leave the default `private: false` and open the bucket |

Facts to know:

- **`private: false` is the default.** URLs then look like `https://BUCKET.s3.REGION.amazonaws.com/KEY` and only work if the bucket or objects are publicly readable. For chat media use `private: true` (presigned URLs).
- With `private: true`, the presigned URL is stored in `messages.file_url` when the file is uploaded. It expires after `presignExpires` (default and maximum 7 days; a larger value throws). The kit does not refresh old URLs when messages are loaded; `storage.presign(fileUrl)` exists (`s3.ts:172`) and only your code calls it. Plan for this (C.4).
- `messages.file_url` and `thumbnail_url` are `VARCHAR(500)` (`src/chat/models.ts:80,84`). Presigned URLs made with temporary (session-token) credentials can be longer than that, and PostgreSQL would then reject the insert. Not verified; test with your credentials.
- Key layout: `{prefix}chat/{chatId}/{mediaType}/{unixSeconds}_{8 hex}_{safeName}`; thumbnails `..._thumb.jpg` next to it. `delete()` removes the object and its thumbnail.
- Real S3 is **not verified** (tests inject a fake `S3Operations`, `test/s3.test.ts`).

### A.7 Media tools (ffmpeg, sharp)

| Item | Read at | Required | Purpose | Default |
|---|---|---|---|---|
| `FFMPEG_PATH` | `src/core/mediaTools.ts:31` (via `findTool("ffmpeg")`, `:114`) | Optional | Path to `ffmpeg` for video thumbnails | found on `PATH` |
| `FFPROBE_PATH` | same (`findTool("ffprobe")`, `:97`) | Optional | Path to `ffprobe` for audio/video duration | found on `PATH` |
| `sharp` package | `mediaTools.ts:45-52` (lazy import) | Optional | Image thumbnails (300 x 300 JPEG that fits) | not installed: a warning is logged and the thumbnail is `null` |

Without the tools, thumbnails or durations are simply `null`; an upload never fails because of them. These helpers are used by `S3Storage`. `LocalDiskStorage` does not make thumbnails (checked: no call in `adapters.ts`).

### A.8 Demo-server variables

Used only by `examples/backend/demo-server-node/server.mjs` (the Node demo server; see [`../../example/backend-node-example.md`](../../example/backend-node-example.md)). **Not for production.** Values are from `examples/backend/demo-server-node/README.md` and `server.mjs` as they stood on 2026-10-26.

| Variable | Default | Meaning |
|---|---|---|
| `COMMS_FEATURES` | `chat,call` | Comma list: `chat`, `call` or both |
| `COMMS_DEMO_DATA` | `examples/backend/demo-server-node/.demo_data` | Folder for `demo.db` (SQLite) and `media/` |
| `COMMS_DEMO_SECRET` | `local-demo-secret-change-me-0000` | JWT secret of the demo (see C.3) |
| `COMMS_CORS_ORIGINS` | unset (CORS off) | Comma-separated allowed origins, only for a separately hosted web client |
| `ANDROID_CALL_STYLE` | `data` | `data` or `notification` |
| `TURN_SECRET`, `TURN_URIS` | unset | See A.3 |
| `EXPO_ACCESS_TOKEN`, `APNS_*` | unset | See A.4 |
| `PORT` (also `--port`), `--host` | `8000`, `127.0.0.1` | Listen address |
| `DEMO_BACKEND` | unset | Not read by the server: read by the Python browser-test launcher and the web-app e2e launcher to start this server instead of the Python one (see the example doc) |

### A.9 Tunable settings with defaults

`ChatConfig` (`src/chat/feature.ts:10-44`). Pass a partial object: `new ChatFeature({ config: { maxTextLength: 2000 } })`; it is merged over `defaultChatConfig()`.

| Field | Default | Meaning |
|---|---|---|
| `maxUploadBytes` | 10 MiB (`10 * 1024 * 1024`) | Max decoded file size for `media_upload` |
| `defaultPageSize` / `maxPageSize` | 10 / 100 | `get_messages` paging |
| `pushPreviewChars` | 120 | Push body length |
| `pushChannel` | `"messages"` | Android channel id |
| `maxTextLength` | 4000 | 0 = unlimited |
| `messageRate` | `new RateLimit(20, 10)` | 20 messages per 10 s per user; `null` = off |
| `uploadRate` | `new RateLimit(5, 60)` | 5 uploads per 60 s |
| `typingRate` | `new RateLimit(5, 5)` | over the limit: dropped silently |
| `unsendWindowSeconds` | 3600 | 0 = no limit, -1 = unsend disabled |
| `systemSenderId` / `systemPushTitle` | `null` / `null` | For `sendSystemMessage` |

`CallConfig` (`src/call/config.ts:4-32`):

| Field | Default | Meaning |
|---|---|---|
| `ringTimeout` | 45 s | ringing then missed (`no_answer`) |
| `ringingDisconnectGrace` | 20 s | socket lost while ringing, then missed |
| `answeredDisconnectGrace` | 90 s | socket lost while answered, then ended |
| `maxCallHours` | 4 | answered calls older than this no longer count as live |
| `ringWindowSlack` | 15 s | extra time a ringing row counts as live |
| `ringtoneChannel` / `missedChannel` | `call_ringtone` / `messages` | Android channels |
| `turnSecret` / `turnUris` / `turnTtl` | `null` / `[]` / 3600 | See A.3 |
| `initiateRate` | `new RateLimit(5, 60)` | `call_initiate` per caller; `null` = off |

`RateLimit` (`src/core/ratelimit.ts:8-19`): `new RateLimit(count, seconds)` is a token bucket that holds `count` tokens and refills `count / seconds` per second. It throws if `count < 1` or `seconds <= 0`.
Rate-limit keys are `<action>:<userId>` (`chat.message:U1`, `chat.upload:U1`, `chat.typing:U1`, `call.initiate:U1`). Rejections reply `{type:"error", code:"rate_limited", retry_after}` (REST: HTTP 429 with `Retry-After`).

Other settings:

| Setting | Default |
|---|---|
| `new CommsHub({ cameOnlineCooldown })` | not set; the connection manager default is `0` (only de-duplicates simultaneous connects; Redis de-dupe window 10 s via `cameOnlineDedupeSeconds`) |
| `new RateLimiter(maxKeys = 100_000)` | in-memory, LRU |
| `new LocalDiskStorage(root = "comms_media", baseUrl = "/media")` | relative to the working directory |
| `new RedisBridge({ heartbeatSeconds, staleSeconds, presenceTtlSeconds, awayTtlSeconds })` | 30 / 90 / 120 / 43200 |
| `new RedisRateLimiter(source, prefix = "ratelimit:", fallback?)` | falls back to an in-memory limiter when Redis fails |
| `new ExpoPushSender({ batchSize = 100, timeout = 10, sound = "default", receiptBatchSize = 1000, maxPendingTickets = 50_000, receiptTtl = 86400 })` | `src/core/push.ts:96-125` |
| `new ApnsVoipSender({ expiration = 45, tokenRefresh = 3000, timeout = 10, useSandbox = false })` | seconds |
| `new DevicePushRouter({ androidCallStyle = "notification" })` | `"data"` only if your Android app draws its own call UI |
| `new S3Storage({ private = false, presignExpires = 604800, thumbnails = true, durations = true })` | see A.6 |

### A.10 Private vs public summary

| PRIVATE (server only: never in a phone app, web bundle, repo or log) | Public / low risk |
|---|---|
| `JWT_SECRET` | `TURN_URIS` |
| `DATABASE_URL` | `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` |
| `TURN_SECRET` | `ChatConfig` / `CallConfig` timings and limits |
| `EXPO_ACCESS_TOKEN` | Temporary TURN credentials (expire after `turnTtl`) |
| `APNS_KEY` / `.p8` file (and treat `APNS_KEY_ID`, `APNS_TEAM_ID` as private) | The user's own JWT (it is theirs, but see A.11) |
| `REDIS_URL` | |
| AWS keys / `AWS_SECRET_ACCESS_KEY` | |
| `COMMS_DEMO_SECRET` | |

### A.11 Never do this

- Never commit secrets (`.env`, `.p8`, AWS keys). Keep `.env` in `.gitignore`; use your host's secret manager. If one leaks, rotate it.
- Never put `JWT_SECRET`, `TURN_SECRET`, the APNs key or AWS keys in client code, in `app.json`/`eas.json`, in an `EXPO_PUBLIC_*` variable or in a `VITE_*` variable. Everything in a client bundle is readable by anyone.
- Never sign tokens in the client. The client only receives a token from your login endpoint. The demo's `/dev/token/:id` is the opposite and exists only for local testing.
- Never deploy `examples/backend/demo-server-node/server.mjs` (or the Python demo) or leave `/dev/token/:id` reachable.
- Never use a default or shared secret (`local-demo-secret-change-me-0000`).
- Never issue tokens without `exp`.
- Never expose the database, Redis or coturn admin ports to the internet.
- Never serve `LocalDiskStorage` files from a public, unauthenticated folder for real user data.

**The token is in the URL path (`/ws/<jwt>`).** It therefore appears in:

- your own request logger if you log `req.url` (Fastify's default logger logs the URL of **HTTP** requests; for the upgrade request the kit handles the `upgrade` event itself, so Fastify's request log does not see it: checked, the log of the Fastify sample had no `/ws/` line),
- nginx / load-balancer access logs,
- error trackers or APM tools that record URLs, and any `http.Server` `'upgrade'` listener of your own that logs the URL.

The kit itself does not log the token. The auth failure log (`src/core/websocket.ts:51`) prints only the error text and at `info` level (silent with the default logger). To redact:

- Do not log `req.url` for upgrade requests in your own code. In Fastify, set `disableRequestLogging` or a custom `serializers.req` that masks `/ws/`.
- nginx: log a masked request line. Add in the `http {}` block (not verified by running nginx here):

```nginx
map $request $request_redacted {
    "~^(?<verb>\S+)\s+/ws/\S+(?<tail>\s+\S+)$"  "$verb /ws/[redacted]$tail";
    default                                     $request;
}
log_format redacted '$remote_addr - [$time_local] "$request_redacted" $status $body_bytes_sent';
access_log /var/log/nginx/access.log redacted;
```

- Also mask `/ws/` paths in any APM/Sentry URL scrubbing rules, and in ALB/Cloudflare logs.
- Keep JWT lifetimes short, so a leaked log line is worth little.

---

## B. WebSockets and REST

Contract: [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). This section summarises it and adds what the Node code does.

### B.1 Endpoint and handshake

| Item | Value |
|---|---|
| Path | `/ws/:token` (fixed: `/^\/ws\/([^/]+)$/` in `src/core/websocket.ts:16-22`; the path cannot be changed, unlike Python's `ws_router(path=...)`). A query string after the path is ignored |
| URL | `wss://<host>/ws/<jwt>` (`ws://` only for local development) |
| Mounted by | `hub.attach(server)` on a `node:http` / `node:https` server (listens for the `upgrade` event and handles only `/ws/...` URLs, leaving other upgrade paths to other listeners), or `app.register(commskitPlugin, { hub })` (Fastify), or `attach(server, hub)` (Express). Advanced: `hub.matchesWs(url)` and `hub.handleUpgrade(req, socket, head)` if you route upgrades yourself |
| Auth | The JWT in the path, checked by your `AuthAdapter`. No header and no query-string authentication |

Sequence (`src/core/websocket.ts`):

1. The server **accepts** the WebSocket upgrade first (`wss.handleUpgrade`, line 34).
2. Then it validates the token. On any error it closes with code **1008**, reason `"Invalid token"` (line 52). (Accept-then-close is on purpose, so clients see 1008 instead of an HTTP error.) A URL that does not match `/ws/<token>` is destroyed without a response (line 30).
3. It asks `roleResolver` for the user's role (default `"user"`), registers the socket, announces presence to the user's conversation partners (if chat is installed), and runs `onConnect` hooks. A user may hold many sockets; every event goes to all of them.
4. For a call-feature app, a call that is still ringing for this user is sent again on the new socket, with the stored offer SDP (`CallLifecycle.onConnect`).
5. Frames are then processed **one at a time per socket, in arrival order** (a promise chain, line 47).

### B.2 Close codes, heartbeat, framing

| Item | Behaviour |
|---|---|
| Close `1008` | Invalid, expired or missing-claim token (`"Invalid token"`) |
| Close `1011` | Crash while setting the connection up (`"Internal server error"`, line 67) |
| Normal close | Client closes; the kit removes the socket. When the last socket of a user closes, offline hooks and `user_status: offline` run (after a check that the user did not reconnect meanwhile) |
| Frame format | Text frames containing one JSON object with a string `type`. Binary frames are not part of the protocol; the Node server decodes them as UTF-8 text and treats them like text frames (`rawToString`, line 113). Python behaviour for binary is not verified |
| Bad frames | Not JSON: `{"type":"error","error":"Invalid JSON"}`. JSON but not an object: `{"type":"error","error":"Message must be a JSON object"}`. Handler exception: `{"type":"error","error":"Message processing failed: <msg>"}`. Unknown `type`: ignored, no reply |
| App-level heartbeat | Client sends `{"type":"ping"}`, server replies `{"type":"PONG","timestamp":...}` (upper case on purpose, `src/core/compat.ts`). The mobile client's `pingIntervalMs` default is `0` (off) (`mobile/src/core/CommsClient.ts:126`, from the Python doc; not re-checked) |
| Server-initiated pings | **None.** Unlike uvicorn (which pings every 20 s by default), `WsEndpoint` sets no ping interval and the code never calls `ws.ping()`. A silently dead connection stays "online" until a send fails or TCP closes it. Mitigate with client pings and your proxy timeouts, or add your own interval over `hub.wsServer.clients` (not part of the kit; not tested) |
| Redis heartbeat | With `RedisBridge`, each socket refreshes the Redis presence key every `heartbeatSeconds` (30 s) (`websocket.ts:62`). This is not a frame |
| Idle timeout | None in the kit. Your proxy/load balancer decides (see B.6) |
| Max frame size | The kit sets none, so the `ws` library default applies: 100 MiB (`node_modules/ws/lib/websocket-server.js:74`). A 10 MiB upload is about 13.4 MiB as base64, so the default fits. If you want a smaller cap, replace the server's option yourself (not exposed by the kit) or limit at the proxy |
| Presence | `{"type":"user_status","status":"online"}` or `"away"` from the client (foreground/background); partners get `{"type":"user_status","user_id","status","timestamp"}` |

### B.3 Frame types

Summary only. Payload details: [`PROTOCOL.md`](../../archive/PROTOCOL.md) sections 2 to 4, 7 and 9. The handler names below were read from `hub.on(...)` calls in `src/`.

Client to server (C to S):

| Group | `type` values | Needs feature | PROTOCOL |
|---|---|---|---|
| Core | `ping`, `user_status` | always (`src/core/hub.ts:88-93`) | section 2 |
| Chat | `req_users`, `get_messages`, `send_message`, `mark_read`, `typing`, `media_upload`, `delete_message`, `clear_chat` | chat | sections 3, 9 |
| Call | `call_initiate`, `answer_call`, `reject_call`, `end_call`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `start_recording` (ignored) | call | section 4 |
| Moderation | `report_and_block`, `block`, `unblock` | moderation | section 7 |
| Host extras | anything you register with `hub.on("type", handler)` (a later registration replaces an earlier handler of the same type) | n/a | section 3, "Host extensions" |

Server to client (S to C):

| Group | `type` values | PROTOCOL |
|---|---|---|
| Core | `PONG`, `user_status`, `error` | sections 1, 2 |
| Chat | `res_users`, `req_users_error`, `res_messages`, `new_message`, `message_sent`, `media_upload_success`, `chat_read`, `messages_read`, `delivery_status`, `typing_status`, `message_deleted`, `chat_cleared` | sections 3, 9 |
| Call | `call_initiated`, `incoming_call`, `call_ringing`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `call_answered`, `call_rejected` (also used for "busy"), `call_ended`, `call_missed`, `call_log` (only with chat linked), `error` with `context:"call"` | section 4 |
| Moderation | `user_blocked`, `blocked_by_user`, `user_unblocked`, `unblocked_by_user`, `report_received`, `error` with `context:"moderation"` | section 7 |

These server frame lists are taken from the Python doc and the PROTOCOL document; the Node golden tests replay the same exchanges (file 1, section 12), but I did not re-derive every frame name from the Node source.

Error shapes you will see: `{type:"error", error, code:"rate_limited", retry_after}`, `{..., code:"too_long", max}`, `{..., code:"not_allowed"|"not_found"|"window_expired"}` and call-policy errors with `context:"call"` (for example 402/403 credit info passed through from your `CallPolicy`).

### B.4 REST routes

All routes need `Authorization: Bearer <token>` unless stated (a missing or non-Bearer header is `401 {"detail":"Not authenticated"}`, a bad token `401 {"detail":"Invalid token"}`, `src/core/hub.ts:181-192`).
Routes exist only when the feature is installed **before** the adapter reads `hub.restRoutes()` (Fastify plugin registration, `commskitRouter(hub)`, `restListener(hub)`): they take a snapshot of the routes at that moment.
Errors use the FastAPI shape `{"detail": ...}`; an uncaught crash in a route answers `500 {"detail":"Internal Server Error"}`.

| Method and path | Feature | Purpose |
|---|---|---|
| `POST /chats/start?candidate_id=ID` | chat | create or get the chat with a user |
| `POST /chats/send` | chat | send a text message (same rules as WS `send_message`) |
| `POST /chats/read` | chat | mark read by `chat_id` or `candidate_user_id` |
| `GET /chats/:userId` | chat | conversation list (only for yourself, else 403) |
| `GET /chats/:chatId/messages?limit=50&offset=0` | chat | message history (`limit` 1 to 100, `offset` at least 0; otherwise 422) |
| `POST /chats/:chatId/read` | chat | mark chat read |
| `GET /chats/:userId/unread-count` | chat | unread total (self only) |
| `GET /chats/:userId/online-status` | chat | online flag (self or someone you chat with) |
| `POST /chats/expo/push/token`, `POST /chats/expo/push/token/remove` | chat (only when `ChatFeature({ devices })` is given and `DevicesFeature` is not installed first) or devices (legacy routes) | legacy push token routes |
| `POST /devices`, `DELETE /devices/:deviceId` | devices | register / remove an app install (`device_id` required, `platform` one of ios, android, web) |
| `POST /call/turn-credentials` | call | temporary TURN credentials (503 if not configured) |
| `POST /call/:callId/reject` | call | decline from a notification while the app has no socket |
| `GET /moderation/blocks`, `POST /moderation/blocks`, `DELETE /moderation/blocks/:blockedId` | moderation | block list |
| `POST /moderation/reports` | moderation | report a user (`reason` required) |
| `GET /moderation/admin/reports`, `POST /moderation/admin/reports/:reportId`, `GET /moderation/admin/reports/:reportId/context` | moderation, only when `adminDependency` is set | admin review (auth is your dependency, not the Bearer user) |

Sources: `src/chat/router.ts`, `src/call/router.ts`, `src/moderation/router.ts`, `src/core/devices.ts`. There is no health-check route and no docs route added by the kit. The built-in `node:http` listener (`restListener`)
answers `false` when nothing matched, and you decide the 404. Route matching is by segment count and `:param` placeholders in registration order; the first match wins.

### B.5 Scaling notes

| Topic | Behaviour (from reading the code) |
|---|---|
| One process, no Redis | Everything works. Connections, presence, rooms, rate-limit buckets and call timers live in process memory |
| Several processes (cluster workers, PM2 cluster, several containers), **no** Redis | `ConnectionManager.send()` delivers only to sockets in the same process (`src/core/connections.ts`, `send`/`sendLocal`). A user connected to another process looks offline: the message is saved but the live `new_message` frame is not delivered (the recipient gets a push instead, the sender sees `is_delivered: false`), an incoming call is push only, typing, presence and read-receipt frames to that user are lost, and `is_online` answers wrongly. Rate limits are counted per process. **Run exactly one process without Redis.** (Reasoned from the code; not tested with two processes) |
| Several processes **with** `RedisBridge` | `send()` publishes to `user_channel:{uid}` when the user's presence shows another server id; presence is shared; `broadcastRoom` crosses processes; `user.came_online` is de-duplicated. **Sticky sessions are not required**: REST is stateless and any process can hold any WebSocket. Pass `new RedisRateLimiter(bridge)` so limits are shared too. Tested against a fake Redis shared by two `ConnectionManager`s (`test/redis.test.ts`) |
| Lifecycle | Call `await hub.connections.start()` at startup (needed for the bridge consumer) and `await hub.shutdown()` at shutdown (closes sockets, cancels call timers, waits briefly for background tasks, stops the bridge). The Fastify plugin calls `hub.shutdown()` on `app.close()`; with Express and plain `node:http` you call it yourself |
| Call timers | The ring timeout and disconnect-grace timers are `setTimeout`s inside the process that started them (`src/call/lifecycle.ts:146`). If that process restarts mid-ring, the timer is lost. Busy detection stops counting a ringing call after `ringTimeout + ringWindowSlack` (60 s by default), but the row can stay `ringing` until something finalizes it. Not tested |
| Redis down | Bridge calls swallow errors and log; the rate limiter falls back to memory. Cross-process delivery stops until Redis returns |
| DB connections | Each handler query uses the hub's Kysely pool; size `pg.Pool({ max })` for concurrent frames, not for connected users. Frames from one socket run one at a time |
| Event loop | One Node process runs everything on one thread: image thumbnails (`sharp`) and `ffmpeg` run off-thread/child processes, but a slow `UserDirectory` or `CallPolicy` blocks only its own frame. Load testing was not done |
| Mixed Python + Node fleet | Redis key names and message envelopes are shared by design (file 1, section 2); not verified with a real Python and a real Node server together |

### B.6 Reverse proxy for WebSockets

A proxy must forward the HTTP/1.1 upgrade and must not time out idle sockets too early. Because the Node server sends **no** protocol pings (B.2), the proxy timeout matters more than with uvicorn. Sample nginx (untested here):

```nginx
# in http {}
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

upstream comms_app { server 127.0.0.1:8080; keepalive 32; }

server {
    listen 443 ssl http2;
    server_name api.example.com;
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    client_max_body_size 12m;            # REST uploads, if any

    location /ws/ {
        proxy_pass http://comms_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout  3600s;       # default 60s would drop idle sockets
        proxy_send_timeout  3600s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://comms_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- Set an idle timeout of at least 120 s on any load balancer. AWS ALB defaults to 60 s; raise it. Have the client send `{"type":"ping"}` regularly if it can, because no server ping keeps the socket active.
- Use `wss://` in production. Browsers also block microphone access (calls) on plain HTTP except on `localhost`.
- If your app has a response-cache or auth middleware, make sure it ignores `/ws/` and does not cache `/chats/...` (see file 3).
- If Node sits behind a proxy, `req.socket.remoteAddress` is the proxy; the kit does not use client IPs anywhere (none found in `src/`).

---

## C. Placeholders the integrator must replace or implement

The kit is generic. Anything that depends on your product (who is a user, who may talk to whom, what a call costs, where files live) is an interface with a safe default. The defaults make a demo work; most are wrong for production.

### C.1 Adapters and policies with default behaviour

| Interface | Defined and defaulted in | Default behaviour | Why it is a placeholder | What a real implementation should do |
|---|---|---|---|---|
| `AuthAdapter` (`userIdFromToken`) | `src/core/adapters.ts:21`; built-in `JwtAuth` at `:27` | You must pass one (`auth` is required by `CommsHub`); no default object. `JwtAuth` handles HS256 + `uid` claim only | Tokens are your product's | Reuse your existing token decoder (throw on invalid). Return the user id as a string. Can be sync or async |
| `UserDirectory` (`getProfiles(ids)`) | `adapters.ts:65` (`NullUserDirectory` at `:71`); also `StaticUserDirectory` at `:78` | Knows nobody: names fall back to the id (lists) or "Someone" (push/call), avatar `null` | The kit has no user table | One batched query returning `{ [id]: { name, avatar } }` for the ids it knows. Called often; keep it fast. Failures are logged and treated as "unknown" (`hub.profiles`) |
| `PushSender` (`send(userId, title, body, data, channel, ttl)`) | `adapters.ts:92` (`NoopPush` at `:104`) | Does nothing: **no push is ever sent** | Push needs your tokens and provider accounts | `DevicePushRouter` with `SqlDeviceRegistry`, `ExpoPushSender`, optional `ApnsVoipSender` (file 3), or your own sender. Must not throw for "no devices" (thrown errors are logged and swallowed anyway) |
| `MediaStorage` (`upload`, optional `delete`) | `adapters.ts:126` (`LocalDiskStorage` at `:167`); chosen in `src/chat/feature.ts:66` | Writes under `./comms_media` (relative to the process working directory); returns URLs like `/media/chat/...`. **Nothing serves them** unless you serve the folder | Storage location and access control are yours | `S3Storage({ private: true })` or your own. Throw `UploadRejected` to reject a file with a message. Implement `delete` so unsend and account deletion remove files |
| `DeviceRegistry` (`register`, `remove`) | `adapters.ts:109` | None: the legacy token routes are not mounted | Optional | `SqlDeviceRegistry` + `hub.install(new DevicesFeature(devices))` (install it **before** `ChatFeature`, and do not also pass `devices` to `ChatFeature`) |
| `ChatPolicy` (`canMessage`, `blockStatus`, `extraConversationInfo`, `refusalMessage`) | `src/chat/policy.ts:4` (`AllowAllChatPolicy` at `:16`) | Everyone may message everyone; nobody blocked; `{chat_consent_given: true}`; refusal text "Cannot send message. User is blocked." | Who may talk to whom is product logic (matches, consent, blocks) | Query your own tables in `canMessage` (false refuses send/upload and silently drops typing). Return block flags in `blockStatus` (`{ otherId: [isBlocked, blockedByOther] }`). Add product fields in `extraConversationInfo`. Wrap with moderation via `linkModeration` |
| `CallPolicy` (`authorize`) | `src/call/policy.ts:16` (`AllowAllCallPolicy` at `:25`) | Always allows | Credits, blocking, subscriptions are product logic | Return `allow()` or `deny("msg", { status: 402, info: {...} })`. Runs after busy detection and before the call row exists, so charging here is safe. The raw `call_initiate` frame is passed in |
| `CallChatBridge` | `src/call/bridge.ts`; implemented by `linkChatAndCall` | `null` (call-only mode) | Optional link | Usually just call `linkChatAndCall(chat, call)` |

### C.2 Hooks and settings that default to "off"

| Name | Where | Default | What a real app does |
|---|---|---|---|
| `new ModerationFeature({ onReport })` | `src/moderation/feature.ts:21` (`ReportHook`) | unset: reports are stored with status `open` and **nobody is told** | Send to email/Slack/queue. Review within your policy window. It runs in the background (`hub.spawn`) after the event is emitted; a thrown error is logged, not raised (`src/moderation/handlers.ts:85-93`) |
| `new ModerationFeature({ adminDependency })` | same (`AdminDependency`, `feature.ts:25`) | unset: admin routes are **not mounted** | A function `(ctx: RestContext) => adminId` that authenticates a moderator from `ctx.headers` (throw `new HttpError(401, ...)` / `403`) and returns their id (stored as `resolved_by`). The kit has no admin login; these routes use `auth: false` so your function does all the checking |
| `new ModerationFeature({ contextProvider })` | same | unset; `linkModeration` fills it when chat is given. Call-only apps get empty `messages` | Only needed for custom chat storage |
| `new ModerationFeature({ notifyBlockedUser: true })` | same | `true` (tells the blocked person; kept for old-app compatibility) | Set `false` if you do not want to reveal blocks |
| `new CommsHub({ roleResolver })` | `src/core/hub.ts:49` | unset: every user has role `"user"` | Return e.g. `"admin"` for staff sockets so they create no presence, no `user_status`, no `user.came_online`. A resolver that throws is logged and treated as `"user"` |
| `new CommsHub({ onHandlerError })` | `hub.ts:50`, `:151-158` | unset: errors are only logged | Forward `(userId, frame, err)` to Sentry or similar. Its own failures are logged. `frame` is the raw text for bad JSON |
| `new CommsHub({ cameOnlineCooldown })` | `hub.ts:52`, `:82` | unset, then `0` (only de-duplicates simultaneous connects; Redis de-dupe key 10 s) | Set seconds (for example 3600) if you notify others "X is online", so reconnecting does not spam |
| `new CommsHub({ rateLimiter })` | `hub.ts:48` | in-memory `RateLimiter` | `new RedisRateLimiter(bridge)` on several processes |
| `new CommsHub({ connections: new ConnectionManager({ bridge }) })` | `hub.ts:47` | in-memory only | `RedisBridge` on several processes (and call `hub.connections.start()`) |
| `new CommsHub({ logger })` | `hub.ts:53`, `src/core/logger.ts` | console warn/error with a `[commskit]` prefix; info silent | Pass pino/winston wrapped as `{ info, warn, error }`. This sets one logger for the whole process (`setLogger`) |
| `ChatConfig`, `CallConfig` limits | A.9 | Smart-Matrimony-era defaults | Tune to your traffic and abuse model |
| `ChatConfig.systemSenderId` | `src/chat/feature.ts:22` | `null`: `sendSystemMessage` needs `aboutUserId` | Set to a bot/system user id if you send system messages with no subject |
| `DevicePushRouter({ androidCallStyle })` | `src/core/push.ts:549` | `"notification"` | `"data"` only if your Android app draws its own call UI |
| `hub.on(...)`, `hub.onConnect`, `hub.onDisconnect`, `hub.events.on(...)` | `src/core/hub.ts` | none | Your product events (for example `chat_consent`, "match is online") |

### C.3 Demo-only values

All in `examples/backend/demo-server-node/server.mjs` (as of 2026-10-26; the file was still being finished by another author when this was written, so re-check against the final file). They exist so a developer can try the kit in 30 seconds. **Do not deploy it.**

| Value | Where | Why it is unsafe | Replace with |
|---|---|---|---|
| JWT secret `local-demo-secret-change-me-0000` (fallback of `COMMS_DEMO_SECRET`) | `server.mjs` (`SECRET`) | Public in the repo; anyone can forge a token for any user | Your real secret in your secret manager |
| `GET /dev/token/:id` returns a valid token for `U1`/`U2`/`U3` to **anyone**, no password | `server.mjs` | No authentication at all | Your login endpoint |
| `GET /dev/users` lists the demo users | `server.mjs` | Debug info | Remove |
| Fixed users `U1` Alice, `U2` Bob, `U3` Carol via `StaticUserDirectory` | `server.mjs` (`USERS`) | Not real users | Your `UserDirectory` |
| SQLite `.demo_data/demo.db` (WAL mode, `busy_timeout` 30 s) | `server.mjs` | Single file, no backups, one writer | PostgreSQL |
| `LocalDiskStorage(.demo_data/media, "/media")` served publicly at `/media` | `server.mjs` | Anyone with a URL can read uploaded files; no auth; files on local disk | `S3Storage({ private: true })` |
| `initiateRate: null` and loose chat limits (`RateLimit(200, 10)` etc.) | `server.mjs` | Rate limits are off or very high, for the UI tests | Kit defaults or stricter |
| `onReport` only prints | `server.mjs` | Reports go to the console | Your moderation notification |
| No `adminDependency` | `server.mjs` | Admin routes absent (that is safe, but nobody can review) | Your admin auth |
| `ANDROID_CALL_STYLE` default `data` | `server.mjs` | Differs from the kit default (`notification`) | Choose deliberately |
| CORS only via `COMMS_CORS_ORIGINS`, off by default | `server.mjs` | n/a | Restrict to your real origins |
| `ensureSchema(db)` at startup | `server.mjs` | Fine for dev; not a migration strategy | Real migrations (file 3) |
| Demo page files served from `../demo-server-python/` | `server.mjs` | Dev UI | Remove |

The same applies to test fixtures: `test/helpers.ts` uses its own test-only secret and users `A`, `B`, `C`; `scripts/dist-smoke.mjs` uses `smoke-test-secret-not-a-real-secret-0001`.

### C.4 Things the kit leaves to you

| Duty | Detail |
|---|---|
| Issuing and refreshing JWTs | The kit only validates |
| Token revocation / banning | Revoke tokens, refuse login, and close sockets in your app. The kit has no ban list (blocking is user-to-user only) |
| Serving uploaded files | `LocalDiskStorage` does not serve; with S3 `private: true` you must refresh expired presigned URLs (`storage.presign(url)`) when you return messages, or accept that media older than `presignExpires` (max 7 days) stops loading |
| Data retention | The `calls` table keeps `offer_sdp`, `answer_sdp`, `ice_candidates` (contain IP addresses) forever. Run a job that clears them after calls end. Messages are never purged automatically |
| Account deletion | Call `deleteUserEverywhere(hub, userId)` from your delete-account flow (`src/integration/privacy.ts`). Chat deletion removes the whole 1:1 chat for both people. Live calls are not signalled; disconnect the user first |
| Migrations | Use your migration tool. `ensureSchema` only creates missing tables. The Python doc describes a manual `ALTER TABLE comms_reports` upgrade for old databases; whether a database created by an older kit version needs it is not verified for Node |
| Health checks, metrics, log redaction | Not provided |
| The `[Call Initiated]` chat text | `src/integration/chatCall.ts:8` (`CALL_PLACEHOLDER`): a temporary chat entry created when a call starts, rewritten to "Voice call · MM:SS" / "Missed voice call" at the end. Not a setting; mentioned because it shows up in the `messages` table |
| Android channel ids | `messages` and `call_ringtone` are hard-coded defaults in the config objects and must match the channels your app creates |
| Legacy wire quirks | `PONG` upper-case, "caller view" fields, busy as `call_rejected`, `cid` format `messaging:<id>` are kept on purpose (PROTOCOL section 6). Do not "fix" them if you serve installed apps |

### C.5 Where Smart Matrimony plugs in

Smart Matrimony (`matrimonial-backend-v2`) is a Python backend, so it uses the Python package. A Node service next to it, or a future Node rewrite, would plug in the same seven places. The Python README describes (documentation only; none of it lives in the kit) the adapters; the Node equivalents:

| Python adapter idea | Node interface | Idea |
|---|---|---|
| `SmmAuth` | `AuthAdapter` | decode the app's existing token and return the `uid` |
| `SmmUserDirectory` | `UserDirectory` | profile service + photo service lookups |
| `SmmPush` | `PushSender` | existing Expo helper + `user_devices` table |
| `SmmDevices` | `DeviceRegistry` | existing device service behind `/chats/expo/push/token[/remove]` |
| `SmmS3Storage` | `MediaStorage` | existing S3 media manager |
| `SmmChatPolicy` | `ChatPolicy` | match, block and consent checks |
| `SmmCallPolicy` | `CallPolicy` | block check + credits (402/403 payloads via `deny`) |

Then `new CommsHub({ auth, users, push, db, connections: new ConnectionManager({ bridge: new RedisBridge({ url }) }) })`, install both features with those policies, `linkChatAndCall`, and register host-only events with `hub.on(...)` / `hub.onConnect(...)`.
Because the table and Redis key names are identical, a Node service could share the database and Redis of the existing Python backend; this is **not verified** (see file 1, section 10 for the differences: app clock, no `aud` rejection, no server pings). This was not checked against the `matrimonial-backend-v2` repo (out of scope here).
