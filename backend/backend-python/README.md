# commskit (backend)

Generic 1:1 **chat** and **P2P voice/video call signalling** for FastAPI + SQLAlchemy 2 (async).
It speaks the wire protocol in [`../../docs/archive/PROTOCOL.md`](https://github.com/prateek0128/chat-call-module/blob/main/docs/archive/PROTOCOL.md), so existing clients of
the first host app (Smart Matrimony) keep working.

```
commskit/
  core/         hub, /ws/{token} endpoint, ConnectionManager, adapters, event bus, CommsBase
  chat/         Chat + Message models, ChatService, ChatPolicy, WS handlers, /chats REST
  core/devices  comms_devices table, SqlDeviceRegistry, DevicesFeature (/devices REST)   (opt-in import)
  core/push     ExpoPushSender, ApnsVoipSender, DevicePushRouter, callkit_uuid          (opt-in import)
  call/         Call model, CallService, CallPolicy, lifecycle (timeouts), /call REST, TURN
  moderation/   block list + reports, WS/REST, chat/call policy wrappers
  integration/  link_chat_and_call(): call-log entries inside the chat
                link_moderation(): block list -> chat/call policies, end calls on block
```

Dependency rule (enforced by `tests/test_imports.py`): `chat`, `call` and `moderation` import only
`core`; only `integration` imports several features (and loads its submodules lazily).
`redis` is only imported if you use `RedisBridge`; `httpx` / `cryptography` / `h2` only when a push
sender is used.

## Install

```bash
pip install commskit                                    # core + chat + call
pip install "commskit[redis]"                           # + multi-worker presence/fan-out
pip install "commskit[s3]"                              # boto3 + Pillow: S3Storage
pip install "commskit[media]"                           # Pillow: image thumbnails (ffmpeg / ffprobe optional)
pip install "commskit[push]"                            # httpx, for ExpoPushSender / DevicePushRouter
pip install "commskit[apns]"                            # httpx[http2] + cryptography, for ApnsVoipSender (iOS VoIP)
```

From a clone of the repository (development):

```bash
pip install -e ./backend/backend-python                 # core + chat + call
pip install -e "./backend/backend-python[redis]"        # + multi-worker presence/fan-out
pip install -e "./backend/backend-python[s3]"           # boto3 + Pillow: S3Storage
pip install -e "./backend/backend-python[media]"        # Pillow: image thumbnails (ffmpeg / ffprobe optional)
pip install -e "./backend/backend-python[push]"         # httpx, for ExpoPushSender / DevicePushRouter
pip install -e "./backend/backend-python[apns]"         # httpx[http2] + cryptography, for ApnsVoipSender (iOS VoIP)
pip install -e "./backend/backend-python[dev]"          # pytest, httpx, aiosqlite, cryptography
```

Tables live on `commskit.core.CommsBase.metadata` (`chats`, `messages`, `calls`, and when imported
`comms_devices`, `comms_blocks`, `comms_reports`, `comms_message_hidden`, `comms_chat_cleared`). A table is registered when its module is imported. Create them with
`CommsBase.metadata.create_all(...)` or your migrations. No ORM foreign keys to a users table.
Use `async_sessionmaker(engine, expire_on_commit=False)` (the kit also works with the default).

## Usage

### Chat only

```python
from fastapi import FastAPI
from commskit.core import CommsHub, JwtAuth
from commskit.chat import ChatFeature

hub = CommsHub(auth=JwtAuth(secret=os.environ["JWT_SECRET"]), session_factory=AsyncSessionLocal)
ChatFeature().install(hub)                     # default: allow-all policy, LocalDiskStorage("comms_media")

app = FastAPI()
app.include_router(hub.ws_router())            # /ws/{token}
app.include_router(hub.rest_router())          # /chats/...
```

### Call only

```python
from commskit.call import CallConfig, CallFeature

hub = CommsHub(auth=JwtAuth(secret=...), session_factory=AsyncSessionLocal, users=MyUsers(), push=MyPush())
CallFeature(config=CallConfig(
    turn_secret=os.environ["TURN_SECRET"],
    turn_uris=["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
)).install(hub)
app.include_router(hub.ws_router())
app.include_router(hub.rest_router())          # /call/{id}/reject, /call/turn-credentials
```

Without chat, call payloads carry `chat_id: null`, no chat message is written and no `call_log` is sent.

### Chat + call

```python
from commskit.integration import link_chat_and_call

hub = CommsHub(auth=MyAuth(), users=MyUserDirectory(), push=MyPush(), session_factory=AsyncSessionLocal)
chat = ChatFeature(policy=MyChatPolicy(), storage=MyS3Storage(), devices=MyDevices()).install(hub)
call = CallFeature(policy=MyCreditPolicy(), config=CallConfig(turn_secret=...)).install(hub)
link_chat_and_call(chat, call)                 # chat_id resolution, "[Call Initiated]" entry, call_log
app.include_router(hub.ws_router())
app.include_router(hub.rest_router())
```

### Host extras

```python
@hub.on("chat_consent")                        # host-only WS events
async def chat_consent(user_id: str, message: dict, session: AsyncSession) -> None: ...

hub.on_connect(my_connect_hook)                # (user_id, websocket)
hub.on_disconnect(my_offline_hook)             # (user_id) when the last socket closes
hub.events.on("call.finalized", on_call_done)  # CallInfo; also chat.message_sent, user.connected/disconnected
await hub.connections.broadcast({...})         # e.g. community events
```

Multi-worker: pass `ConnectionManager(bridge=RedisBridge(url=REDIS_URL))` to `CommsHub(connections=...)`,
and call `await hub.connections.start()` / `await hub.shutdown()` in the app lifespan. Key names are the
same as matrimonial-backend-v2 (`presence:{uid}`, `presence_away:{uid}`, `user_channel:{uid}`), so old
and new workers interoperate during a rollout.

## Devices and push notifications (PROTOCOL.md section 8)

Works with chat only, call only, or both. One row per app install in `comms_devices`
(`user_id`, unique `device_id`, `platform` ios|android|web, `expo_push_token`, `voip_token`,
`app_version`, `os_version`, `model`, `created_at`, `updated_at`, `last_seen_at`).

```python
from commskit.core.devices import DevicesFeature, SqlDeviceRegistry
from commskit.core.push import ApnsVoipSender, DevicePushRouter, ExpoPushSender

devices = SqlDeviceRegistry(AsyncSessionLocal)
push = DevicePushRouter(
    devices,
    expo=ExpoPushSender(access_token=os.getenv("EXPO_ACCESS_TOKEN")),
    voip=ApnsVoipSender.from_env(),        # None when APNS_* is not set -> iOS calls use Expo
    android_call_style="data",             # "notification" (default) or "data"
)
hub = CommsHub(auth=..., session_factory=AsyncSessionLocal, users=..., push=push)
DevicesFeature(devices).install(hub)       # POST /devices, DELETE /devices/{device_id},
                                           # + legacy POST /chats/expo/push/token[/remove]
# lifespan shutdown: await push.aclose()
```

- `POST /devices` `{device_id, platform, expo_push_token?, voip_token?, app_version?, os_version?, model?}`
  upserts by `device_id`. Fields left out keep their value. A `device_id` that shows up under another
  user moves to that user and drops the old tokens. A token can only belong to one device, so other
  rows with the same token lose it.
- `DELETE /devices/{device_id}` (logout) only deletes your own device and can be repeated safely.
- Legacy routes take `{expo_push_token | token | push_token, device_id?, platform | device_type?, ...}`.
  Without a `device_id`, the row is keyed `expo:<token>`; without a platform it is `unknown` (always a
  visible Expo notification). If the app sends neither a token nor a `device_id`, the route returns 422.
  `ChatFeature(devices=...)` still mounts its own copy of these routes for existing setups. Don't
  combine it with `DevicesFeature`: install only one of the two.

### How `DevicePushRouter` decides

It implements `PushSender`, so chat and call call it the same way as before. The decision is per
device, based on `data["type"]`:

| Push | Device | Sent as |
|---|---|---|
| `incoming_call` | iOS with `voip_token`, `voip` sender set | APNs VoIP push. Payload = data + `uuid` (`callkit_uuid(call_id)`). If APNs refuses it and the device has an Expo token, a visible Expo push is sent instead |
| `incoming_call` | Android, `android_call_style="data"` | Expo data-only (no title/body), priority high, ttl 45, `_contentAvailable` |
| `incoming_call` | Android `"notification"`, iOS without VoIP token, web/unknown | visible Expo push, priority high, ttl 45, channel `call_ringtone` |
| anything else (`chat`, `missed_call`, host pushes) | every device with an Expo token | visible Expo push (channel from the caller, e.g. `messages`) |

`callkit_uuid(call_id)` is `str(uuid5(NAMESPACE_URL, f"commskit:call:{call_id}"))` (exported from
`commskit.core` and `commskit.call`), the same value the mobile kit derives. Test vector:
`callkit_uuid("call-123") == "e394bb1f-a663-5750-8664-4de655ce4bf3"`.

### Expo

`ExpoPushSender` POSTs to `https://exp.host/--/api/v2/push/send` in batches of 100. If you set
`access_token`, it sends `Authorization: Bearer <token>` (needed when "enhanced push security" is on).
When a ticket says `DeviceNotRegistered`, the sender removes that token from the registry. It remembers
ticket ids and can poll receipts (see "Expo receipts"). The sender also works on its own as a `PushSender`:
`ExpoPushSender(registry=devices)`.

### APNs VoIP (iOS CallKit)

1. In the Apple Developer portal, go to Keys and create a key with "Apple Push Notifications service
   (APNs)" enabled. Download `AuthKey_<KEYID>.p8` (you can only download it once), and note the
   **Key ID** and your **Team ID**.
2. Enable the Push Notifications capability and the "Voice over IP" background mode on the app.
   The VoIP topic is `<bundle id>.voip`, which the sender derives from `APNS_BUNDLE_ID`.
3. Development builds (Xcode / dev-client) get **sandbox** tokens, so set `APNS_USE_SANDBOX=1`
   (`api.sandbox.push.apple.com`). TestFlight and App Store builds get production tokens
   (`api.push.apple.com`). A token sent to the wrong environment fails with `BadDeviceToken`, and the
   sender then removes it.
4. Install the `apns` extra. If it's missing, the sender raises a clear `RuntimeError`.

Every push uses the headers `apns-push-type: voip`, `apns-topic: <bundle>.voip`, `apns-priority: 10`
and `apns-expiration: now+45`. The provider JWT (ES256, `kid`, `iss`, `iat`) is cached and re-signed
every 50 minutes. On `ExpiredProviderToken`, the sender re-signs it once and retries. A `410` response,
`BadDeviceToken` or `Unregistered` removes the token. iOS requires the app to report every VoIP push
to CallKit right away. The kit therefore sends VoIP only for `incoming_call`, and a missed call is a
normal Expo push.

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `EXPO_ACCESS_TOKEN` | your code -> `ExpoPushSender(access_token=...)` | optional Expo access token |
| `APNS_KEY` or `APNS_KEY_PATH` | `ApnsVoipSender.from_env()` | .p8 contents (`\n` escapes allowed) or path to it |
| `APNS_KEY_ID` | same | 10-char key id |
| `APNS_TEAM_ID` | same | Apple team id (JWT `iss`) |
| `APNS_BUNDLE_ID` | same | app bundle id; topic = `<bundle>.voip` |
| `APNS_USE_SANDBOX` | same | `1`/`true` for development builds |

## Moderation: block and report (PROTOCOL.md section 7)

```python
from commskit.moderation import ModerationFeature, ReportInfo
from commskit.integration import link_moderation

async def on_report(report: ReportInfo) -> None:          # runs in the background; errors are logged
    await email_moderators(report.id, report.reporter_id, report.reported_id, report.category, report.reason)

moderation = ModerationFeature(on_report=on_report, notify_blocked_user=True).install(hub)
```

- WS: `report_and_block` (blocks too, unless `block: false`), `block`, `unblock`. The server sends
  `user_blocked` / `user_unblocked` to the blocker, `blocked_by_user` / `unblocked_by_user` to the
  other user (only when `notify_blocked_user` is on), `report_received` to the reporter, and errors
  as `{"type":"error","error":...,"context":"moderation"}`.
- REST: `GET/POST /moderation/blocks`, `DELETE /moderation/blocks/{user_id}`,
  `POST /moderation/reports` (`reason` required, `block` defaults to **false** here). REST actions
  send the same WS events.
- Tables: `comms_blocks` (unique `blocker_id`+`blocked_id`) and `comms_reports` (`status` starts as
  `"open"`; review it in your admin tool).
- Events on `hub.events`: `moderation.blocked(blocker, blocked)`, `moderation.unblocked(...)`,
  `moderation.reported(ReportInfo)`.

On its own, the feature only stores blocks and reports. To make chat and call respect them, link it:

```python
# chat only
chat = ChatFeature(policy=MyChatPolicy()).install(hub)
link_moderation(moderation, chat=chat)

# call only
call = CallFeature(policy=MyCreditPolicy()).install(hub)
link_moderation(moderation, call=call)

# chat + call
link_chat_and_call(chat, call)
link_moderation(moderation, chat=chat, call=call)
```

`link_moderation` does three things:

- Wraps `chat.policy` into `moderation.chat_policy(<host policy>)`. A blocked pair, in either
  direction, can't `send_message` or `media_upload` (error `"Cannot send message. User is blocked."`),
  and their `typing` is dropped. `is_blocked` / `blocked_by_other` in `res_users` / `res_messages.info`
  combine the kit's block list with your policy's `block_status`.
- Wraps `call.policy` into `moderation.call_policy(<host policy>)`. If the pair is blocked,
  `call_initiate` gets `{"type":"error","context":"call","error":"Cannot call. User is blocked."}`
  **before** your policy runs, so no credits are charged.
- Listens to `moderation.blocked` and ends any live call between the pair: both users get `call_ended`
  with `end_reason: "blocked"` (answered -> `ended`, ringing -> `missed`), plus `call_log` when chat
  is linked. The moderation package never imports call. Instead,
  `CallLifecycle.end_calls_between(a, b, reason)` is called from `commskit.integration`.

Composition rule: the block list always runs first, and only then does your policy decide. That's
why the host's own `refusal_message` and call-deny payloads (402/403 credits) still reach the
client unchanged when *your* policy refuses. You can also wrap the policies yourself, without
`link_moderation`:
`ChatFeature(policy=moderation.chat_policy(MyChatPolicy()))`. Wrapping this way doesn't end calls
on block; `link_moderation` won't wrap a policy twice.

## Chat extras (PROTOCOL.md section 9)

```python
from commskit.chat import ChatConfig
from commskit.core import RateLimit, RedisRateLimiter

chat = ChatFeature(config=ChatConfig(
    max_text_length=4000,                    # 0 = unlimited
    message_rate=RateLimit(20, 10),          # 20 messages / 10 s per user (None = off)
    upload_rate=RateLimit(5, 60),
    typing_rate=RateLimit(5, 5),             # over the limit: dropped silently (stop frames always pass)
    unsend_window_seconds=3600,              # 0 = unlimited, -1 = "delete for everyone" disabled
)).install(hub)
```

**Rate limits.** `RateLimiter` (token bucket per `action:user_id`, in memory) is the hub default. For several
workers pass `CommsHub(rate_limiter=RedisRateLimiter(bridge))`; it uses the `RedisBridge` client through a Lua
script and falls back to memory while Redis is down. Errors: `{type:"error", code:"rate_limited", retry_after}` or
`code:"too_long", max`; REST answers 429 (with `Retry-After`) / 422. `CallConfig.initiate_rate` (default 5 / 60 s)
limits `call_initiate` (the error carries `context:"call"`). Clients can't create `system` / `deleted` messages.

**Delete, unsend, clear.** WS `delete_message` / `clear_chat` as in the protocol. Tables `comms_message_hidden`
(delete for me) and `comms_chat_cleared` (per user+chat watermark `up_to_message_id` plus `cleared_at`). Unsend
rewrites the row (`message_type "deleted"`, content and file fields cleared) and deletes the media through
`MediaStorage.delete`. `get_messages`, `res_users` (`last_message`, `unread_count`), the REST message list and
unread counts respect hidden / cleared / deleted. Event `chat.message_deleted`.

**Read by peer.** `mark_read` (WS) and `POST /chats/read {chat_id? | candidate_user_id?}` fall back to the pair's chat.

**Server-side sending.**

```python
await chat.send_message_as("U1", "U2", "hello", reply_to_id=None)   # no rate limit; policy only with enforce_policy=True
await chat.send_system_message("U2", "You matched with Asha", about_user_id="U1", data={"kind": "match"})
```

`POST /chats/send {candidate_user_id, content, reply_to_id?}` uses the same pipeline as WS `send_message` (policy,
limits, push). A system message is stored in the chat between `to_user_id` and `about_user_id` (created if needed)
with `sender_id = about_user_id` and `message_type "system"`, shown to `to_user_id` only (hidden for the about-user,
no delivery receipt), delivered live and pushed when offline (`push=False` to skip; `data` is added to the live frame
and the push data, not stored). `about_user_id` is required unless `ChatConfig.system_sender_id` is set. Event
`chat.system_message_sent`.

## Account deletion

`delete_user_data(user_id)` exists on `ChatFeature`, `CallFeature`, `ModerationFeature` and `DevicesFeature`;
`commskit.integration.delete_user_everywhere(hub, user_id)` calls every installed one (chat, call, moderation,
devices), returns `{feature: counts}` and emits `user.deleted`.

- chat: deletes **every chat the user is in** with all its messages (a 1:1 chat is one shared copy, so the partner
  loses that conversation too), hides / clears, and the stored media via `MediaStorage.delete`.
- call: deletes `calls` rows where the user is caller or receiver (live calls are not signalled).
- moderation: deletes blocks involving the user; **reports are kept** with the user's id set to NULL
  (as reporter and as reported) so the moderation history survives.
- devices: deletes the user's `comms_devices` rows.

## Admin report review

```python
moderation = ModerationFeature(admin_dependency=my_admin_dependency).install(hub)   # no routes without it
link_moderation(moderation, chat=chat)                                              # report context from the chat tables
```

`admin_dependency` is a FastAPI dependency you write (raise 401/403; its return value is stored as `resolved_by`).
Routes: `GET /moderation/admin/reports`, `POST /moderation/admin/reports/{id}`, `GET .../{id}/context`.
Python: `moderation.list_reports / resolve_report / report_context`. Moderation never imports chat:
`link_moderation(..., chat=chat)` sets `moderation.context_provider(reporter_id, reported_id, message_id, before,
after) -> [MessageDto]` (or pass your own `context_provider=`; without one `messages` is empty). Event
`moderation.report_resolved`.

**Upgrading.** `comms_reports` gained `resolved_at`, `resolved_by`, `note`, and `reporter_id` / `reported_id` are now
nullable; new tables `comms_message_hidden` and `comms_chat_cleared`. `create_all` creates only the new tables; on an
existing database add the three columns to `comms_reports` (`ALTER TABLE comms_reports ADD COLUMN resolved_at
TIMESTAMP, ADD COLUMN resolved_by VARCHAR(50), ADD COLUMN note TEXT;`) and drop NOT NULL on the two id columns.

## Roles, rooms, presence event, error hook

```python
hub = CommsHub(..., role_resolver=lambda uid: "admin" if uid in ADMINS else "user",   # sync or async
               on_handler_error=my_hook,            # async (user_id, frame, exc); its own errors are logged
               came_online_cooldown=0)              # seconds; 0 = only dedupe concurrent connects
hub.join_room(user_id, "admins")                    # e.g. in an on_connect(hook, all_roles=True)
await hub.broadcast_room("admins", {"event": "new_report", "data": {...}})   # frame sent as given
hub.events.on("user.came_online", fn)               # fn(user_id)
```

Non-`"user"` roles get no `user_status` broadcasts, no delivery flush, no `user.connected` / `user.came_online`, and
`on_connect` / `on_disconnect` hooks skip them unless registered with `all_roles=True`. Rooms are joined per worker
(the one holding the socket) and left on disconnect; with `RedisBridge`, `broadcast_room` also reaches other workers
on `room_channel:{room}`. `user.came_online` fires once per offline -> online transition across workers: with
`RedisBridge` a `SET NX PX` key `came_online:{uid}` dedupes (TTL = cooldown, or 10 s when 0; released on offline when
the cooldown is 0). `on_handler_error` runs for handler exceptions and bad frames (the raw text for bad JSON).

## Media helpers and S3

`commskit.core.media_tools` (`pip install "commskit[media]"`): `make_image_thumbnail` (Pillow, JPEG),
`probe_duration` (ffprobe), `make_video_thumbnail` (ffmpeg); each returns `None` when the tool is missing.
`commskit.core.s3.S3Storage(bucket, region=, prefix=, private=False, presign_expires=, client=)` (`[s3]` extra)
stores `chat/{chat_id}/{media_type}/{ts}_{uuid8}_{name}` with a `_thumb.jpg` next to images / videos, durations for
audio / video, presigned URLs when `private=True` (`storage.presign(url)` refreshes them) and `delete()`. Uploads run
boto3 / Pillow / ffmpeg and base64 decoding in threads. `MediaStorage.delete(file_url)` is optional for custom
storages (skipped when absent); `LocalDiskStorage.delete` is implemented.

## Expo receipts

`ExpoPushSender` remembers ticket ids; `await expo.poll_receipts()` calls `getReceipts` (<= 1000 ids per request),
removes tokens on `DeviceNotRegistered` and forgets answered tickets. `expo.start_receipt_poller(interval=900)` runs it
in the background; `await expo.aclose()` stops it.

## Adapters and policies

| Adapter | Method(s) | Default |
|---|---|---|
| `AuthAdapter` | `user_id_from_token(token) -> str` (sync or async; raise = invalid) | `JwtAuth(secret, algorithm="HS256", claim="uid")` |
| `UserDirectory` | `async get_profiles(ids) -> {id: UserProfile(name, avatar)}` | `NullUserDirectory` (names fall back to ids / "Someone") |
| `PushSender` | `async send(user_id, title, body, data, channel, ttl)` | `NoopPush` |
| `MediaStorage` | `async upload(chat_id, file_name, data, media_type) -> MediaInfo` (raise `ValueError` to reject), optional `async delete(file_url)` | `LocalDiskStorage(root, base_url="/media")` |
| `DeviceRegistry` | `async register(user_id, body)`, `async remove(user_id, body)` | none: the `/chats/expo/push/token[/remove]` routes are **not mounted**; `SqlDeviceRegistry` + `DevicesFeature` provide them (see below) |
| `ChatPolicy` | `can_message`, `block_status`, `extra_conversation_info`, `refusal_message` | `AllowAllChatPolicy` |
| `CallPolicy` | `async authorize(session, caller, receiver, message) -> CallDecision` | `AllowAllCallPolicy` |

`CallPolicy.authorize` runs after busy detection and right before the call row is created; a deny
sends `{"type":"error", **decision.error, "context":"call"}`. `CallConfig` holds the timings
(`ring_timeout=45`, `ringing_disconnect_grace=20`, `answered_disconnect_grace=90`), push channels and TURN.

## Example: adapters for an existing app (Smart Matrimony)

Documentation only; none of this lives in the kit.

```python
# app/comms_adapters.py in matrimonial-backend-v2
from commskit.core import UserProfile, MediaInfo
from commskit.call import CallDecision

class SmmAuth:
    def user_id_from_token(self, token: str) -> str:
        return str(decode_token(token)["uid"])          # app.core.auth.decode_token (raises HTTPException)

class SmmUserDirectory:
    async def get_profiles(self, ids):
        async with AsyncSessionLocal() as db:
            profiles = await MatrimonialProfilesService(db).get_profiles_by_user_id_in(list(ids))
            photos = await PhotosService(db).get_users_profile_photos(list(ids))
        avatars = {p.user_id: p.compressed_url or p.profile_url for p in photos}
        return {p.user_id: UserProfile(p.name, avatars.get(p.user_id)) for p in profiles}

class SmmPush:                                           # Expo via ExpoHelper + user_devices
    async def send(self, user_id, title, body, data, channel="default", ttl=None):
        async with AsyncSessionLocal() as db:
            expo = ExpoHelper(db)
            devices = await expo.user_device_service.get_user_devices(user_id)
            msgs = [PushMessage(to=d.expo_push_token, sound="default", title=title, body=body, data=dict(data),
                                channel_id=channel, priority="high", ttl=ttl)
                    for d in devices or [] if d.is_active and d.expo_push_token]
            if msgs:
                await expo.send_expo_push_httpx(msgs)

class SmmDevices:                                        # backs /chats/expo/push/token[/remove]
    async def register(self, user_id, body): ...         # UserDeviceService.sync_or_register_device(...)
    async def remove(self, user_id, body): ...           # deactivate token if it belongs to user_id

class SmmS3Storage:
    async def upload(self, chat_id, file_name, data, media_type):
        r = await s3_media_manager.upload_media(chat_id=chat_id, filename=file_name, file_content=data,
                                                message_type=media_type)
        if not r["success"]:
            raise ValueError(r["error"])
        return MediaInfo(r["file_url"], r["file_name"], r["file_size"], r["file_type"], r["media_type"],
                         r.get("thumbnail_url"), int(r.get("duration") or 0))

class SmmChatPolicy:
    refusal_message = "Cannot send message. User is blocked."
    async def can_message(self, session, sender, recipient):
        return not await MatchedProfilesService(session).is_blocked_between(sender, recipient)
    async def block_status(self, session, viewer, others):
        s = await MatchedProfilesService(session).get_block_statuses(viewer, list(others))
        return {o: (v["is_blocked"], v["blocked_by_other"]) for o, v in s.items()}
    async def extra_conversation_info(self, session, viewer, other):
        match = await MatchedProfilesService(session).get_user(viewer, other, None)
        return {"chat_consent_given": bool(match and match.chat_consent)}

NOTE = "1 Credit = 1 Profile, Access all Premium Features including Calls, Messages, Profile Views & More."

class SmmCallPolicy:                                     # block check + credits (402 / 403)
    async def authorize(self, session, caller, receiver, message):
        if await MatchedProfilesService(session).is_blocked_between(caller, receiver):
            return CallDecision.deny("Cannot call. User is blocked.")
        pay = ModernPaymentGateway(session)
        acknowledged = bool(message.get("credit_acknowledged"))
        if acknowledged:
            result = await pay.deduct_for_all_feature(caller, receiver, feature=UseType.IN_APP_CALL)
            if result.get("status"):
                return CallDecision.allow()
        elif await has_call_access(pay, caller, receiver):  # unlimited / user access / mutual access
            return CallDecision.allow()
        balance = await pay.get_user_credit_balance(caller)
        info = {"credit_balance": balance, "need_credits": True, "credits_needed": 1, "access_type": "call"}
        if acknowledged or balance <= 0:
            return CallDecision.deny("Insufficient credits to initiate a call. Please purchase credits.",
                                     status=402, message=NOTE, info=info)
        return CallDecision.deny("This would be a paid feature. We will deduct 1 credit from your account "
                                 "upon call initiation for this profile.", status=403, message=NOTE, info=info)
```

Then: `CommsHub(auth=SmmAuth(), users=SmmUserDirectory(), push=SmmPush(), session_factory=AsyncSessionLocal,
connections=ConnectionManager(bridge=RedisBridge(url=settings.redis_url)))`, install both features with the
policies above, `link_chat_and_call`, and register `chat_consent`, the WhatsApp admin events and the
matched-online notification with `hub.on(...)` / `hub.on_connect(...)`. Blocking/reporting can either
stay in the host (register `report_and_block` / `unblock` with `hub.on(...)`, which replaces the kit's
handlers) or move to `ModerationFeature` + `link_moderation`; the policies above keep their own block
check and are combined with the kit's block list.

## Tests

```bash
cd backend/backend-python
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev,redis]"     # Windows; use .venv/bin/python elsewhere
.venv/Scripts/python -m pytest -q
```

Tests run three apps (chat only, call only, chat + call), with moderation and devices on or off,
on SQLite (aiosqlite) through Starlette's `TestClient` websockets, with tiny timeouts for the
ring/disconnect timers. Push tests use `httpx.MockTransport` (no network). The APNs tests generate an
EC P-256 key and need `cryptography`, which comes with the `dev` extra.

## Differences from matrimonial-backend-v2

- `res_messages` also carries `offset` and `has_more` (as PROTOCOL.md specifies); the legacy server omitted them.
- `incoming_call` (WS) also carries `caller_avatar`, as PROTOCOL.md specifies.
- `GET /chats/{user_id}`: `other_user` is `{id, username, avatar}` (no `email`); `GET /chats/{chat_id}/messages`
  returns `MessageDto[]` instead of raw ORM rows.
- `get_messages` for an unknown user no longer replies "User not found" (the kit has no users table);
  it returns the conversation info with the id as name.
- `calls.chat_id` is nullable in the model (call-only mode). An existing Smart Matrimony database can keep `NOT NULL`
  as long as chat is linked.
- Call timestamps are stamped with the DB clock read via `SELECT now()` and durations are computed from two
  DB-clock values in Python, instead of `extract(epoch ...)` in SQL, so the same code runs on SQLite.
  "Last message per chat" uses `MAX(id)` instead of PostgreSQL `DISTINCT ON`.
- Frames rejected before dispatch ("Invalid JSON", "Message must be a JSON object") go to the sending socket only.
