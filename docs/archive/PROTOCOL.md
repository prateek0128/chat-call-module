# commskit wire protocol (v1)

This is the contract between the commskit backend package and its clients. Version 1 matches what
the first host app (Smart Matrimony: `matrimonial-backend-v2` + its React Native app) speaks today,
so either side of an existing app can be swapped for the kit independently. Section 6 lists the legacy quirks that are kept on purpose.

## 1. Transport

- One WebSocket per app: `wss://<host>/ws/<jwt>` (token in the path).
- Server accepts, then validates the token; invalid → close code **1008**.
- A user may have many sockets (devices); every server→client event goes to all of them.
- Every frame is a JSON object with a string `type`.
  - Bad JSON → `{"type":"error","error":"Invalid JSON"}`
  - Not an object → `{"type":"error","error":"Message must be a JSON object"}`
  - Handler crash → `{"type":"error","error":"Message processing failed: <msg>"}`
  - Unknown `type` → ignored (no reply).
- Errors that belong to a call carry `"context":"call"`; clients must only tear down call UI for those.
- User ids are strings. Timestamps are ISO-8601 strings.

## 2. Core / presence

| Direction | type | Payload |
|---|---|---|
| C→S | `ping` | `{}` |
| S→C | `PONG` | `{timestamp}` |
| C→S | `user_status` | `{status: "online" \| "away"}` (app foreground / background; anything but `online` = away) |
| S→C | `user_status` | `{user_id, status: "online" \| "offline" \| "away", timestamp}` – sent to the user's conversation partners when the first socket connects, the last disconnects, or the client reports status |

## 3. Chat

### Client → server

| type | Payload |
|---|---|
| `req_users` | `{}` |
| `get_messages` | `{chat_id?, candidate_user_id?, offset=0, limit=10 (max 100)}` |
| `send_message` | `{candidate_user_id, content, message_type="text", reply_to_id?}` (`chat_id` may be sent, ignored) |
| `mark_read` | `{chat_id}` (`candidate_user_id` may be sent) |
| `typing` | `{target_user_id, is_typing}` |
| `media_upload` | `{target_user_id, file_name, file_data: <base64>, file_type?, media_type?, reply_to_id?}` – max 10 MB decoded |

### Server → client

`MessageDto`:
```json
{"id": 1, "chat_id": 7, "sender_id": "U1", "sender_type": "user|other", "content": "hi",
 "message_type": "text|image|video|audio|voice|document|webm|audio_call|video_call",
 "timestamp": "...", "file_url": null, "file_name": null, "file_size": null, "file_type": null,
 "thumbnail_url": null, "duration": null, "is_read": false, "is_delivered": false,
 "call_id": null, "reply_to": {"id", "sender_id", "content", "message_type", "file_name"} | null}
```
`sender_type` is relative to the receiver of the frame: `"user"` = me, `"other"` = them.

| type | Payload | Sent to |
|---|---|---|
| `res_users` | `{users: [{user_id, username, avatar, status:"online"\|"offline", updated_at, unread_count, last_message:{content, sender_id, timestamp, message_type, file_url, file_size, file_type, file_name, is_read, is_delivered}, chat_id, is_blocked, blocked_by_other}]}` newest first (`is_read`/`is_delivered` are additive in the kit) | requester |
| `req_users_error` | `{error}` | requester |
| `res_messages` | `{messages: MessageDto[] (newest first), offset, has_more, info:{user_id, username, avatar, status, last_seen, chat_consent_given, is_blocked, blocked_by_other}}` | requester |
| `new_message` | `{message: MessageDto(sender_type="other")}` | recipient |
| `message_sent` | `{message: MessageDto(sender_type="user", is_delivered)}` | sender |
| `media_upload_success` | `{message: MessageDto(content=null)}` (before `new_message`/`message_sent`) | sender |
| `chat_read` | `{chat_id}` | reader's own sockets |
| `messages_read` | `{chat_id, read_by}` | the other participant |
| `delivery_status` | `{chat_id, message_ids:[...], status:"delivered", timestamp}` | sender, when the recipient connects |
| `typing_status` | `{user_id, chat_id, is_typing, timestamp}` | target |

Rules:
- Conversations are strictly 1:1. `chat_id` is an integer; `get_or_create` is idempotent per pair.
- Read receipts are per chat: `mark_read` marks **all** of the other person's messages read (and delivered).
- "Delivered" = at least one recipient socket (on any worker) received the frame.
- Offline recipient (no socket, or app in background) gets a push:
  title = sender name, body = text (≤120 chars) or `📎 Attachment`,
  data `{type:"chat", cid:"messaging:<sender_id>", chat_id, sender_id}`, Android channel `messages`.
- Chat policy (host) may refuse a send: `{type:"error", error:<reason>}`.

### Host extensions (not part of the kit, registered by the host app)
`chat_consent` → `chat_consent_updated`, community broadcasts (`new_post`, `new_comment`, ...).
Blocking and reporting are now a kit feature (§7).

## 4. Call (P2P WebRTC, server relays signalling)

### Client → server

| type | Payload |
|---|---|
| `call_initiate` | `{receiver_id, call_type: "audio"\|"video" (default audio), chat_id?, credit_acknowledged?, ...host fields}` |
| `answer_call` | `{call_id}` |
| `reject_call` | `{call_id}` |
| `end_call` | `{call_id}` |
| `sdp_offer` | `{call_id, sdp: RTCSessionDescriptionInit}` |
| `sdp_answer` | `{call_id, sdp}` |
| `ice_candidate` | `{call_id, candidate: RTCIceCandidateInit}` |
| `start_recording` | `{call_id}` (accepted and ignored) |

`reject_call` and `end_call` are equivalent; the server decides the outcome from the call state.

### Server → client

Base payload: `{type, call_id, chat_id (int or null), caller_id, receiver_id, call_type, webrtc_session_id (= call_id), timestamp}`

| type | Extra fields | Sent to |
|---|---|---|
| `call_initiated` | `status:"calling"`, caller view (§6) | caller |
| `incoming_call` | `caller_name`, `caller_avatar`, `sdp?` (stored offer, on reconnect) | receiver |
| `call_ringing` | `status:"ringing"`, caller view | caller, when a receiver socket got `incoming_call` |
| `sdp_offer` / `sdp_answer` | `{call_id, from_user_id, sdp, timestamp}` | other party |
| `ice_candidate` | `{call_id, from_user_id, candidate, timestamp}` | other party |
| `call_answered` | `status:"answered"`, `answerer_id` | caller + answerer's own sockets |
| `call_rejected` | `status:"call_rejected"`, `end_reason:"declined"`, `duration_seconds`, `caller_name`, `rejector_id` | both |
| `call_rejected` (busy) | `{call_id:null, status:"busy", reason:"busy", caller_id, receiver_id, call_type, timestamp}` | caller |
| `call_ended` | `status:"call_ended"`, `end_reason`, `ended_by`, `duration_seconds`, `caller_name` | both |
| `call_missed` | `status:"missed"`, `end_reason:"no_answer"` | both |
| `call_log` | `{call_id, chat_id, message_id, content, status, duration_seconds}` (only when chat is enabled) | both |
| `error` | `{error, context:"call", call_id?, ...policy fields}` | requester |

Policy errors (Smart Matrimony credits) are passed through untouched, e.g.
`{type:"error", context:"call", status:402|403, error, message, info:{credit_balance, need_credits, credits_needed, access_type:"call"}}`.
The client retries with `credit_acknowledged:true` after the user confirms.

### Lifecycle
- States: `ringing → answered → ended`, `ringing → missed | rejected`.
- `end_reason`: `hangup`, `caller_cancelled`, `declined`, `no_answer`, `disconnected`, `stale`.
- Ring timeout **45 s** → `call_missed` (+ missed-call push to an offline receiver).
- Receiver busy (live call) → busy `call_rejected`. Caller already ringing → error "already in a call".
- Socket loss: ringing calls end after **20 s**, answered calls after **90 s** (`disconnected`).
- Reconnecting receiver gets `incoming_call` again, with the stored offer `sdp`.
- Incoming-call push when no receiver socket got the event:
  data `{type:"incoming_call", call_id, chat_id, caller_id, caller_name, caller_avatar, call_type}`, channel `call_ringtone`, ttl 45.
- Missed-call push: data `{type:"missed_call", call_id, chat_id, caller_id, call_type}`, channel `messages`.
- Call log text: `Voice call · MM:SS` (`H:MM:SS` ≥ 1 h), `Missed voice call`, `Declined voice call` (a caller-cancelled call is also `Missed voice call`; installed apps only parse Missed/Declined); `video` instead of `voice` for video.
- Signalling flow: caller `call_initiate` → `call_initiated` → caller sends full `sdp_offer` (after ICE gathering) → receiver accepts → sets offer, sends `sdp_answer` + `answer_call` → caller gets `sdp_answer` / `call_answered` → connected. ICE candidates may be trickled both ways.

### REST
- `POST /call/{call_id}/reject` (Bearer) – decline from a notification while the app is not running → `{status:true}` / 404.
- `POST /call/turn-credentials` (Bearer) → `{username, password, ttl, uris:[...]}` (coturn REST-API scheme).

## 5. REST (chat)

All Bearer-authenticated.
- `POST /chats/start?candidate_id=<id>` → `{chat_id, user1_id, user2_id, created_at, updated_at}`
- `GET /chats/{user_id}` (self only) → conversation summaries
- `GET /chats/{chat_id}/messages?limit=50&offset=0` → `MessageDto[]`
- `POST /chats/{chat_id}/read` → `{"message":"Messages marked as read"}` (+ `chat_read` / `messages_read` events)
- `GET /chats/{user_id}/unread-count` → `{unread_count}`
- `GET /chats/{user_id}/online-status` → `{user_id, is_online}`
- `POST /chats/expo/push/token` / `POST /chats/expo/push/token/remove` → handled by the host's push adapter

## 6. Legacy quirks kept for compatibility

| Quirk | Why kept | Kit location |
|---|---|---|
| `PONG` is upper-case | installed apps match on it | `commskit.core.compat` |
| Caller-side `call_initiated` / `call_ringing` put the **receiver** in `caller_id` / `caller_name` ("caller view") | installed apps read the peer from `caller_id` | `commskit.call.handlers._caller_view` |
| `caller_name` in `call_ended` / `call_rejected` is the caller's **id** | same | `commskit.call.handlers` |
| Busy is `call_rejected` with `call_id:null` | same | `commskit.call.handlers` |
| `cid` format `messaging:<peer_user_id>` in chat push data | app notification routing | `commskit.chat.handlers` |

The mobile kit normalises all of these in one place (`call/compat.ts`), so app code only sees clean values.


## 7. Moderation: block and report (optional feature `moderation`)

Works with chat only, calls only, or both. When installed, its block list feeds the chat and call
policies: a blocked pair can't message, type to, or call each other, and an active call between
them ends (`end_reason: "blocked"`). The event names match the Smart Matrimony app.

### Client → server

| type | Payload |
|---|---|
| `report_and_block` | `{candidate_user_id, reason?, category?, message_id?, block = true}` (report, and block unless `block: false`) |
| `block` | `{candidate_user_id}` |
| `unblock` | `{candidate_user_id}` |

### Server → client

| type | Payload | Sent to |
|---|---|---|
| `user_blocked` | `{candidate_user_id, message}` | blocker's sockets |
| `blocked_by_user` | `{candidate_user_id, message}` (only when `notify_blocked_user` is on, the default for compatibility) | the blocked user |
| `user_unblocked` | `{candidate_user_id, message}` | blocker's sockets |
| `unblocked_by_user` | `{candidate_user_id, message}` (same switch) | the other user |
| `report_received` | `{report_id, candidate_user_id}` | reporter |
| `error` | `{error, context: "moderation"}` | requester |

`res_users` / `res_messages.info` carry `is_blocked` (I blocked them) and `blocked_by_other`.

### REST (Bearer)
- `GET /moderation/blocks` → `[{user_id, username, avatar, blocked_at}]`
- `POST /moderation/blocks` `{user_id}` → `{status: true}`
- `DELETE /moderation/blocks/{user_id}` → `{status: true}`
- `POST /moderation/reports` `{user_id, reason, category?, message_id?, block?: bool}` → `{report_id}`

Report categories (suggested, free text allowed): `spam`, `harassment`, `inappropriate`, `fake_profile`, `scam`, `underage`, `other`.
Reports are stored for review; the host gets an `on_report` hook (e.g. email the moderation team).

## 8. Devices and push notifications (optional, `DeviceRegistry`)

### REST (Bearer)
- `POST /devices` `{device_id, platform: "ios"|"android"|"web", expo_push_token?, voip_token?, app_version?, os_version?, model?}` → `{status: true}` (upsert by `device_id`)
- `DELETE /devices/{device_id}` → `{status: true}` (logout)
- Legacy, kept for installed apps: `POST /chats/expo/push/token`, `POST /chats/expo/push/token/remove`.

### Push payloads
| When | Channel | Payload (`data`) |
|---|---|---|
| New message, recipient not online | Expo push, Android channel `messages`, title = sender, body = text (≤120) or `📎 Attachment` | `{type: "chat", cid: "messaging:<sender_id>", chat_id, sender_id}` |
| Incoming call, no socket got it: **iOS** | APNs **VoIP** push (PushKit, topic `<bundle id>.voip`, priority 10, expires in 45 s); the app must report it to CallKit immediately | `{type: "incoming_call", call_id, chat_id, caller_id, caller_name, caller_avatar, call_type, uuid}` (`uuid` = CallKit UUID derived from `call_id`) |
| Incoming call: **Android** | Expo push, priority high, ttl 45, channel `call_ringtone`; `android_call_style = "data"` sends a data-only message so the app shows its own full-screen call notification, `"notification"` sends a visible one | same as iOS without `uuid` |
| Incoming call: iOS without a VoIP token | regular Expo push (fallback) | same |
| Missed or cancelled call | Expo push, channel `messages` | `{type: "missed_call", call_id, chat_id, caller_id, call_type}` |

Tokens that the push service reports as invalid (`DeviceNotRegistered`, APNs `410`/`BadDeviceToken`) are removed.


## 9. Chat extras (kit additions; all optional, old clients ignore them)

### Delete, unsend and clear
| Direction | type | Payload |
|---|---|---|
| C→S | `delete_message` | `{message_id, for_everyone = false}` |
| S→C | `message_deleted` | `{chat_id, message_id, for_everyone}`; for everyone: sent to both participants, otherwise only to the requester's sockets |
| C→S | `clear_chat` | `{chat_id?, candidate_user_id?}` (one of them) |
| S→C | `chat_cleared` | `{chat_id, cleared_at}` to the requester's own sockets |

- **Unsend (for everyone):** only the sender, only within `ChatConfig.unsend_window_seconds` (default 3600; `0` = no limit, `-1` = disabled). The row stays, with `message_type: "deleted"`, `content: null`, file fields cleared; stored media is deleted through `MediaStorage.delete`. Clients render "This message was deleted".
- **Delete for me:** hides that message for the requester only.
- **Clear chat:** hides every message up to now for the requester only; the other person keeps theirs. `res_users.last_message` / `unread_count` and `get_messages` respect it.
- Errors: `{type: "error", error, code: "not_allowed" | "not_found" | "window_expired"}`.

### Read without a chat id
`mark_read` accepts `{candidate_user_id}` when `chat_id` is missing (both may be sent; `chat_id` wins).

### System messages
`message_type: "system"`, `sender_type: "system"` in `MessageDto`; created server-side only (Python API `ChatFeature.send_system_message(to_user_id, content, *, about_user_id=None, data=None)`), e.g. "You matched with Asha". Old clients show the text as a normal message.

### REST send (bots, admins, tests)
- `POST /chats/send` (Bearer) `{candidate_user_id, content, reply_to_id?}` → `MessageDto`; same rules and events as WS `send_message` (policy, rate limits, push).
- Server-side helper for trusted code: `ChatFeature.send_message_as(sender_id, to_user_id, content, ...)`.

### Limits
- Rate limits per user (token bucket, configurable; defaults: 20 messages / 10 s, 5 uploads / 60 s, typing 5 / 5 s silently dropped).
- Max text length `ChatConfig.max_text_length` (default 4000).
- Error: `{type: "error", error, code: "rate_limited", retry_after}` or `{..., code: "too_long", max}`. Typing over the limit is dropped without an error.

### Admin report review (moderation; host supplies the admin auth dependency)
- `GET /moderation/admin/reports?status=open|resolved|dismissed&limit&offset` → `[{report_id, reporter_id, reported_id, reason, category, message_id, status, created_at, resolved_at, resolved_by, note}]`
- `POST /moderation/admin/reports/{report_id}` `{status: "resolved" | "dismissed", note?}` → updated report
- `GET /moderation/admin/reports/{report_id}/context?before=20&after=20` → `{report, messages: MessageDto[]}` (messages around `message_id`, or the latest between the pair)

### Presence event
`hub.events` `user.came_online` `{user_id}` fires once when a user goes from offline to online across **all** workers (Redis-backed when the bridge is used), with an optional per-user cooldown, so hosts can send "your match is online" without duplicates.
