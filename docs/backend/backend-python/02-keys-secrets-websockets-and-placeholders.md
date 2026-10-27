# commskit backend: keys, secrets, WebSockets and placeholders

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
  - [A.7 Media tools (ffmpeg)](#a7-media-tools-ffmpeg)
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

Source references use `file:line` relative to `comms-kit/backend/backend-python/` (line numbers as of this writing; they will drift).
All secret values below are dummies. Never copy them.

---

## A. Keys, secrets and configuration values

### A.0 How configuration works in this kit

The library reads very few environment variables itself. Almost everything is a constructor argument that your app fills in.

Environment variables read by `commskit/` code (verified with a search for `os.environ` / `os.getenv`):

| Variable | Read at | Purpose |
|---|---|---|
| `APNS_KEY`, `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` | `commskit/core/push.py:361-365` (`ApnsVoipSender.from_env`) | iOS VoIP push |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `commskit/core/media_tools.py:30` | optional path to ffmpeg/ffprobe |
| `HOSTNAME` | `commskit/core/connections.py:81` | part of the per-worker server id (default `server`) |

Names such as `JWT_SECRET`, `TURN_SECRET`, `TURN_URIS`, `REDIS_URL`, `EXPO_ACCESS_TOKEN` are only a convention used in `backend/backend-python/README.md` and
`examples/backend/demo-server-python/demo_server.py`: your own code reads them and passes the values in. Use any names you like.

### A.1 Auth (JWT)

Class: `JwtAuth(secret, algorithm="HS256", claim="uid")` at `commskit/core/adapters.py:43-62`. You can replace it with any object that has
`user_id_from_token(token) -> str` (sync or async); see C.1.

| Item | Detail |
|---|---|
| Name (convention) | `JWT_SECRET` (the kit does not read it; you pass it to `JwtAuth(secret=...)`) |
| Read at | `adapters.py:46` (constructor). An empty secret raises `ValueError("JwtAuth needs a non-empty secret")` |
| Required | Yes, if you use `JwtAuth`. Not needed if you write your own `AuthAdapter` |
| Purpose | Verifies the signature of the token the client sends. The kit never creates tokens |
| How to get | It must be the same secret your app already uses to sign its login tokens. For a new app: `python -c "import secrets; print(secrets.token_hex(32))"` |
| Example (dummy) | `JWT_SECRET=0f3c...dummy...9a21` (64 hex chars) |
| Default | None |
| Visibility | **PRIVATE** (server only) |
| Security notes | Use at least 32 bytes (PyJWT warns about shorter HS256 keys; seen when testing). Anyone who has it can sign a token for any user id. Rotating it logs everyone out |

Related settings:

| Setting | Default | Notes |
|---|---|---|
| `algorithm` | `"HS256"` | Only this algorithm is accepted (`algorithms=[algorithm]`). For RS256 you would pass the PEM public key as `secret`; that is plain PyJWT behaviour and is **not verified in this repo's tests** |
| `claim` | `"uid"` | The token field holding the user id. Converted to a string. A missing or empty claim raises `AuthError` (`adapters.py:60-62`) |

Behaviour I checked by running `JwtAuth` directly:

- A token **without** `exp` is accepted forever. The kit does not require expiry. Your login code must set a short `exp`.
- A token with an `aud` claim is **rejected** ("Invalid audience"), because `JwtAuth` does not pass an audience to PyJWT. If your host tokens carry `aud`, write your own `AuthAdapter`.
- A token with an expired `exp` is rejected.
- A token with a different claim name (for example `sub`) is rejected unless you set `claim="sub"`.
- The token is checked once, when the WebSocket connects. A socket that is already open stays open after the token expires. The kit has no function that closes a user's socket (not found in the code); use a short token lifetime and reconnect.

Where the token travels: in the WebSocket path (`/ws/<token>`) and, for REST, in the `Authorization: Bearer <token>` header (`adapters.py:74`, `bearer_dependency`).

### A.2 Database

The kit does not read a database URL. Your app creates the engine and passes a session factory.

| Item | Detail |
|---|---|
| Name (convention) | `DATABASE_URL` |
| Read at | Your code: `create_async_engine(url)` then `async_sessionmaker(engine, expire_on_commit=False)`; passed as `CommsHub(session_factory=...)` (`commskit/core/hub.py:43-55`) |
| Required | Yes |
| Purpose | Stores chats, messages, calls, devices, blocks, reports |
| Drivers (must be async) | SQLite: `sqlite+aiosqlite:///./comms.db` (extra package `aiosqlite`). PostgreSQL: `postgresql+asyncpg://user:password@host:5432/dbname` (extra package `asyncpg`). Neither driver is in any commskit extra |
| Example (dummy) | `postgresql+asyncpg://comms:CHANGE_ME@db.internal:5432/comms` |
| Default | None |
| Visibility | **PRIVATE** (contains the password) |
| Security notes | Use a dedicated DB user with only the rights the app needs. Require TLS to the database. The kit works with `expire_on_commit=True` too (README), but the demo uses `False` |

Tested only on SQLite (`tests/conftest.py`). PostgreSQL is **not verified in this repo's tests**; the README says it is the original production database.
The kit uses the database clock (`SELECT now()`, `commskit/core/db.py:16-22`) for call timestamps, so all your app servers agree on call timing.

### A.3 TURN (calls across networks)

Calls are peer-to-peer. A TURN relay is needed when two phones cannot reach each other directly (mobile data, strict NAT). The kit hands out
credentials for your own coturn server using coturn's "REST API / `use-auth-secret`" scheme (`commskit/call/turn.py`). The kit does not run TURN.

| Item | Detail |
|---|---|
| Name (convention) | `TURN_SECRET` |
| Read at | `CallConfig.turn_secret` (`commskit/call/config.py:22`); used by `POST /call/turn-credentials` (`commskit/call/router.py:21-26`) |
| Required | Optional. While unset, the route answers `503 "TURN is not configured"`. Calls on the same network or with friendly NATs can still work through public STUN (a client-side setting; not checked here) |
| Purpose | Shared secret between your API and coturn. The API signs a temporary username with it (HMAC-SHA1, base64) |
| How to get | You choose it: `python -c "import secrets; print(secrets.token_hex(32))"`. Put the **same** value in coturn as `static-auth-secret` |
| Example (dummy) | `TURN_SECRET=7d1e...dummy...c03b` |
| Default | `None` |
| Visibility | **PRIVATE**. The temporary credentials that the route returns are public to the logged-in caller and expire |

| Setting | Default | Notes |
|---|---|---|
| `CallConfig.turn_uris` (convention `TURN_URIS`, comma-separated in the demo) | `[]` | For example `turn:turn.example.com:3478?transport=udp` and `turns:turn.example.com:5349?transport=tcp`. Public information |
| `CallConfig.turn_ttl` | `3600` seconds | Lifetime of each credential |

Notes: the returned username is just the expiry timestamp (`"<unix expiry>"`): `router.py:26` does not pass a user id to `turn_credentials()`, although the function supports one.
Any logged-in user can request credentials (no per-user rate limit in the kit). coturn setup is in file 3.

### A.4 Push: Expo and APNs

| Name | Read at | Required | Purpose | How to get | Example (dummy) | Default | Visibility |
|---|---|---|---|---|---|---|---|
| `EXPO_ACCESS_TOKEN` | Your code: `ExpoPushSender(access_token=...)` (`commskit/core/push.py:72-78`; `demo_server.py:61`) | Optional. Needed only if "Enhanced push security" is on in your Expo account | Sent as `Authorization: Bearer <token>` to `https://exp.host/--/api/v2/push/send` | expo.dev, account settings, access tokens | `EXPO_ACCESS_TOKEN=expo_dummy_0000` | None (no header sent) | **PRIVATE** |
| `APNS_KEY` | `push.py:361` | One of `APNS_KEY` / `APNS_KEY_PATH` is required for iOS VoIP | Contents of the `.p8` key. Literal `\n` is turned into newlines (`push.py:366`) | Apple Developer portal, Keys, create a key with APNs enabled; download `AuthKey_<KEYID>.p8` (downloadable once) | `-----BEGIN PRIVATE KEY-----\nDUMMY\n-----END PRIVATE KEY-----` | None | **PRIVATE** |
| `APNS_KEY_PATH` | `push.py:361` | See above | Path to the `.p8` file (read when the sender is created) | as above | `/etc/commskit/AuthKey_ABC123DEFG.p8` | None | **PRIVATE** (the file) |
| `APNS_KEY_ID` | `push.py:362` | Yes for VoIP | 10-character key id (JWT `kid`) | shown next to the key | `ABC123DEFG` | None | Not secret, keep private anyway |
| `APNS_TEAM_ID` | `push.py:362` | Yes for VoIP | Apple team id (JWT `iss`) | Apple Developer account, Membership | `TEAM123456` | None | Not secret |
| `APNS_BUNDLE_ID` | `push.py:362` | Yes for VoIP | App bundle id. Topic becomes `<bundle>.voip` (not doubled if it already ends in `.voip`) | Xcode / app config | `com.example.myapp` | None | Public |
| `APNS_USE_SANDBOX` | `push.py:365` | Optional | `1`, `true` or `yes` selects `api.sandbox.push.apple.com` (dev builds). Otherwise `api.push.apple.com` | n/a | `APNS_USE_SANDBOX=1` | off (production host) | Public |

How it behaves:

- `ApnsVoipSender.from_env()` returns `None` unless a key (or key path), key id, team id and bundle id are **all** set. Then `DevicePushRouter` sends iOS call pushes as normal Expo pushes instead of VoIP (no CallKit when the app is closed).
- If both `APNS_KEY` and `APNS_KEY_PATH` are set, the text in `APNS_KEY` is used (`push.py:338-340`).
- Needs the `apns` extra (`httpx[http2]`, `cryptography`); otherwise a `RuntimeError` says so.
- The provider JWT (ES256) is cached and re-signed every 50 minutes (`token_refresh = 3000` s). VoIP expiration is 45 s.
- A sandbox token sent to the production host (or the reverse) fails with `BadDeviceToken` and the sender removes that token.
- Real Expo and APNs calls are **not verified in this repo's tests** (tests use `httpx.MockTransport`).
- The FCM v1 service account and the APNs key uploaded to EAS are client-build matters, not read by this backend.

| Other push settings | Default |
|---|---|
| `DevicePushRouter(android_call_style=...)` | `"notification"` (visible push). `"data"` = data-only push so the app draws its own call screen (the demo uses `"data"` via `ANDROID_CALL_STYLE`) |
| `ExpoPushSender` `batch_size` / `timeout` / `sound` | 100 / 10 s / `"default"` |
| Expo receipts polling | off until you call `expo.start_receipt_poller(interval=900)` |
| `ChatConfig.push_channel` | `"messages"` (must match the Android channel id the app creates) |
| `CallConfig.ringtone_channel` / `missed_channel` | `"call_ringtone"` / `"messages"` |

### A.5 Redis

| Item | Detail |
|---|---|
| Name (convention) | `REDIS_URL` |
| Read at | Your code: `RedisBridge(url=...)` (`commskit/core/redis_bridge.py:38-46`), passed as `ConnectionManager(bridge=...)` into `CommsHub(connections=...)` |
| Required | Only when you run more than one worker or instance. Optional for one process |
| Purpose | Presence, cross-worker message delivery (pub/sub), room broadcasts, `user.came_online` de-duplication; with `RedisRateLimiter`, shared rate limits |
| How to get | Managed Redis (Upstash, ElastiCache, Redis Cloud...) or your own server |
| Example (dummy) | `redis://:CHANGE_ME@redis.internal:6379/0` (use `rediss://` for TLS) |
| Default | None. Without a bridge everything is in-process memory |
| Visibility | **PRIVATE** |
| Security notes | Set a password and keep Redis off the public internet. The kit stores only presence keys and pub/sub messages (which include message payloads in transit), plus rate-limit buckets |

Redis keys used: `presence:{uid}`, `presence_away:{uid}`, `came_online:{uid}`, `ratelimit:{action}:{uid}` (rate limiter), pub/sub channels `user_channel:{uid}` and `room_channel:{room}`.

Important behaviour: if Redis is unreachable when `await hub.connections.start()` runs, the bridge only **logs a warning** ("Redis unavailable ... running single-worker", `redis_bridge.py:79`) and carries on without it. On several workers that silently breaks cross-worker delivery. Watch for that log line and the deploy health.
Defaults: heartbeat 30 s, stale after 90 s, presence key TTL 120 s, away key TTL 12 h. Redis is **not verified in this repo's tests** against a real server.

### A.6 S3 / media storage

| Item | Detail |
|---|---|
| Class | `S3Storage(bucket, *, region=None, client=None, prefix="", public_base_url=None, private=False, presign_expires=604800, thumbnails=True, durations=True, extra_put_args=None)` (`commskit/core/s3.py:46-60`). Needs the `s3` extra (boto3, Pillow) |
| Bucket name | Required argument (empty raises `ValueError`). Example `my-app-chat-media` |
| Region | Optional argument, passed to `boto3.client("s3", region_name=...)` (`s3.py:88`). If omitted, boto3 decides (for example `AWS_DEFAULT_REGION`) |
| Credentials | **Not handled by the kit.** boto3's default chain: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) env vars, `AWS_PROFILE`, `~/.aws/credentials`, or an IAM role (best on AWS). You can also pass your own `client=` |
| Needed IAM actions | `s3:PutObject`, `s3:GetObject` (also needed to make presigned GET URLs work), `s3:DeleteObject` on `arn:aws:s3:::BUCKET/PREFIX*`. Derived from the calls the code makes (`put_object`, `delete_object`, `generate_presigned_url("get_object")`) |
| Example (dummy) | `AWS_ACCESS_KEY_ID=AKIADUMMYDUMMY0000`, `AWS_SECRET_ACCESS_KEY=dummy/dummy/dummy` |
| Visibility | **PRIVATE** (credentials). Object URLs are public only if you leave the default `private=False` and open the bucket |

Facts to know:

- **`private=False` is the default.** URLs then look like `https://BUCKET.s3.REGION.amazonaws.com/KEY` and only work if the bucket or objects are publicly readable. For chat media use `private=True` (presigned URLs).
- With `private=True`, the presigned URL is stored in `messages.file_url` when the file is uploaded. It expires after `presign_expires` (default and maximum 7 days). **I found nothing in the kit that refreshes old URLs** when messages are loaded; `storage.presign(file_url)` exists but only your code calls it. Plan for this (see C.4).
- `messages.file_url` and `thumbnail_url` columns are `String(500)`. Presigned URLs made with temporary (session-token) credentials can be longer than that; PostgreSQL would then reject the insert. Not verified here; test with your credentials.
- Key layout: `{prefix}chat/{chat_id}/{media_type}/{unix_ts}_{uuid8}_{safe_name}`; thumbnails `..._thumb.jpg` next to it.
- Real S3 is **not verified in this repo's tests**.

### A.7 Media tools (ffmpeg)

| Variable | Read at | Required | Purpose | Default |
|---|---|---|---|---|
| `FFMPEG_PATH` | `commskit/core/media_tools.py:30` | Optional | Path to `ffmpeg` for video thumbnails | found on `PATH` |
| `FFPROBE_PATH` | same | Optional | Path to `ffprobe` for audio/video duration | found on `PATH` |

Without the tools, thumbnails or durations are simply `None`. Image thumbnails need Pillow (`media` or `s3` extra).

### A.8 Demo-server variables

Used only by `examples/backend/demo-server-python/demo_server.py`. **Not for production.**

| Variable | Read at | Default | Meaning |
|---|---|---|---|
| `COMMS_FEATURES` | `demo_server.py:43` | `chat,call` | Comma list: `chat`, `call` or both |
| `COMMS_DEMO_DATA` | `demo_server.py:39` | `examples/backend/demo-server-python/.demo_data` | Folder for `demo.db` (SQLite) and `media/` |
| `COMMS_DEMO_SECRET` | `demo_server.py:42` | `local-demo-secret-change-me-0000` | JWT secret of the demo (see C.3) |
| `COMMS_CORS_ORIGINS` | `demo_server.py:116` | unset (CORS off) | Comma-separated allowed origins, only for a separately hosted web client |
| `ANDROID_CALL_STYLE` | `demo_server.py:63` | `data` | `data` or `notification` |
| `TURN_SECRET`, `TURN_URIS` | `demo_server.py:83-84` | unset | See A.3 |
| `EXPO_ACCESS_TOKEN`, `APNS_*` | `demo_server.py:61`, `push.py` | unset | See A.4 |
| `CHROME_PATH` | `examples/backend/demo-server-python/ui_tests/_harness.py:29` | auto-detected | UI tests only |

### A.9 Tunable settings with defaults

`ChatConfig` (`commskit/chat/feature.py:22-41`):

| Field | Default | Meaning |
|---|---|---|
| `max_upload_bytes` | 10 MiB | Max decoded file size for `media_upload` |
| `default_page_size` / `max_page_size` | 10 / 100 | `get_messages` paging |
| `push_preview_chars` | 120 | Push body length |
| `push_channel` | `"messages"` | Android channel id |
| `max_text_length` | 4000 | 0 = unlimited |
| `message_rate` | `RateLimit(20, 10)` | 20 messages per 10 s per user; `None` = off |
| `upload_rate` | `RateLimit(5, 60)` | 5 uploads per 60 s |
| `typing_rate` | `RateLimit(5, 5)` | over the limit: dropped silently |
| `unsend_window_seconds` | 3600 | 0 = no limit, -1 = unsend disabled |
| `system_sender_id` / `system_push_title` | `None` / `None` | For `send_system_message` |

`CallConfig` (`commskit/call/config.py`):

| Field | Default | Meaning |
|---|---|---|
| `ring_timeout` | 45 s | ringing then missed (`no_answer`) |
| `ringing_disconnect_grace` | 20 s | socket lost while ringing, then missed |
| `answered_disconnect_grace` | 90 s | socket lost while answered, then ended |
| `max_call_hours` | 4 | answered calls older than this no longer count as live |
| `ring_window_slack` | 15 s | extra time a ringing row counts as live |
| `ringtone_channel` / `missed_channel` | `call_ringtone` / `messages` | Android channels |
| `turn_secret` / `turn_uris` / `turn_ttl` | `None` / `[]` / 3600 | See A.3 |
| `initiate_rate` | `RateLimit(5, 60)` | `call_initiate` per caller; `None` = off |

Other: `CommsHub(came_online_cooldown=None)` (connection manager default 0.0; dedupe window 10 s), `RateLimiter(max_keys=100_000)`,
`RedisBridge` timings (A.5), `LocalDiskStorage(root="comms_media", base_url="/media")`.

### A.10 Private vs public summary

| PRIVATE (server only: never in a phone app, web bundle, repo or log) | Public / low risk |
|---|---|
| `JWT_SECRET` | `TURN_URIS` |
| `DATABASE_URL` | `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` |
| `TURN_SECRET` | `CallConfig` timings and limits |
| `EXPO_ACCESS_TOKEN` | Temporary TURN credentials (expire after `turn_ttl`) |
| `APNS_KEY` / `.p8` file (and treat `APNS_KEY_ID`, `APNS_TEAM_ID` as private) | The user's own JWT (it is theirs, but see A.11) |
| `REDIS_URL` | |
| AWS keys / `AWS_SECRET_ACCESS_KEY` | |
| `COMMS_DEMO_SECRET` | |

### A.11 Never do this

- Never commit secrets (`.env`, `.p8`, AWS keys). Keep `.env` in `.gitignore`; use your host's secret manager. If one leaks, rotate it.
- Never put `JWT_SECRET`, `TURN_SECRET`, the APNs key or AWS keys in client code, in `app.json`/`eas.json`, in an `EXPO_PUBLIC_*` variable or in a `VITE_*` variable. Everything in a client bundle is readable by anyone.
- Never sign tokens in the client. The client only receives a token from your login endpoint. The demo's `/dev/token/{id}` is the opposite and exists only for local testing.
- Never deploy `examples/backend/demo-server-python/demo_server.py` or leave `/dev/token/{id}` reachable.
- Never use a default or shared secret (`local-demo-secret-change-me-0000`).
- Never issue tokens without `exp`.
- Never expose the database, Redis or coturn admin ports to the internet.
- Never serve `LocalDiskStorage` files from a public, unauthenticated folder for real user data.

**The token is in the URL path (`/ws/<jwt>`).** It therefore appears in:

- uvicorn's access log (`WebSocket /ws/<jwt> [accepted]`),
- nginx / load-balancer access logs,
- error trackers or APM tools that record URLs.

The kit itself does not log the token (the auth failure log, `commskit/core/websocket.py:30`, prints only the error text). To redact:

- uvicorn behind nginx: start it with `--no-access-log` and let nginx log (below).
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

Contract: [`docs/archive/PROTOCOL.md`](../../archive/PROTOCOL.md). This section summarises it and adds what the code does.

### B.1 Endpoint and handshake

| Item | Value |
|---|---|
| Path | `/ws/{token}` (default; `hub.ws_router(path="/ws/{token}")` can change it, the path must keep a `{token}` parameter) |
| URL | `wss://<host>/ws/<jwt>` (`ws://` only for local development) |
| Mounted by | `app.include_router(hub.ws_router())` |
| Auth | The JWT in the path, checked by your `AuthAdapter`. No header and no query-string authentication |

Sequence (`commskit/core/websocket.py`):

1. The server **accepts** the connection first (line 26).
2. Then it validates the token. On any error it closes with code **1008**, reason `"Invalid token"` (line 31). (Accept-then-close is on purpose, so clients see 1008 instead of an HTTP error.)
3. It asks `role_resolver` for the user's role (default `"user"`), registers the socket, announces presence to the user's conversation partners (if chat is installed), and runs `on_connect` hooks. A user may hold many sockets; every event goes to all of them.
4. For a call-feature app, a call that is still ringing for this user is sent again on the new socket, with the stored offer SDP.
5. It reads frames in a loop until the client disconnects.

### B.2 Close codes, heartbeat, framing

| Item | Behaviour |
|---|---|
| Close `1008` | Invalid, expired or missing-claim token |
| Close `1011` | Unexpected crash of the socket loop ("Internal server error") |
| Normal close | Client closes; the kit removes the socket. When the last socket of a user closes, offline hooks and `user_status: offline` run (after a short check that the user did not reconnect) |
| Frame format | Text frames containing one JSON object with a string `type`. Binary frames are not part of the protocol (not verified what happens if one is sent) |
| Bad frames | Not JSON: `{"type":"error","error":"Invalid JSON"}`. JSON but not an object: `{"type":"error","error":"Message must be a JSON object"}`. Handler exception: `{"type":"error","error":"Message processing failed: <msg>"}`. Unknown `type`: ignored, no reply |
| App-level heartbeat | Client sends `{"type":"ping"}`, server replies `{"type":"PONG","timestamp":...}` (upper case on purpose, `commskit/core/compat.py`). The mobile client's `pingIntervalMs` default is `0` (off) (`mobile/src/core/CommsClient.ts:126`) |
| Server-initiated pings | The kit sends none. uvicorn does WebSocket protocol pings by default every 20 s with a 20 s timeout (`--ws-ping-interval`, `--ws-ping-timeout`; seen in `uvicorn --help` for the installed version) |
| Redis heartbeat | With `RedisBridge`, each socket refreshes the Redis presence key every 30 s. This is not a frame |
| Idle timeout | None in the kit. Your proxy/load balancer decides (see B.6) |
| Max frame size | uvicorn default `--ws-max-size 16777216` (16 MiB). A 10 MiB upload is about 13.4 MiB as base64, so the default fits. If you raise `ChatConfig.max_upload_bytes` above roughly 12 MB, also raise `--ws-max-size` |
| Presence | `{"type":"user_status","status":"online"}` or `"away"` from the client (foreground/background); partners get `{"type":"user_status","user_id","status","timestamp"}` |

### B.3 Frame types

Summary only. Payload details: [`PROTOCOL.md`](../../archive/PROTOCOL.md) sections 2 to 4, 7 and 9.

Client to server (C to S):

| Group | `type` values | Needs feature | PROTOCOL |
|---|---|---|---|
| Core | `ping`, `user_status` | always | section 2 |
| Chat | `req_users`, `get_messages`, `send_message`, `mark_read`, `typing`, `media_upload`, `delete_message`, `clear_chat` | chat | sections 3, 9 |
| Call | `call_initiate`, `answer_call`, `reject_call`, `end_call`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `start_recording` (ignored) | call | section 4 |
| Moderation | `report_and_block`, `block`, `unblock` | moderation | section 7 |
| Host extras | anything you register with `hub.on("type")` (a later registration replaces an earlier handler of the same type) | n/a | section 3, "Host extensions" |

Server to client (S to C):

| Group | `type` values | PROTOCOL |
|---|---|---|
| Core | `PONG`, `user_status`, `error` | sections 1, 2 |
| Chat | `res_users`, `req_users_error`, `res_messages`, `new_message`, `message_sent`, `media_upload_success`, `chat_read`, `messages_read`, `delivery_status`, `typing_status`, `message_deleted`, `chat_cleared` | sections 3, 9 |
| Call | `call_initiated`, `incoming_call`, `call_ringing`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `call_answered`, `call_rejected` (also used for "busy"), `call_ended`, `call_missed`, `call_log` (only with chat linked), `error` with `context:"call"` | section 4 |
| Moderation | `user_blocked`, `blocked_by_user`, `user_unblocked`, `unblocked_by_user`, `report_received`, `error` with `context:"moderation"` | section 7 |

Error shapes you will see: `{type:"error", error, code:"rate_limited", retry_after}`, `{..., code:"too_long", max}`, `{..., code:"not_allowed"|"not_found"|"window_expired"}` and call-policy errors with `context:"call"` (for example 402/403 credit info passed through from your `CallPolicy`).

### B.4 REST routes

All routes need `Authorization: Bearer <token>` unless stated. They exist only when the feature is installed **before** you call `hub.rest_router()`.

| Method and path | Feature | Purpose |
|---|---|---|
| `POST /chats/start?candidate_id=ID` | chat | create or get the chat with a user |
| `POST /chats/send` | chat | send a text message (same rules as WS `send_message`) |
| `POST /chats/read` | chat | mark read by `chat_id` or `candidate_user_id` |
| `GET /chats/{user_id}` | chat | conversation list (only for yourself, else 403) |
| `GET /chats/{chat_id}/messages?limit=50&offset=0` | chat | message history |
| `POST /chats/{chat_id}/read` | chat | mark chat read |
| `GET /chats/{user_id}/unread-count` | chat | unread total (self only) |
| `GET /chats/{user_id}/online-status` | chat | online flag (self or someone you chat with) |
| `POST /chats/expo/push/token`, `POST /chats/expo/push/token/remove` | chat (only when `ChatFeature(devices=...)` and no `DevicesFeature`) or devices (legacy) | legacy push token routes |
| `POST /devices`, `DELETE /devices/{device_id}` | devices | register / remove an app install |
| `POST /call/turn-credentials` | call | temporary TURN credentials (503 if not configured) |
| `POST /call/{call_id}/reject` | call | decline from a notification while the app has no socket |
| `GET /moderation/blocks`, `POST /moderation/blocks`, `DELETE /moderation/blocks/{blocked_id}` | moderation | block list |
| `POST /moderation/reports` | moderation | report a user (`reason` required) |
| `GET /moderation/admin/reports`, `POST /moderation/admin/reports/{report_id}`, `GET /moderation/admin/reports/{report_id}/context` | moderation, only when `admin_dependency` is set | admin review (auth is your dependency, not the Bearer user) |

Sources: `commskit/chat/router.py`, `call/router.py`, `moderation/router.py`, `core/devices.py`. There is no health-check route and no docs route added by the kit (FastAPI's own `/docs` comes from your app).

### B.5 Scaling notes

| Topic | Behaviour (from reading the code) |
|---|---|
| One worker, no Redis | Everything works. Connections, presence, rooms, rate-limit buckets and call timers live in process memory |
| Several workers, **no** Redis | `ConnectionManager.send()` delivers only to sockets on the same worker (`connections.py`, `send`). A user connected to another worker looks offline: the message is saved but the live `new_message` frame is not delivered (the recipient gets a push instead, the sender sees `is_delivered: false`, and the delivered tick only appears when that user next connects), an incoming call is sent as push only, typing, presence and read-receipt frames to that user are lost, and `is_online` answers wrongly. Rate limits are counted per worker. **Run exactly one worker without Redis** |
| Several workers **with** `RedisBridge` | `send()` publishes to `user_channel:{uid}` when the user's presence shows another worker; presence is shared; `broadcast_room` crosses workers; `user.came_online` is de-duplicated. **Sticky sessions are not required**: REST is stateless and any worker can hold any WebSocket. Pass `RedisRateLimiter(bridge)` so limits are shared too |
| Lifecycle | Call `await hub.connections.start()` at app startup and `await hub.shutdown()` at shutdown (needed for the bridge consumer) |
| Call timers | The ring timeout and disconnect-grace timers are asyncio tasks inside the worker that started them (`call/lifecycle.py`). If that worker restarts mid-ring, the timer is lost. Busy detection stops counting a ringing call after `ring_timeout + ring_window_slack` (60 s by default), but the row can stay `ringing` until something finalizes it. Not tested here |
| Redis down | Bridge calls swallow errors and log; rate limiter falls back to memory. Cross-worker delivery stops until Redis returns |
| DB connections | Each incoming frame opens one session from your factory (`websocket.py`, `_handle_frame`); size your pool for concurrent frames, not for connected users |
| Rolling deploys | Key names match `matrimonial-backend-v2` so old and new workers can share Redis (README) |

### B.6 Reverse proxy for WebSockets

A proxy must forward the HTTP/1.1 upgrade and must not time out idle sockets too early. Sample nginx (untested here):

```nginx
# in http {}
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

upstream comms_app { server 127.0.0.1:8000; keepalive 32; }

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

- Set an idle timeout of at least 120 s on any load balancer. AWS ALB defaults to 60 s; raise it. Uvicorn's 20 s protocol pings keep a socket active, but do not rely on that alone.
- Use `wss://` in production. Browsers also block microphone access (calls) on plain HTTP except on `localhost`.
- If your app has a response-cache or auth middleware, make sure it ignores `/ws/` and does not cache `/chats/...` (see file 3).

---

## C. Placeholders the integrator must replace or implement

The kit is generic. Anything that depends on your product (who is a user, who may talk to whom, what a call costs, where files live) is an interface with a safe default. The defaults make a demo work; most are wrong for production.

### C.1 Adapters and policies with default behaviour

| Interface | Defined and defaulted in | Default behaviour | Why it is a placeholder | What a real implementation should do |
|---|---|---|---|---|
| `AuthAdapter` (`user_id_from_token`) | `commskit/core/adapters.py:37`; default `JwtAuth` at `:43` | You must pass one; no default object. `JwtAuth` handles HS256 + `uid` claim only | Tokens are your product's | Reuse your existing token decoder (raise on invalid). Return the user id as a string. Can be sync or async |
| `UserDirectory` (`get_profiles(ids)`) | `adapters.py:106` (`NullUserDirectory`); also `StaticUserDirectory` at `:113` | Knows nobody: names fall back to the id (lists) or "Someone" (push/call), avatar `None` | The kit has no user table | One batched query returning `{id: UserProfile(name, avatar)}` for the ids it knows. Called often; keep it fast. Failures are logged and treated as "unknown" |
| `PushSender` (`send(user_id, title, body, data, channel, ttl)`) | `adapters.py:140` (`NoopPush`) | Does nothing: **no push is ever sent** | Push needs your tokens and provider accounts | `DevicePushRouter` with `SqlDeviceRegistry`, `ExpoPushSender`, optional `ApnsVoipSender` (file 3), or your own sender. Must not raise for "no devices" |
| `MediaStorage` (`upload`, optional `delete`) | `adapters.py:205` (`LocalDiskStorage`); chosen in `chat/feature.py:57` | Writes under `./comms_media` (relative to the process working directory); returns URLs like `/media/chat/...`. **Nothing serves them** unless you mount the folder | Storage location and access control are yours | `S3Storage(private=True)` or your own. Raise `ValueError` to reject a file. Implement `delete` so unsend and account deletion remove files. Do slow work in a thread |
| `DeviceRegistry` (`register`, `remove`) | `adapters.py:153` | None: the legacy token routes are not mounted | Optional | `SqlDeviceRegistry` + `DevicesFeature(devices).install(hub)` (do not also pass `devices=` to `ChatFeature`) |
| `ChatPolicy` (`can_message`, `block_status`, `extra_conversation_info`, `refusal_message`) | `commskit/chat/policy.py` (`AllowAllChatPolicy`) | Everyone may message everyone; nobody blocked; `chat_consent_given: true`; refusal text "Cannot send message. User is blocked." | Who may talk to whom is product logic (matches, consent, blocks) | Query your own tables in `can_message` (False refuses send/upload and silently drops typing). Return block flags in `block_status`. Add product fields in `extra_conversation_info`. Wrap with moderation via `link_moderation` |
| `CallPolicy` (`authorize`) | `commskit/call/policy.py` (`AllowAllCallPolicy`) | Always allows | Credits, blocking, subscriptions are product logic | Return `CallDecision.allow()` or `CallDecision.deny("msg", status=402, info={...})`. Runs after busy detection and before the call row exists, so charging here is safe. The raw `call_initiate` frame is passed in |
| `CallChatBridge` | `commskit/call/bridge.py`; implemented by `integration.link_chat_and_call` | `None` (call-only mode) | Optional link | Usually just call `link_chat_and_call(chat, call)` |

### C.2 Hooks and settings that default to "off"

| Name | Where | Default | What a real app does |
|---|---|---|---|
| `ModerationFeature(on_report=...)` | `commskit/moderation/feature.py:44` | `None`: reports are stored with status `open` and **nobody is told** | Send to email/Slack/queue (runs in the background; errors are logged). Review within your policy window |
| `ModerationFeature(admin_dependency=...)` | same | `None`: admin routes are **not mounted** | A FastAPI dependency that authenticates a moderator (raise 401/403) and returns their id (stored as `resolved_by`). The kit has no admin login |
| `ModerationFeature(context_provider=...)` | same | `None`; `link_moderation(chat=...)` fills it. Call-only apps get empty `messages` | Only needed for custom chat storage |
| `ModerationFeature(notify_blocked_user=True)` | same | `True` (tells the blocked person; kept for old-app compatibility) | Set `False` if you do not want to reveal blocks |
| `CommsHub(role_resolver=...)` | `commskit/core/hub.py:52` | `None`: every user has role `"user"` | Return e.g. `"admin"` for staff sockets so they create no presence, no `user_status`, no `user.came_online` |
| `CommsHub(on_handler_error=...)` | `hub.py:53` | `None`: errors are only logged | Forward `(user_id, frame, exc)` to Sentry or similar. Its own failures are logged |
| `CommsHub(came_online_cooldown=...)` | `hub.py:54` | `None` then `0.0` (only de-duplicates simultaneous connects; Redis dedupe key 10 s) | Set seconds (e.g. 3600) if you notify others "X is online", so reconnecting does not spam |
| `CommsHub(rate_limiter=...)` | `hub.py:51` | in-memory `RateLimiter` | `RedisRateLimiter(bridge)` on several workers |
| `CommsHub(connections=ConnectionManager(bridge=...))` | `hub.py:50` | in-memory only | `RedisBridge` on several workers |
| `ChatConfig`, `CallConfig` limits | A.9 | Smart-Matrimony-era defaults | Tune to your traffic and abuse model |
| `ChatConfig.system_sender_id` | `chat/feature.py:39` | `None`: `send_system_message` needs `about_user_id` | Set to a bot/system user id if you send system messages with no subject |
| `DevicePushRouter(android_call_style=...)` | `core/push.py:469` | `"notification"` | `"data"` only if your Android app draws its own call UI |
| `hub.on(...)`, `hub.on_connect`, `hub.on_disconnect`, `hub.events.on(...)` | `hub.py` | none | Your product events (for example `chat_consent`, "match is online") |

### C.3 Demo-only values

All in `examples/backend/demo-server-python/demo_server.py`. They exist so a developer can try the kit in 30 seconds. **Do not deploy it.**

| Value | Where | Why it is unsafe | Replace with |
|---|---|---|---|
| JWT secret `local-demo-secret-change-me-0000` (fallback of `COMMS_DEMO_SECRET`) | `demo_server.py:42` | Public in the repo; anyone can forge a token for any user | Your real secret in your secret manager |
| `GET /dev/token/{user_id}` returns a valid token for `U1`/`U2`/`U3` to **anyone**, no password | `demo_server.py` (`dev_token`) | No authentication at all | Your login endpoint |
| `GET /dev/users` lists the demo users | `demo_server.py` | Debug info | Remove |
| Fixed users `U1` Alice, `U2` Bob, `U3` Carol via `StaticUserDirectory` | `demo_server.py` (`USERS`) | Not real users | Your `UserDirectory` |
| SQLite `examples/backend/demo-server-python/.demo_data/demo.db` (`connect_args timeout 30`) | `demo_server.py` | Single file, no backups, one writer, `database is locked` under load | PostgreSQL |
| `LocalDiskStorage(root=.demo_data/media)` mounted publicly at `/media` | `demo_server.py` | Anyone with a URL can read uploaded files; no auth; files on local disk | `S3Storage(private=True)` |
| `initiate_rate=None` and loose chat limits (`RateLimit(200,10)` etc.) | `demo_server.py` | Rate limits are off or very high, for the UI tests | Kit defaults or stricter |
| `_on_report` only prints | `demo_server.py` | Reports go to the console | Your moderation notification |
| No `admin_dependency` | `demo_server.py` | Admin routes absent (that is safe, but nobody can review) | Your admin auth |
| `ANDROID_CALL_STYLE` default `data` | `demo_server.py:63` | Differs from the kit default (`notification`) | Choose deliberately |
| CORS only via `COMMS_CORS_ORIGINS`, off by default | `demo_server.py:116` | n/a | Restrict to your real origins |
| `lifespan` runs `create_all` | `demo_server.py` | Fine for dev; not a migration strategy | Alembic migrations |
| Demo page served from `/`, `/demo.*` | `demo_server.py` | Dev UI | Remove |

The same applies to test fixtures: `tests/conftest.py` uses `SECRET = "test-only-secret-signed-by-the-tests-0001"` and users `A`, `B`, `C`.

### C.4 Things the kit leaves to you

| Duty | Detail |
|---|---|
| Issuing and refreshing JWTs | The kit only validates |
| Token revocation / banning | Revoke tokens, refuse login, and close sockets in your app. The kit has no ban list (blocking is user-to-user only) |
| Serving uploaded files | `LocalDiskStorage` does not serve; with S3 `private=True` you must refresh expired presigned URLs (`storage.presign(url)`) when you return messages, or accept that media older than `presign_expires` (max 7 days) stops loading |
| Data retention | The `calls` table keeps `offer_sdp`, `answer_sdp`, `ice_candidates` (contain IP addresses) forever. Run a job that clears them after calls end. Messages are never purged automatically |
| Account deletion | Call `commskit.integration.delete_user_everywhere(hub, user_id)` from your delete-account flow. Chat deletion removes the whole 1:1 chat for both people (README) |
| Migrations | Use your migration tool; for an existing database, see the manual `ALTER TABLE comms_reports` note in file 3 |
| Health checks, metrics, log redaction | Not provided |
| The `[Call Initiated]` chat text | `commskit/integration/chat_call.py:10` (`CALL_PLACEHOLDER`): a temporary chat entry created when a call starts, rewritten to "Voice call · MM:SS" / "Missed voice call" at the end. Not a setting; mentioned because it shows up in the `messages` table |
| Android channel ids | `messages` and `call_ringtone` are hard-coded defaults in the config objects and must match the channels your app creates |
| Legacy wire quirks | `PONG` upper-case, "caller view" fields, busy as `call_rejected`, `cid` format `messaging:<id>` are kept on purpose (PROTOCOL section 6). Do not "fix" them if you serve installed apps |

### C.5 Where Smart Matrimony plugs in

`backend/backend-python/README.md`, section "Example: adapters for an existing app (Smart Matrimony)", shows (as documentation only; none of it lives in the kit) a file `app/comms_adapters.py` inside `matrimonial-backend-v2` with:

| Class | Replaces | Idea |
|---|---|---|
| `SmmAuth` | `AuthAdapter` | `decode_token(token)["uid"]` from the app's existing auth |
| `SmmUserDirectory` | `UserDirectory` | profile service + photo service lookups |
| `SmmPush` | `PushSender` | existing `ExpoHelper` + `user_devices` table |
| `SmmDevices` | `DeviceRegistry` | existing device service behind `/chats/expo/push/token[/remove]` |
| `SmmS3Storage` | `MediaStorage` | existing `s3_media_manager` |
| `SmmChatPolicy` | `ChatPolicy` | `MatchedProfilesService` block and consent checks |
| `SmmCallPolicy` | `CallPolicy` | block check + credits (HTTP-style 402/403 payloads) |

Then `CommsHub(auth=SmmAuth(), users=..., push=..., session_factory=AsyncSessionLocal, connections=ConnectionManager(bridge=RedisBridge(url=settings.redis_url)))`,
install both features with those policies, `link_chat_and_call`, and register host-only events (`chat_consent`, WhatsApp admin events, "matched user online") with `hub.on(...)` / `hub.on_connect(...)`.
The README notes that block/report can either stay in the host (register `report_and_block` / `unblock` yourself, replacing the kit's handlers) or move to `ModerationFeature` + `link_moderation`.
This example was **not checked against the `matrimonial-backend-v2` repo** (out of scope here).
