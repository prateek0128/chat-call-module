# commskit — Implementation plan

Goal: pull the user-to-user **chat** and **voice calling** out of
`matrimonial-backend-v2` (FastAPI) and `smm_android_react_native_v2` (Expo / React Native)
into one generic, reusable kit where:

- you can use **chat only**,
- you can use **call only**,
- or you can use **chat + call** together (call logs show up in the chat, "Message" from the call screen opens the chat).

The kit has two halves that speak one wire protocol ([PROTOCOL.md](PROTOCOL.md)):

| Half | Path | Package / import name |
|---|---|---|
| Backend (Python, FastAPI, SQLAlchemy async) | `backend/backend-python/` | `commskit` → `commskit.core`, `commskit.chat`, `commskit.call` |
| Mobile (TypeScript, React Native / Expo) | `mobile/` | `commskit` → `commskit/core`, `commskit/chat`, `commskit/call` |

---

## 1. What exists today (summary of the audit)

### Backend (`matrimonial-backend-v2`)
- One WebSocket `/ws/{jwt}` (`app/routes/websocket.py`) carries **chat, call signalling, community broadcasts and the admin WhatsApp inbox**.
  Every frame is routed by `type` in `WebsocketGateway.controller` (`app/gateways/websocket_gateway.py:614`).
- Chat: `ChatService` (`app/services/chat_service.py`), tables `chats` (strict 1:1, `user1_id < user2_id`) and `messages`.
  Media is sent as base64 over the socket (`media_upload`, 10 MB) and stored in S3 by `S3MediaManager`.
- Calls: `CallService` (`app/services/call_service.py`), table `calls`. The server only relays SDP/ICE (P2P WebRTC, audio only in practice).
  Ring timeout 45 s, disconnect grace 20 s (ringing) / 90 s (answered). A finished call rewrites its chat message into a call log (`"Voice call · 05:42"`).
- Presence and multi-worker fan-out via Redis (`presence:{uid}`, `user_channel:{uid}` pub/sub) in `app/websocket/manager.py` / `redis_manager.py`.
- Push via Expo (`ExpoHelper.send_expo_push_httpx`), devices in `user_devices`.
- Matrimonial-specific logic mixed in: blocking via `matched_profiles`, chat consent, report & block, **call credits** (`ModernPaymentGateway`, 402/403 errors), profile names/photos, "matched user is online" notifications.
- No tests for chat or call. Docs in `docs/CHAT_API.md` are stale.

### Mobile (`smm_android_react_native_v2`)
- Chat engine: `src/contexts/websocketContext.tsx` (1 378 lines). It opens its own socket, and is mounted 3 times (MainTabs, Channel, Thread) → up to 3 chat sockets.
- Call engine: `src/contexts/callContext.tsx` + `src/hooks/useVoiceCall.ts`. Opens **another** socket to the same URL. WebRTC via `@stream-io/react-native-webrtc`, audio routing/ringtone via `react-native-incall-manager`. TURN credentials hard-coded.
- UI: `src/screens/chatScreen/**` (channel list, chat screen, bubbles, input, call screen, incoming-call screen).
- Native Android call notifications: committed Kotlin in `android/app/src/main/java/.../calls/` (full-screen ringing, ongoing-call service, decline-while-killed via `POST /call/{id}/reject`). iOS has no CallKit / VoIP push.
- Couplings: token from AsyncStorage `authToken`, user id from `userId`, hard-coded base URL, hard-coded navigation names (`"Channel"`, `"ChatHome"`, `"Settings" > "BuyCredits"`), credit modals inside the call provider, ads in the chat list, community events on the chat socket, Smart Matrimony branding.

---

## 2. Design

### 2.1 Principles
1. **Wire-compatible.** The kit speaks exactly today's protocol, quirks included (see PROTOCOL.md §6), so the backend can switch to it **without breaking app versions already installed on users' phones**. Quirks are isolated in one place on each side so they can be removed once old app versions are retired.
2. **Three layers, one direction of dependency:** `core` ← `chat`, `core` ← `call`. `chat` never imports `call` and vice versa. The "chat + call" behaviour is wired through events/hooks, not imports.
3. **App-specific rules are plug-ins.** Blocking, consent, credits, profile names, push, storage, navigation, branding are supplied by the host app through small interfaces (adapters/hooks). The kit ships safe defaults (allow everything, no push, in-memory presence).
4. **One socket per app.** The mobile `core` owns a single WebSocket; chat and call subscribe to it by `type`.
5. **Headless first, UI second.** Phase 1 delivers logic (providers + hooks). UI components come as a separate opt-in entry so apps can keep their own design.

### 2.2 Backend layout (`backend/comms`)

```
comms/
  core/
    hub.py            CommsHub: registry of WS handlers by type, feature registration, lifecycle hooks
    connections.py    ConnectionManager: sockets per user, presence, fan-out (+ optional Redis bridge)
    adapters.py       Protocols the host implements: AuthAdapter, UserDirectory, PushSender,
                      MediaStorage, SessionFactory + no-op defaults
    websocket.py      build_ws_router(hub) -> APIRouter with "/ws/{token}"
    events.py         tiny async event bus (call.finalized, chat.message_sent, user.connected ...)
    db.py             CommsBase (DeclarativeBase) - kit owns its own metadata
  chat/
    models.py         Chat, Message (table names default to today's: chats, messages)
    service.py        ChatService (get_or_create, send, paginate, read/delivered, unread, reply previews)
    policy.py         ChatPolicy protocol: can_message(a, b) (blocking/consent live here)
    handlers.py       WS handlers: req_users, get_messages, send_message, mark_read, typing, media_upload, user_status, ping
    router.py         REST: /chats/start, /chats/{user_id}, /chats/{chat_id}/messages, /read, /unread-count, push token
    feature.py        ChatFeature(...).install(hub)
  call/
    models.py         Call (table name default: calls)
    service.py        CallService (create, mark_answered, finalize, live-call queries, offer SDP)
    policy.py         CallPolicy protocol: authorize(caller, receiver, msg) -> Allow | Deny(error payload)  (credits live here)
    handlers.py       WS handlers: call_initiate, answer_call, reject_call, end_call, sdp_offer, sdp_answer, ice_candidate
    lifecycle.py      ring timeout, disconnect grace, busy detection, re-ring on reconnect
    turn.py           TURN REST credentials (HMAC, secret from config)
    router.py         REST: POST /call/{call_id}/reject, POST /call/turn-credentials
    feature.py        CallFeature(...).install(hub)
  integration/
    chat_call.py      link_chat_and_call(chat, call): call creates/rewrites a chat call-log message
                      and resolves chat_id - only imported when both are used
```

Using it:

```python
from commskit.core import CommsHub
from commskit.chat import ChatFeature          # optional
from commskit.call import CallFeature          # optional
from commskit.integration import link_chat_and_call   # only for chat + call

hub = CommsHub(auth=MyAuth(), users=MyUserDirectory(), push=MyPush(), session_factory=AsyncSessionLocal)
chat = ChatFeature(policy=MyChatPolicy(), storage=MyS3Storage()).install(hub)
call = CallFeature(policy=MyCreditPolicy(), turn_secret=settings.turn_secret).install(hub)
link_chat_and_call(chat, call)
app.include_router(hub.ws_router())            # /ws/{token}
app.include_router(hub.rest_router())          # /chats/..., /call/...
```

Host-specific WS events (community, WhatsApp admin, `chat_consent`, `report_and_block`, `unblock`) are registered by the host with `hub.on("report_and_block", handler)`. They stay in the matrimonial app, not in the kit.

### 2.3 Mobile layout (`mobile/src`)

```
core/
  CommsClient.ts      single WebSocket: connect(token), reconnect backoff, AppState handling,
                      send(type, payload), on(type, handler), status events
  CommsProvider.tsx   React context: owns one CommsClient, config (baseUrl, getToken, getUserId)
  config.ts           CommsConfig type, URL helpers
  userDirectory.ts    shared user_id -> {name, avatar} cache (used by chat and call)
  types.ts            wire types (shared)
chat/
  ChatStore.ts        framework-free state: conversations, messages per chat, typing, receipts, pagination
  ChatProvider.tsx    binds ChatStore to CommsClient, exposes context
  hooks.ts            useChat(), useConversations(), useConversation(peerId), useUnreadCount()
  api.ts              REST: startChat, register/remove push token
  types.ts
call/
  VoiceCallEngine.ts  WebRTC state machine (offer/answer/ICE, timeouts, mute) - no React
  CallProvider.tsx    binds engine to CommsClient, exposes context, ringing/timeouts
  hooks.ts            useCall()
  adapters.ts         CallAudio (InCallManager default), CallNotifier (no-op default; host plugs native module)
  iceServers.ts       static list or fetched TURN credentials
  types.ts
index.ts              re-exports core only
```

`package.json` `exports` give three entry points so Metro only bundles what you import:

```ts
import { CommsProvider } from "commskit/core";
import { ChatProvider, useConversation } from "commskit/chat";   // chat only
import { CallProvider, useCall } from "commskit/call";           // call only

<CommsProvider config={{ baseUrl, getToken, getUserId }}>
  <ChatProvider>            {/* optional */}
    <CallProvider onOpenChat={peerId => navigate("Channel", ...)} onCallError={showCreditModal}>  {/* optional */}
      <App />
    </CallProvider>
  </ChatProvider>
</CommsProvider>
```

`@stream-io/react-native-webrtc` and `react-native-incall-manager` are **optional peer dependencies** needed only by `commskit/call`; a chat-only app never installs them.

Chat + call wiring on mobile: the chat store already understands `call_log` / `call_*` events as chat entries (they are part of the chat wire protocol), and `CallProvider` takes an `onOpenChat(peerId)` callback. No import between the two.

---

## 3. Step-by-step plan

### Phase 0 — Groundwork (this folder) ✅ started
1. Create `commskit/` with `backend/`, `mobile/`, `docs/`.
2. Write [PROTOCOL.md](PROTOCOL.md): every event name and payload, as the contract both halves are tested against.
3. Write this plan.

### Phase 1 — Backend core
4. `commskit.core.adapters`: define `AuthAdapter` (`user_id_from_token`, FastAPI dependency for REST), `UserDirectory` (`get_profiles(ids) -> {id: UserProfile(name, avatar)}`), `PushSender` (`send(user_id, title, body, data, channel, ttl)`), `MediaStorage` (`upload(chat_id, file_name, bytes) -> MediaInfo`). Provide `JwtAuth(secret, claim="uid")` and no-op defaults.
5. `commskit.core.connections`: port `ConnectionManager` (multi-socket per user, `send_to_user` returns delivered flag, away/online status, partners lookup callback for status broadcast, offline hooks). Redis bridge as an optional class (`RedisBridge`) with the same keys as today (`presence:{uid}`, `user_channel:{uid}`) so old and new workers can coexist during rollout.
6. `commskit.core.hub`: `CommsHub` with `on(type, handler)`, `dispatch(user_id, msg, session)`, `on_connect` / `on_disconnect` hooks, an event bus, and `ws_router()` / `rest_router()`.
7. `commskit.core.websocket`: the `/ws/{token}` endpoint (accept → auth → close 1008 on failure, heartbeat, JSON validation, per-frame DB session, error reply).

### Phase 2 — Backend chat
8. Models `Chat`, `Message` on `CommsBase`, **same table/column names as today** (no FK to `users` at ORM level, so the kit doesn't depend on the host's user table; existing DB constraints stay).
9. `ChatService` ported from `app/services/chat_service.py`, minus matrimonial calls.
10. `ChatPolicy` protocol (`can_message(sender, recipient) -> bool`, `block_status(viewer, other) -> (is_blocked, blocked_by_other)`, `extra_conversation_info`). Default: allow all, not blocked.
11. WS handlers with exactly today's payloads (`res_users`, `res_messages`, `new_message`, `message_sent`, `media_upload_success`, `chat_read`, `messages_read`, `delivery_status`, `typing_status`, `user_status`, `PONG`).
12. Offline push for new messages through `PushSender` (data `{type:"chat", cid:"messaging:{sender}", chat_id, sender_id}`, channel `messages`).
13. REST router (`/chats/start`, list, messages, read, unread-count, online-status, push token register/remove).

### Phase 3 — Backend call
14. Model `Call` (table `calls`, same columns). `CallService` ported (atomic `mark_answered` / `finalize`, DB-clock timestamps, live-call windows).
15. `CallPolicy` protocol: `authorize(caller, receiver, message) -> CallDecision` (allow / deny with error payload, e.g. the 402/403 credit errors). Default: allow.
16. WS handlers + lifecycle: busy detection, stale-call cleanup, ring timeout (45 s), disconnect grace (20 s / 90 s), re-send `incoming_call` with stored offer on reconnect, incoming-call push when no socket got it, missed-call push.
17. Event `call.finalized(CallInfo)` on the hub bus; `call_log` payload built by the integration layer.
18. REST: `POST /call/{call_id}/reject` (notification decline), `POST /call/turn-credentials` (authenticated, secret from config).
19. Call works **without chat**: `chat_id` in payloads is `null` and no chat message is written.

### Phase 4 — Backend integration (chat + call)
20. `link_chat_and_call(chat, call)`: on `call_initiate` resolve/create the chat and insert the `[Call Initiated]` message; on `call.finalized` rewrite it to the log text and emit `call_log` to both users; include `chat_id` in call payloads.

### Phase 5 — Backend tests
21. pytest + httpx/Starlette `TestClient` WebSocket tests on SQLite (aiosqlite): chat-only app, call-only app, chat+call app. Cover send/receive, pagination, read receipts, typing, call happy path, reject, busy, timeout, call log message.

### Phase 6 — Mobile core
22. `CommsClient`: one socket, `${wsBaseUrl}/ws/${token}`, exponential backoff (1 s → 30 s), reconnect on foreground, `user_status` online/offline on AppState, typed `on/off/send`, connection status listeners, token refresh via `getToken()` on each connect.
23. `CommsProvider` + `useComms()`; `UserDirectory` cache shared by chat and call.

### Phase 7 — Mobile chat
24. `ChatStore` (pure TS, testable): conversations from `res_users`, messages from `res_messages`, optimistic `temp_*` messages replaced by `message_sent`, unread logic with "active chat" suppression, typing (auto-clear 4 s), `messages_read`, `delivery_status`, monotonic ticks, call entries (`call_log`, `call_*`), pagination (limit 10).
25. `ChatProvider` + hooks: `useConversations()`, `useConversation(peerId)` (messages, send, sendMedia, loadMore, typing, markRead), `useUnreadCount()`.
26. Media: `sendMedia({uri,name,type,size})` reads base64 through an injectable `readFileAsBase64` (default: `expo-file-system/legacy`), 10 MB guard.
27. REST helpers (`startChat`, push-token register/remove) using `fetch` + `getToken()` (no axios dependency).

### Phase 8 — Mobile call
28. `VoiceCallEngine` ported from `useVoiceCall.ts` as a plain class: states idle → ringing → connected, caller sends full offer after ICE gathering (3 s), callee waits for offer (10 s), ICE queueing, multi-device "answered elsewhere", busy, credit errors forwarded untouched.
29. `CallProvider` + `useCall()`: `startCall(peerId, {chatId, peerName, extra})`, `accept`, `reject`, `end`, `toggleMute`, `toggleSpeaker`; callbacks `onCallError` (host shows credit modals and can retry with `extra: {credit_acknowledged: true}`), `onCallEnded(summary)`, `onOpenChat(peerId)`.
30. Adapters: `CallAudio` (default InCallManager: start/stop, ringtone, speaker), `CallNotifier` (no-op default; the Smart Matrimony app plugs its native Android module), `iceServers` (static or fetched from `/call/turn-credentials`).
31. Optional UI entry `commskit/call-ui` later: port `CallScreenUI` + `IncomingCallScreen` with theme props.

### Phase 9 — Mobile UI kit (optional entry `commskit/chat-ui`)
32. Port `CustomMessageList`, `CustomMessageBubble`, `CustomMessageInput`, `TypingIndicator`, channel list as themeable components (colors/fonts via a theme prop, no app imports, no ads).

### Phase 10 — Migrate Smart Matrimony to the kit
33. Backend: install `commskit` (path dependency), implement Smart Matrimony adapters in the backend:
    `SmmAuth` (existing `decode_token`), `SmmUserDirectory` (profile name + photo), `SmmPush` (ExpoHelper + `user_devices`),
    `SmmS3Storage` (S3MediaManager), `SmmChatPolicy` (`is_blocked_between`, `get_block_statuses`, `chat_consent_given`),
    `SmmCallPolicy` (credit gate + `deduct_for_all_feature`).
    Register host-only events with `hub.on(...)`: `chat_consent`, `report_and_block`, `unblock`, WhatsApp admin, `matched_online_notification` on connect.
    Replace `app/routes/websocket.py` + `WebsocketGateway.controller` chat/call branches with the hub. Keep community broadcasts going through `hub.connections.broadcast`.
34. Roll out behind a flag (`COMMS_KIT_ENABLED`) on one worker first; the Redis key names are shared so mixed workers interoperate.
35. Mobile: wrap App in `CommsProvider` once (removes the 3 extra sockets), replace `WebSocketProvider` with `ChatProvider`, `CallProvider`/`useVoiceCall` with the kit's `CallProvider`, keep the screens but feed them from kit hooks. Credit modals move to `onCallError`. The native Android notification module becomes the `CallNotifier` adapter (later: an Expo config plugin so `prebuild --clean` doesn't drop it).
36. Clean-ups the audit found (do separately, after migration): auth on `/users/turn-credentials`, `/chats/stream/token`, `/chats/devices/sync`; move hard-coded secrets (JWT, TURN, DB) to env; delete GetStream leftovers and broken `/api/media/*`; exclude `/chats/*` GETs from the 300 s Redis cache middleware; add the missing `message_tone.mp3` asset check.

### Phase 11 — Remove legacy quirks (after old app versions are retired)
37. Fix caller-view `caller_id` swap, `PONG` casing, flat vs wrapped `new_message`, busy as `call_rejected` with `call_id:null`. All are behind `LegacyCompat` flags on the backend and handled in one function on mobile.

---

## 4. Status

| Phase | State |
|---|---|
| 0 Groundwork | done |
| 1–5 Backend core / chat / call / integration / tests | done: 40 tests pass on SQLite; not yet run on PostgreSQL / real Redis |
| 6–8 Mobile core / chat / call | done: typecheck clean, 72 tests pass on the pure-TS parts; React providers not yet run inside a real Expo app |
| 9 UI kit | done: shared design system (`design/`); browser demo redesign (41 headless-Chrome UI tests over 7 viewports and 3 modes); RN `theme` / `chat-ui` / `call-ui` entries (typecheck + 159 tests with a mocked RN; not yet run on a device) |
| 10 Migration of Smart Matrimony | not started (requires your go-ahead: it changes production code) |
| 11 Quirk removal | not started |
