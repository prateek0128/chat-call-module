# commskit-web: keys, secrets, WebSockets and placeholders

Read this before you put the web chat on a public site. It answers four questions:
what may live in the browser, which config values the web side needs, how the WebSocket behaves, and which parts of the demo are placeholders you must replace.

Series: [01 Overview](01-overview.md) | **02 Keys, secrets, WebSockets, placeholders (this file)** | [03 Using, running, deploying](03-using-running-and-deploying.md) | [Web example](../example/web-example.md) | [Design](../design/design-overview.md)

Everything was checked against `web/src`, `mobile/src/core` + `mobile/src/chat` + `mobile/src/moderation` (the shared engine), `backend/backend-python/commskit/core/websocket.py`,
`examples/backend/demo-server-python/demo_server.py` and `examples/web-app`. **(unverified)** marks statements I could not confirm from code.

## Table of contents
- [A. The rule: browser code is public](#a-the-rule-browser-code-is-public)
- [B. Config value reference](#b-config-value-reference)
- [C. The WebSocket](#c-the-websocket)
- [D. Placeholders](#d-placeholders)

---

## A. The rule: browser code is public

Anything you put in the JavaScript bundle, in `import.meta.env.*` / `process.env.*` that gets inlined at build time, in `localStorage`, or in HTML can be read by every visitor.
Minifying does not hide it. So: **never put a private key in browser code.**

### What is private (server only)

| Secret | Where it lives | Used for |
|---|---|---|
| JWT signing secret (`JwtAuth(secret=...)`, the demo calls it `COMMS_DEMO_SECRET`) | backend only | signs and verifies the user token |
| TURN shared secret (`TURN_SECRET`) | backend only | makes short-lived TURN credentials (calls; not used by the web package) |
| APNs key (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`) | backend only | iOS VoIP push (mobile) |
| Expo access token (`EXPO_ACCESS_TOKEN`) | backend only | Expo push (mobile) |
| AWS / S3 credentials | backend only | `S3Storage` for media |
| Database / Redis URLs and passwords | backend only | persistence |
| A future VAPID **private** key | backend only | Web Push (does not exist yet, see below) |

### What the page legitimately has

| Value | Why it is OK in the browser |
|---|---|
| The logged-in user's **auth token** (JWT) | It identifies one user, expires, and your login issued it. It is the same thing your site already holds after login. |
| The user's id | Not secret. |
| The server **base URL** (`https://api.example.com`) | Public by nature. |
| A future VAPID **public** key | Designed to be public. |

The web package never needs, and never asks for, any server secret. Check: `grep -rn "secret\|apiKey\|VAPID" web/src` returns nothing.

### Where to keep the token

The package only needs a function `getToken()` that returns the current token. It calls it on **every connect/reconnect and every REST call**, so you may refresh the token behind it.

| Storage | Risk | Advice |
|---|---|---|
| JS memory (a variable, React state, your auth store) | Gone on reload (you re-fetch it from your session). Not readable by other scripts unless they can reach your module. | **Best default.** Get a fresh chat token from your own backend after login. |
| `sessionStorage` | Readable by any script on the page (XSS). Cleared when the tab closes. | What `examples/web-app` does (`commskit.demo.session`). Fine for a demo. |
| `localStorage` | Readable by any script on the page (XSS), survives for months, shared by all tabs. | Avoid for tokens unless the token is short-lived. |
| Cookie `HttpOnly` | JavaScript cannot read it, so `getToken()` cannot return it. | Use it for your **site session**, then add an endpoint such as `GET /api/chat-token` (session cookie in, short-lived chat JWT out) and call it from `getToken()`. |

Practical pattern (works with any of the above):

```ts
const config = {
  baseUrl: "https://api.example.com",
  getToken: async () => (await fetch("/api/chat-token", { credentials: "include" })).json().then((r) => r.token),
  getUserId: () => currentUser.id,
};
```

`getToken` may return a promise (`MaybePromise` in `mobile/src/core/config.ts`).
If you do this, cache the token for its lifetime, because the package calls `getToken()` before each REST call and each reconnect.

The main defence for any of these is preventing XSS: strict CSP, no `dangerouslySetInnerHTML` with user data, and keep dependencies current.
The kit renders message text as React text (links are built as `<a>` elements from parsed parts in `web/src/util.ts` `splitLinks`), not as raw HTML.

### The token is in the WebSocket URL

The socket URL is `wss://host/ws/<token>` (protocol section 1, `docs/archive/PROTOCOL.md`). Browsers cannot set an `Authorization` header on a WebSocket, hence the path token.
Consequences:

- The token can end up in **server / proxy access logs** (nginx logs the request line by default), and in browser devtools. Treat access logs as sensitive, or mask the path (for example `log_format` without `$request_uri`, or a map that cuts the token). Config example is in [03](03-using-running-and-deploying.md#nginx-same-origin-proxy-untested).
- Use short-lived tokens, so a leaked log line is useless soon.
- Always use `wss://` in production (TLS hides the path from the network).
- The token is `encodeURIComponent`-encoded (`socketUrl` in `mobile/src/core/config.ts`), so JWT characters are safe.

---

## B. Config value reference

### B1. Provider and screen props

`CommsWebProvider` (also reachable through `CommsStack`'s `config`, `comms`, `chat` props). Verified in `web/src/providers.tsx` and `mobile/src/core/config.ts`.

| Prop | Type / default | What it is | Production value |
|---|---|---|---|
| `config.baseUrl` | string, required | REST base. Must start with `http://`, `https://` (or `ws(s)://`), else `deriveWsUrl` throws `[comms] baseUrl must start with ...`. Trailing slashes are trimmed. | `https://api.example.com`, or your own origin if you reverse-proxy |
| `config.wsUrl` | string, optional | WebSocket base. Default: derived from `baseUrl` (`https` -> `wss`, `http` -> `ws`). | Set only when the socket lives on a different host than REST |
| `config.getToken` | `() => string \| null \| undefined \| Promise<...>` | Called on every connect and REST call. `null` means "logged out": the client goes to status `unauthenticated` and does not connect. | Your login |
| `config.getUserId` | same shape | Called on every connect. | Your login |
| `config.logger` | `{debug,info,warn,error}`, optional | Diagnostics. `consoleLogger` is not exported by `commskit-web`; pass your own object. | Omit, or your logger |
| `autoConnect` | boolean, default `true` | Connect on mount. | `false` if you mount before login, then call `useComms().client.connect()` |
| `offlineSendPolicy` | `"drop"` (default), `"queue"`, or a function | What `send` does while the socket is down. | Your choice |
| `pingIntervalMs` | number, default `0` (off) | Client `ping` every N ms. See [C](#c-the-websocket). | `25000` behind proxies with idle timeouts |
| `createWebSocket` | factory | Replace the browser `WebSocket` (tests). | Omit |
| `client`, `users` | `CommsClient`, `UserDirectory` | Bring your own. | Omit |

`ChatScreen` props that are really configuration (`web/src/ChatScreen.tsx`):

| Prop | Default | Must match / depends on |
|---|---|---|
| `mediaBaseUrl` | `config.baseUrl` | Where relative `file_url` values (for example `/media/abc.png` from the demo's `LocalDiskStorage(base_url="/media")`) are loaded from. Absolute URLs (S3 / CDN) are used as they are (`resolveMediaUrl`). |
| `documentViewerUrl(message, fileUrl)` | none | Return an iframe URL to preview documents. Without it the viewer shows Download. |
| `unsendWindowSeconds` | `3600` | **Must equal the server's `ChatConfig.unsend_window_seconds`** (default 3600 in `backend/backend-python/commskit/chat/feature.py`). `0` = no limit, `-1` = off. The server is the authority; a mismatch only changes when the button shows. |
| `maxUploadBytes` | `10 * 1024 * 1024` | Mirror of the server's `ChatConfig.max_upload_bytes` (also 10 MiB). The browser checks first; the server enforces. |
| `onCall` | none | Shows a call button. You wire your own calling. |

Related server limits you should know (`docs/archive/PROTOCOL.md` section 9): max text 4000 chars, rate limits (default 20 messages / 10 s, 5 uploads / 60 s). The UI shows a rate-limit notice when the server answers `rate_limited`.

### B2. Browser storage and APIs used

| Item | Name / key | Where | Contents |
|---|---|---|---|
| `localStorage` | `commskit.appearance.v1` (`APPEARANCE_STORAGE_KEY`; change with `AppearanceProvider storageKey`) | `web/src/appearance.tsx` | JSON: mode, theme preset, global wallpaper, per-chat wallpapers. A custom wallpaper picture is stored inside it as a JPEG data URL (up to 1600 px edge), so it can be large; if the quota is full the choice stays for the session and `onStorageError` fires. |
| Other `localStorage` / `sessionStorage` keys | none in the package | grep of `web/src` | The package writes nothing else. (`examples/web-app` uses `sessionStorage` key `commskit.demo.session`.) |
| Storage failures | handled | `safeLocalStorage()` in `web/src/util.ts` | Private mode / blocked storage: the accessor never throws; preferences just last for the page session. |
| `Notification` API | permission `default` / `granted` / `denied` | `web/src/notifications.tsx` | Asked only when you call `requestPermission()` from a click (the `ChatApp` bell button does). Needs HTTPS or `localhost`. |
| Sound | `soundUrl` option of `useWebNotifications` | same | **No sound file ships with the package.** You host an audio file and pass its URL. Browser autoplay rules may block it (errors are swallowed). |
| Notification icon | `icon` option | same | Your logo URL. |
| `navigator.share`, `visualViewport`, `matchMedia`, `ResizeObserver`, canvas | optional | various | Feature-detected. |

### B3. CORS

| Setup | What you need |
|---|---|
| Page and API on the **same origin** (reverse proxy forwards `/chats`, `/moderation`, `/media`, `/ws`) | Nothing. No CORS. This is the simplest and what `examples/web-app` does through its Vite proxy. |
| Page and API on **different origins** | The API must send CORS headers for the page's origin. In the demo server: `COMMS_CORS_ORIGINS="https://app.example.com"` (comma-separated; unset = no CORS middleware), which adds Starlette `CORSMiddleware(allow_origins=..., allow_methods=["*"], allow_headers=["*"])` (`examples/backend/demo-server-python/demo_server.py`, lines 115 to 121). In your own FastAPI app add the same middleware yourself; the kit's `hub.rest_router()` does not add CORS. |

Details that matter:
- REST calls from the package send `Authorization: Bearer <token>` and, for POST bodies, `Content-Type: application/json`. Those trigger a **preflight** `OPTIONS` request, so the API must answer it with `Access-Control-Allow-Headers` including `Authorization, Content-Type` and `Allow-Methods` including `GET, POST, DELETE`. The demo's `"*"` settings do this.
- The package does not send cookies (`fetch` default `credentials`), so you do **not** need `allow_credentials`.
- Keep `allow_origins` to an explicit list in production. Do not use `*` together with credentials.
- Media: `<img>`, `<video>`, `<audio>` and iframes do not need CORS. The Download button does `fetch(url)` to save a blob; if the media host has no CORS, it falls back to `window.open(url)` in a new tab (`downloadFile` in `web/src/util.ts`). So give your media host CORS for a smooth Download.
- WebSockets are not subject to CORS (see C).

### B4. Dev proxy and build-time variables

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `COMMS_SERVER` | `examples/web-app/vite.config.ts` (Node env when Vite starts) | `http://localhost:8000` | Where the dev / preview server forwards `/dev /chats /moderation /devices /media /call` and `/ws` (websocket upgrade enabled). |
| `PORT` | same | dev `5173`, preview `4173` | Port of the Vite dev / preview server. |
| `VITE_DEFAULT_SERVER` | `examples/web-app/src/Login.tsx` (`import.meta.env`, inlined at build) | `http://localhost:8000` | Default text of the demo's "Server URL" field. |
| `COMMS_CORS_ORIGINS` | `examples/backend/demo-server-python/demo_server.py` | unset (off) | Allowed origins for CORS on the demo server. |
| `COMMS_FEATURES` | demo server | `chat,call` | Which kit features the demo runs. |
| `COMMS_DEMO_DATA` | demo server | `examples/backend/demo-server-python/.demo_data` | SQLite file and uploaded media folder. |
| `COMMS_DEMO_SECRET` | demo server | `local-demo-secret-change-me-0000` | JWT secret of the demo. Dev only. |
| `CHROME_PATH` | `examples/web-app/e2e/run.mjs` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Browser for the e2e run. |

The **package itself reads no environment variables**: there is no `import.meta.env` or `process.env` in `web/src` (verified by grep). Your own site decides how to feed `baseUrl`:
for Vite use `import.meta.env.VITE_API_URL`, for Next.js `process.env.NEXT_PUBLIC_API_URL`, for CRA `process.env.REACT_APP_API_URL`. These are inlined at build time, so a new API URL needs a rebuild.
Only put public values behind those prefixes.

### B5. Web push: there is NO VAPID key in this package

Today:
- `commskit-web` has no service worker, no `PushManager` code and no VAPID configuration. Grep for `VAPID`, `serviceWorker`, `PushManager` in `web/src` and `examples/web-app/src`: nothing.
- The backend has senders for Expo and APNs VoIP only (`backend/backend-python/commskit/core/push.py`). Its device registry accepts `platform: "web"` (`PLATFORMS = ("ios","android","web")` in `devices.py`), but a device with `platform="web"` would be routed to the Expo sender (which cannot reach a browser).
- So with the tab **closed**, a web user gets nothing. With the tab open (visible or hidden) they get in-app banners / desktop notifications from the open socket.

What you would have to add for closed-tab push **(design sketch, not in the kit, untested)**:

| Piece | Where | Detail |
|---|---|---|
| VAPID key pair | generate once | The **public** key goes into the web app (public config); the **private** key stays on the backend as a secret. |
| Service worker file | your site, served from your origin root | Handles the `push` event (`showNotification`) and `notificationclick` (focus the tab / open the chat). |
| Subscription | web app | `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key> })`, after a user click grants permission. |
| Storing the subscription | backend | A new endpoint or a new device field for the subscription JSON (endpoint, keys). `POST /devices` has no field for it today. |
| Sender | backend | A Web Push sender (new code, for example the `pywebpush` library) hooked into `DevicePushRouter` / the `PushSender` interface; handle expired subscriptions (HTTP 404 / 410). |
| HTTPS | hosting | Service workers and Push need a secure context. |

---

## C. The WebSocket

### C1. URL and handshake

- URL: `${ws|wss}://host/ws/${token}`. Built by `socketUrl()`: `wsUrl` if given, else derived from `baseUrl`, then `/ws/` + `encodeURIComponent(token)`.
- The server (`backend/backend-python/commskit/core/websocket.py`) **accepts first, then validates the token**. An invalid token gets a close with code **1008** ("Invalid token"). The default `JwtAuth` expects HS256 and a `uid` claim (`claim="uid"` in `adapters.py`); your host can plug another `AuthAdapter`.
- One socket per tab. A user may have several sockets (several tabs / devices); the server sends events to all of them.

### C2. Mixed content

An `https://` page may only open `wss://` sockets (and fetch `https://` APIs). A `ws://` socket from an https page is blocked by the browser ("Mixed Content"). Since `wsUrl` is derived from `baseUrl`, using `https://` in `baseUrl` gives `wss://`. Plain `http://` + `ws://` is fine on `localhost` for development.

### C3. Reverse-proxy requirements

| Requirement | Why |
|---|---|
| Forward the `Upgrade` and `Connection: upgrade` headers on `/ws/` (HTTP/1.1) | Without them the socket fails with a 400/404 or never connects (see troubleshooting in [03](03-using-running-and-deploying.md#troubleshooting)). |
| Long read timeout on `/ws/` (nginx: `proxy_read_timeout 3600s` or more) | nginx closes idle proxied connections after 60 s by default. The client sends **no** ping by default (`pingIntervalMs = 0`), and the server only heartbeats when a Redis bridge is configured (`websocket.py` `_beat`). A quiet chat could be dropped every minute. Either raise the timeout or set `pingIntervalMs` (for example `25000`) on `CommsWebProvider`. The client then reconnects automatically anyway. |
| Allow large frames | Files are sent over the socket as base64 inside one JSON frame (`media_upload` with `file_data`). A 10 MiB file is about 14 MB of text. uvicorn's default `ws_max_size` is 16 MiB (`uvicorn/config.py`), which is enough; do not lower it, and make sure the proxy does not cap WebSocket messages below ~15 MB. |
| With more than one backend worker, configure the Redis bridge | `backend/backend-python/commskit/core/connections.py`: connections, presence and fan-out are in-memory (single worker) unless a `PresenceBridge` such as `RedisBridge` is passed. Without it, users whose sockets sit on different workers will not receive each other's events. |
| Nothing IP-specific | Rate limits are per user (`docs/archive/PROTOCOL.md` section 9), not per IP. |

### C4. Reconnect, visibility, online / offline

Implemented in `mobile/src/core/CommsClient.ts` (shared) and `web/src/providers.tsx`.

| Event | Behaviour |
|---|---|
| Socket closes (any code, including 1008) | Status becomes `reconnecting`; retry after `min(1000 * 2^attempt, 30000)` ms (1 s, 2 s, 4 s ... 30 s). The close code is available as `useConnectionStatus().lastCloseCode`. The client does **not** stop retrying on 1008; it calls `getToken()` again each time, so a refreshed token heals it. |
| `getToken()` returns nothing | Status `unauthenticated`, no socket, chat state is reset. The provider will not retry by itself; call `useComms().client.reconnect()` after login, or mount the provider only after login. |
| Tab hidden | Sends `user_status: "away"`. No reconnect attempts are scheduled while hidden (the client waits for the tab to become visible). |
| Tab visible again | If the socket died, reconnects immediately (attempt counter reset); otherwise sends `user_status: "online"`. |
| Browser `online` event | If not open and not idle / unauthenticated: `client.reconnect()` at once instead of waiting for the backoff timer. |
| User clicks Retry in the banner | `client.reconnect()`. |
| Unmount | `client.disconnect()`; no reconnect. |
| Socket (re)opened | The store requests the conversation list again (`req_users`) and re-fetches every conversation that is on screen (`ChatStore.onConnected`). |

The `ConnectionBanner` shows "Connecting..." and "Offline. Retrying in Ns" with a Retry button.

### C5. Frames

Summary (full tables in [`docs/archive/PROTOCOL.md`](../archive/PROTOCOL.md) sections 1 to 3, 7 and 9). Frames are JSON objects with a string `type`.

| Direction | Types the web package sends | Types it handles (`CHAT_EVENT_TYPES` in `mobile/src/chat/ChatStore.ts`) |
|---|---|---|
| Chat | `req_users`, `get_messages`, `send_message`, `media_upload`, `mark_read`, `typing`, `delete_message`, `clear_chat` | `res_users`, `req_users_error`, `res_messages`, `new_message`, `message_sent`, `media_upload_success`, `chat_read`, `messages_read`, `delivery_status`, `typing_status`, `message_deleted`, `chat_cleared`, `error` |
| Presence | `user_status` (online / away), `ping` (only if `pingIntervalMs > 0`) | `user_status`, `PONG` (upper case, mapped to `pong`) |
| Moderation | (block / report go over REST, below) | `user_blocked`, `user_unblocked`, `blocked_by_user`, `unblocked_by_user` |
| Calls | none | `call_log` entries are shown as chips; the `call_*` events are subscribed by the shared store but the web package has no call UI |

Unknown frame types are ignored; non-JSON frames are ignored. A server `error` frame becomes a toast.

### C6. REST calls the web package makes

All use `fetch` with `Authorization: Bearer <token>` (`authFetch` in `mobile/src/core/config.ts`).

| Call | When | Source |
|---|---|---|
| `POST /chats/start?candidate_id=<id>` | Only when **you** call `useChatApi().startChat(id)` | `mobile/src/chat/api.ts` |
| `POST /moderation/blocks` `{user_id}` | Block | `ModerationStore` |
| `DELETE /moderation/blocks/<id>` | Unblock | `ModerationStore` |
| `POST /moderation/reports` | Report (user or message) | `ModerationStore` |
| `GET /moderation/blocks` | `ModerationProvider loadOnMount` (default **off**) or the Blocked users screen | `ModerationStore` |
| `POST /chats/expo/push/token`, `.../remove` | Only if you call `useChatApi().registerPushToken` / `removePushToken` (Expo tokens; not useful for browsers) | `mobile/src/chat/api.ts` |
| `GET <file_url>` | Images, video, audio, documents, Download (`fetch`) | browser |

Everything else (conversations, history, sending, uploads, read receipts, delete, clear) goes over the WebSocket, not REST. The package does **not** call `/devices`, `/chats/send`, `/call/*` or the admin report endpoints.

### C7. Origin checking

WebSockets are not subject to CORS: any page can attempt `new WebSocket("wss://your-api/ws/<token>")`. Whether the server rejects foreign origins is up to the server.
**What the kit does:** `backend/backend-python/commskit/core/websocket.py` does **not** read or check the `Origin` header (grep for "origin" in that file: nothing). Authentication is only the token in the path.
Because auth does not use cookies, a hostile site cannot ride on the visitor's session; it would need a valid token. If you want defence in depth, check `Origin` in your reverse proxy
(for example nginx `if ($http_origin !~ ...) { return 403; }` on `/ws/`) or in a small ASGI middleware. This is a recommendation, not a kit feature.

---

## D. Placeholders

Things in the web package and the example app that are stand-ins for your real application.

### D1. In the example app (`examples/web-app`)

| Placeholder | File | Default behaviour | Why a placeholder | What a real app does |
|---|---|---|---|---|
| Server `http://localhost:8000` | `src/Login.tsx` (`DEFAULT_SERVER`, env `VITE_DEFAULT_SERVER`) | Pre-filled in the "Server URL" field | Dev machine address | Your API URL from build config |
| "Use the dev proxy" checkbox (default on) | `src/Login.tsx`, `vite.config.ts` | `baseUrl = window.location.origin`; Vite forwards to `COMMS_SERVER` | Avoids CORS in dev | Production same-origin reverse proxy, or CORS on the API |
| `GET /dev/users` | `src/Login.tsx` | Lists the three demo users (Alice U1, Bob U2, Carol U3) | Demo server endpoint, not part of the kit | Your own user directory / "who can I chat with" |
| `GET /dev/token/{id}` | `src/Login.tsx` | Returns a JWT for **anyone** | Hands out tokens to anybody. **Never deploy.** | Your login issues the token (HS256, claim `uid`, same secret the chat backend verifies, or your own `AuthAdapter`) |
| `commskit.demo.session` in `sessionStorage` | `src/App.tsx` | Keeps `{baseUrl, token, userId, userName, people}` per tab | Demo convenience | Your auth state |
| `?user=U1&open=U2` URL params | `Login.tsx`, `App.tsx` | Auto sign-in and open a chat (used by e2e) | Test shortcut | Remove, or deep-link by your own routing |
| "New chat" picker listing `session.people` | `src/App.tsx` (`Shell`) | Lists everyone from `/dev/users`; clicking calls `useChatApi().startChat(id)`, `chat.refresh()`, then selects the peer | The kit does not know who may talk to whom | Your own search / match / profile page, then `startChat` |
| `list.headerActions` (New chat, Sign out buttons) | `src/App.tsx` | Extra buttons in the list header | Host UI slot | Your own actions |
| Vite proxy paths `/dev /chats /moderation /devices /media /call` + `/ws` | `vite.config.ts` | Forwarded to `COMMS_SERVER` | Dev / preview only; **not used by a static production host** | Same paths in nginx / your gateway |
| `app-shell` height `100dvh` | `src/app.css` | Gives the kit a height | The kit fills its parent | Your layout |

### D2. Slots inside `commskit-web` (host supplies the behaviour)

| Slot | File | Default behaviour | Why a slot | What a real app puts there |
|---|---|---|---|---|
| `onCall(peerId)` on `ChatScreen` (and `ChatApp chat={{onCall}}`) | `ChatScreen.tsx`, `messages.tsx` | Absent: no call button, no "Call back" | The package has no calling | Start your own call (your WebRTC, or open a call page); the call button shows only when the peer can be called (`presence.canCall`) |
| `gate(info)` | `ChatScreen.tsx` | Absent: chat opens normally | Product rules differ (consent, paywall, verification) | Return a node (for example "Accept chat request") while a rule is unmet; it covers messages + composer. `info` has `peerId, name, conversation, messages, loaded, isBlocked, blockedByOther` |
| `disabledReason` | `ChatScreen.tsx` | `null`: composer enabled | Server policy may forbid sending | A string such as "Chat is not enabled for this profile" |
| `documentViewerUrl(message, fileUrl)` | `ChatScreen.tsx` | Absent: viewer offers Download | Previewing needs a viewer service | A URL of your own viewer, or a third-party viewer. Sending file URLs to a third party shares their content: check your privacy rules **(your decision)** |
| `mediaBaseUrl` | `ChatScreen.tsx` | `config.baseUrl` | Media may be on another host / CDN | Your media or CDN base for relative `file_url`s |
| `messageActions` | `ChatScreen.tsx` | Built-in actions only | Product-specific actions | `[{key, label, onPress(message), destructive?}]` or a function of the message |
| `menuItems` | `ChatScreen.tsx` | Wallpaper / Report / Block / Clear chat | Product-specific header menu entries | `[{label, onSelect, destructive?}]` |
| `renderActions` | `ChatScreen.tsx` | none | Extra header buttons | Your buttons |
| `list.filters` | `ConversationListScreen.tsx` | All / Unread chips | Product-specific segments | `{key, label, predicate, showCount?, emptyTitle?, emptyText?}` |
| `list.onOpenAppearance`, `blockedUsers`, `headerActions`, `title`, `clock` | `ConversationListScreen.tsx` | Built-in appearance sheet, no Blocked users button, title "Chats" | Layout / product choices | As needed |
| `placeholder` (`ChatApp`) | `ChatApp.tsx` | "Select a chat" illustration | Branding | Your empty state |
| Starting a chat | `useChatApi().startChat(userId)` then select that peer | The package never starts a chat for you; a person with no conversation does not appear in the list | Who may chat with whom is your business rule | Call it from a profile page / "Message" button, then `chat.refresh()` and select the peer (see the example) |
| `soundUrl`, `icon` (`useWebNotifications`, `ChatApp notifications={{...}}`) | `notifications.tsx` | No sound, no icon | The package ships no assets | URLs of your audio and logo, same origin or CORS-safe |
| `unsendWindowSeconds`, `maxUploadBytes` | `ChatScreen.tsx` | 3600 s, 10 MiB | Must mirror server config | Your server's real values |
| `AppearanceProvider` `theme`, `storage`, `storageKey`, `value` / `onChange` | `appearance.tsx` | Kit tokens, `localStorage` | Branding and persistence policy | Your brand colours (see the [design overview](../design/design-overview.md)), or your own storage / per-account sync |
| `logger` | `config` | silent | Diagnostics | Your logger |
| Moderation `on_report` | server side (`demo_server.py` prints reports) | prints to the console | Notifying moderators is yours | Email / ticket in your backend |

### D3. Placeholders on the backend that the web depends on

| Placeholder | File | Meaning |
|---|---|---|
| `SECRET = "local-demo-secret-change-me-0000"` | `examples/backend/demo-server-python/demo_server.py` | Demo JWT secret. Replace with a real secret from your secret store. |
| `StaticUserDirectory(USERS)` (Alice / Bob / Carol) | same | Names and avatars. Real app: a `UserDirectory` adapter backed by your user table. |
| `LocalDiskStorage(root=.demo_data/media, base_url="/media")` | same | Uploaded files on local disk, served at `/media`. Real app: S3 / object storage with absolute URLs. |
| SQLite `demo.db` | same | Real app: PostgreSQL. |
| Generous rate limits | same | The demo raises limits for UI tests. Use the kit defaults or your own. |
