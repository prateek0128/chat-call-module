# commskit-web: using, running and deploying

How to get `commskit-web` into an existing site, run it locally from a clean machine, and put it into production.

Series: [01 Overview](01-overview.md) | [02 Keys, secrets, WebSockets, placeholders](02-keys-secrets-websockets-and-placeholders.md) | **03 Using, running, deploying (this file)** | [Web example](../example/web-example.md) | [Design](../design/design-overview.md)

Commands are given for PowerShell (Windows) and bash where they differ. Config snippets for Vercel, Netlify and nginx are **untested** (written from the package's needs, not run).
**(unverified)** marks statements I could not confirm from code or by running them.

## Table of contents
1. [Prerequisites](#1-prerequisites)
2. [Getting the package into your site](#2-getting-the-package-into-your-site)
3. [Minimal code](#3-minimal-code)
4. [Running locally](#4-running-locally)
5. [Deploying](#5-deploying)
6. [Go-live checklist](#6-go-live-checklist)

---

## 1. Prerequisites

| Need | Detail |
|---|---|
| Node.js | `web/package.json` has no `engines` field. I ran everything on **Node v22.23.2**. Vite 6 and Vitest 2 (the example's and package's tooling) need a currently supported Node LTS (18 / 20 / 22+) **(from memory, unverified)**. |
| npm | Any recent npm (lockfiles `package-lock.json` exist in `web/` and `examples/web-app/`). |
| React | Your app must use `react` and `react-dom` **18 or newer** (peer dependencies `>=18`; the example uses 19). |
| A running backend | A FastAPI app with the kit installed (`/ws/{token}` + `/chats`, `/moderation`). For local trials use the demo server (section 4). |
| Python (for the demo server) | `backend/backend-python/pyproject.toml`: `requires-python >= 3.11`. |
| Google Chrome | Only for `npm run e2e` in `examples/web-app`. |

## 2. Getting the package into your site

`commskit-web` is built from the kit's `web/` folder. The build needs the sibling `mobile/src` folder (the shared engine is bundled in, see [01 section 5](01-overview.md#5-how-it-shares-the-engine-with-mobile)). So build from a **full checkout of the kit**.

```bash
cd web
npm install
npm run build        # creates dist/index.js, dist/index.d.ts, dist/styles.css
```

### Option A: local `file:` link (what the example app does)

In your app's `package.json`:

```json
"dependencies": {
  "commskit-web": "file:../comms-kit/web",
  "react": "^19.1.0",
  "react-dom": "^19.1.0"
}
```

Then `npm install`. npm links the folder; rebuild `web/` after changes. If your bundler ends up with two copies of React (symptom: "Invalid hook call"), dedupe it.
Vite: `resolve: { dedupe: ["react", "react-dom"] }` (the example's `vite.config.ts` does this).

### Option B: tarball (`npm pack`), good for CI and other repos

```powershell
cd web
npm run build
npm pack                      # creates commskit-web-0.1.0.tgz (only dist + README.md are packed: "files" in package.json)
```

```bash
cd your-app
npm install ../comms-kit/web/commskit-web-0.1.0.tgz
```

The tarball is self-contained (engine bundled), so the consuming repo does not need `mobile/`. I did not run `npm pack` for this document; the packing list follows `files: ["dist","README.md"]`.

### Option C: npm registry

1. Decide the name. `commskit-web` is unscoped; whether the name is free on npmjs.com is **unverified**. A scoped name such as `@your-org/commskit-web` avoids clashes: change `"name"` in `web/package.json`.
2. The `license` field is `UNLICENSED`. That is allowed for private registries; set a real license (or `"private"` use) before publishing publicly.
3. Build and publish: `cd web; npm run build; npm publish --access restricted` (scoped, private) or `--access public`. For a private registry add `--registry <url>`.
4. In apps: `npm install @your-org/commskit-web`.

`npm run verify` (typecheck + tests + build) is a good pre-publish gate.

### Import the CSS

```ts
import "commskit-web/styles.css";
```

Import it once, at your app entry. The `exports` map in `package.json` exposes it. Your own CSS can come after it to override.

### CSS variable theming

`AppearanceProvider` renders a `div.ck-root` that carries every design token as a CSS variable (`--ck-accent`, `--ck-bubble-out`, `--ck-radius-bubble`, ...), set from JavaScript at runtime. Three ways to restyle:

| How | Example |
|---|---|
| Provider override (recommended; survives dark mode and the user's theme choice) | `<AppearanceProvider theme={{ schemes: { light: { accent: "#0A7" }, dark: { accent: "#3DB" } } }}>` |
| Your own CSS on `.ck-root` | `.ck-root { --ck-radius-bubble: 12px; }` (note: the provider sets these as inline styles on the element, so inline wins over a stylesheet rule; use the provider `theme` for colours/sizes) |
| Rules on `ck-` classes | `.ck-bubble { ... }` in a stylesheet loaded **after** `styles.css` |

The user's chosen preset (Indigo, Rose, ...) is applied on top of your `theme`. Full token list and rebranding steps: [design overview](../design/design-overview.md).
The component must sit inside a parent with a **height** (for example `100dvh`): `ChatApp` fills its parent.

### Bundlers, SSR and frameworks

| Setup | Notes |
|---|---|
| Vite / webpack 5 / esbuild / Parcel | Import the package normally. ESM only. |
| Next.js (App Router) | The package ships **no** `'use client'` directive. Import it only from a file that starts with `'use client'`. Because chat needs a browser WebSocket, load it client-side; for pages router use `next/dynamic(() => import("./Chat"), { ssr: false })`. |
| Server rendering | I ran `react-dom/server` `renderToString` on `AppearanceProvider` + `CommsStack` + `ChatApp` from `web/dist` in plain Node: it rendered without errors (the code guards `window`, `document`, `matchMedia`, `localStorage`; the socket opens only in an effect). Hydration in a real Next.js app was **not tested**. `ssr: false` / client-only is still the safe choice. |
| Storage unavailable (private mode, blocked cookies) | `localStorage` access never throws; appearance just lasts for the session (`safeLocalStorage` in `web/src/util.ts`). |
| TypeScript | Types ship in `dist/index.d.ts`. The package needs `"moduleResolution": "Bundler"` or `"NodeNext"` to resolve the `exports` map **(standard behaviour, not specifically tested)**. |

---

## 3. Minimal code

All names below exist in `web/src/index.ts`.

### 3.1 Full responsive app: `ChatApp`

```tsx
import { AppearanceProvider, ChatApp, CommsStack, type CommsConfig } from "commskit-web";
import "commskit-web/styles.css";

const config: CommsConfig = {
  baseUrl: "https://api.example.com",   // REST; the socket URL is derived: wss://api.example.com/ws/<token>
  getToken: () => auth.chatToken,        // your login; called on every connect and REST call
  getUserId: () => auth.userId,
};

export default function Chat() {
  return (
    <AppearanceProvider>
      <CommsStack config={config}>
        <div style={{ height: "100dvh" }}>
          <ChatApp />                    {/* below 700 px: one pane + back; 700 px and up: list + chat */}
        </div>
      </CommsStack>
    </AppearanceProvider>
  );
}
```

Keep `config` stable (a module constant or `useMemo`) or let it change identity: the provider reads the latest callbacks through a ref, so both work.

`CommsStack` = `CommsWebProvider` -> `ModerationProvider` -> `ChatProvider`. Props: `config`, `moderation` (default `true`), `onError`, `comms` (extra `CommsWebProvider` props), `chat` (extra `ChatProvider` props).

### 3.2 Custom layout: list + chat screens with your own routing

```tsx
import { ConversationListScreen, ChatScreen } from "commskit-web";

function Messages({ peerId, navigate }: { peerId: string | null; navigate: (path: string) => void }) {
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <ConversationListScreen selectedPeerId={peerId} onSelect={(id) => navigate(`/chat/${id}`)} />
      {peerId ? <ChatScreen peerId={peerId} onBack={() => navigate("/")} /> : null}
    </div>
  );
}
```

Both must be inside `AppearanceProvider` and `CommsStack`. `onBack` shows the back button (use it only in a single-pane layout).

### 3.3 The providers by hand (when you need to control them)

```tsx
<AppearanceProvider>
  <CommsWebProvider config={config} autoConnect={false} pingIntervalMs={25000}>
    <ModerationProvider>
      <ChatProvider onError={(e) => toast(e.message)}>
        {children}
      </ChatProvider>
    </ModerationProvider>
  </CommsWebProvider>
</AppearanceProvider>
```

With `autoConnect={false}` connect after login: `useComms().client.connect()` (or `.reconnect()` after a token change).

### 3.4 Plug in your login (`getToken` / `getUserId`)

Rules (verified in `mobile/src/core/CommsClient.ts` and `config.ts`):
- `getToken` returns the chat JWT, or `null` when logged out. `null` makes the client stop in status `unauthenticated` and clears chat state.
- The simplest, safest pattern is to **mount the chat only when the user is logged in**, and `key` it by user id so a user switch rebuilds everything:

```tsx
{user ? (
  <CommsStack key={user.id} config={{ baseUrl: API, getToken: () => user.chatToken, getUserId: () => user.id }}>
    <ChatApp />
  </CommsStack>
) : null}
```

- On logout, unmount the stack (the client disconnects).
- If the token expires, the server closes with code 1008; the client retries with backoff and calls `getToken()` again, so return a fresh token there (see [02 section A](02-keys-secrets-websockets-and-placeholders.md#a-the-rule-browser-code-is-public)).
- The token must be one the **backend** accepts: with the kit's `JwtAuth` that is HS256 with the user id in claim `uid`, signed by the backend's secret. The secret never goes to the browser. Your own backend should issue it (for example `GET /api/chat-token` behind your session).

### 3.5 Start a new chat

The package never creates conversations by itself. A person with no chat does not appear in the list until a chat exists. From your profile / "Message" button:

```tsx
import { useChat, useChatApi } from "commskit-web";

function MessageButton({ userId, onOpened }: { userId: string; onOpened: (id: string) => void }) {
  const api = useChatApi();
  const chat = useChat();
  return (
    <button
      onClick={async () => {
        await api.startChat(userId);   // POST /chats/start?candidate_id=<id>: get-or-create
        chat.refresh();                // re-request the conversation list
        onOpened(userId);              // select that peer in ChatApp (controlled) or navigate to its route
      }}
    >
      Message
    </button>
  );
}
```

Use it with `ChatApp selectedPeerId={id} onSelectedChange={setId}` (controlled selection). This is exactly what `examples/web-app/src/App.tsx` does.
Whether the two users are *allowed* to chat is decided by the backend `ChatPolicy`, not by the browser.

### 3.6 Appearance

`AppearanceProvider` props: `storage` (any `{getItem,setItem}`; `null` = no persistence), `storageKey` (default `commskit.appearance.v1`), `initial`, `value` + `onChange` (controlled, you own saving, for example per account on your server), `onStorageError`, `theme`, `className`, `style`. Read or set it anywhere with `useAppearance()` (`mode`, `preset`, `wallpaper`, `setMode`, `setPreset`, `setWallpaper`, `scheme`, ...).
Users open the Appearance sheet from the list header button, or from the chat menu ("Wallpaper").

### 3.7 Notifications

`ChatApp` already wires them: a bell button appears while the permission is undecided; clicking it asks the browser. Customise or turn off:

```tsx
<ChatApp notifications={{ soundUrl: "/sounds/ping.mp3", icon: "/logo-192.png" }} />
<ChatApp notifications={false} banners={false} />
```

Own UI: `const n = useWebNotifications({ onOpenChat: (peerId) => select(peerId), soundUrl })` then `<button onClick={() => n.requestPermission()}>`.
`requestPermission()` must run inside a click. A notification is shown only for a message in a chat that is **not open**, **while the tab is hidden**. Needs HTTPS (or localhost). No sound ships with the package.
Closed-tab push does not exist yet ([02 section B5](02-keys-secrets-websockets-and-placeholders.md#b5-web-push-there-is-no-vapid-key-in-this-package)).

### 3.8 Other useful props

```tsx
<ChatApp
  chat={{
    mediaBaseUrl: "https://cdn.example.com",   // relative file_url values load from here
    unsendWindowSeconds: 3600,                 // must equal the server's ChatConfig.unsend_window_seconds
    documentViewerUrl: (msg, url) => `https://viewer.example.com/?src=${encodeURIComponent(url)}`,
    onCall: (peerId) => startMyCall(peerId),  // your own calling; shows a call button
    disabledReason: user.canChat ? null : "Upgrade to chat",
  }}
  list={{ title: "Messages", blockedUsers: true }}
/>
```

### 3.9 Same-origin proxy or CORS: choose one

| | Same-origin reverse proxy | CORS |
|---|---|---|
| Browser sees | one origin (`https://app.example.com`) for page, REST, media and `/ws` | page on `https://app.example.com`, API on `https://api.example.com` |
| `baseUrl` | `window.location.origin` (the full origin is required: an empty string is rejected) | `https://api.example.com` |
| CORS needed | no | yes: `CORSMiddleware` with your page origin |
| Preflight requests | none | one `OPTIONS` per new REST call type (cached by the browser per `Access-Control-Max-Age`) |
| Cookies / CSP | simpler CSP (`'self'`) | CSP must list the API origin |
| Token in logs | proxy logs the `/ws/<token>` path: mask it | API logs it |
| Where it fits | you control a gateway / nginx | static hosting (Vercel, Netlify, S3) for the page |

#### nginx: same-origin proxy (untested)

```nginx
# /etc/nginx/conf.d/app.conf  (TLS certificates omitted; use certbot or your cloud load balancer)
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# Keep the token in /ws/<token> out of the logs: log the path without it.
map $request_uri $loggable_uri { ~^/ws/ "/ws/[token]"; default $request_uri; }
log_format chat '$remote_addr [$time_local] "$request_method $loggable_uri" $status $body_bytes_sent';

server {
  listen 443 ssl http2;
  server_name app.example.com;
  access_log /var/log/nginx/app.access.log chat;

  root /var/www/app;                       # the built site (dist/)
  location / { try_files $uri /index.html; }

  location ~ ^/(chats|moderation|devices|media)(/|$) {
    proxy_pass http://127.0.0.1:8000;      # the FastAPI backend
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20m;
  }

  location /ws/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;              # default 60 s would drop quiet sockets
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
```

Then `baseUrl: window.location.origin` (`https://app.example.com` gives `wss://app.example.com/ws/<token>`).

#### CORS on the API (FastAPI, your host app)

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],      # explicit list, no "*"
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)
```

The kit's demo server does the same through `COMMS_CORS_ORIGINS` (`examples/backend/demo-server-python/demo_server.py`).

---

## 4. Running locally

### 4.1 From a clean machine

Install Node (LTS), Python 3.11+, Git, and Chrome (only for e2e). Get the kit (`comms-kit/`). Then:

**Step 1. Backend with the demo server**

```powershell
# PowerShell, from comms-kit\backend\backend-python
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m pip install uvicorn websockets     # see note below
```

```bash
# bash (Linux / macOS), from comms-kit/backend/backend-python
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
.venv/bin/python -m pip install uvicorn websockets
```

Note: `backend/backend-python/pyproject.toml` does not list `uvicorn` or `websockets` (the README install lines do not either), but the demo needs a server and a WebSocket library. The existing `backend/backend-python/.venv` here has `uvicorn 0.54.0` and `websockets 17.3`. Whether `uvicorn[standard]` is the recommended spelling is **unverified**.

Start the demo server (chat only is enough for the web client). It lives in `examples/backend/demo-server-python` and uses the backend's venv:

```powershell
# PowerShell
cd comms-kit\examples\backend\demo-server-python
$env:COMMS_FEATURES = "chat"
..\..\..\backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app --reload --port 8000
```

```bash
# bash on Linux / macOS
cd comms-kit/examples/backend/demo-server-python
COMMS_FEATURES=chat ../../../backend/backend-python/.venv/bin/python -m uvicorn demo_server:app --reload --port 8000
# Git Bash on Windows: use ../../../backend/backend-python/.venv/Scripts/python instead
```

Check: open `http://localhost:8000/dev/users`; you should see JSON with Alice, Bob and Carol. (I verified the new folder layout and module name by reading `demo_server.py` and `examples/web-app/e2e/env.mjs`; I did not start the server in this session.)

**Step 2. Build the package** (new terminal)

```bash
cd comms-kit/web
npm install
npm run build
```

**Step 3. Run the example app**

```bash
cd comms-kit/examples/web-app
npm install
npm run dev        # http://localhost:5173
```

**Step 4. Two users.** Open `http://localhost:5173` in two browser profiles (or one normal and one private window). Keep "Use the dev proxy" ticked. Sign in as **Alice** in one and **Bob** in the other, click the pencil ("New chat"), pick the other person, and send messages.
Shortcuts: `http://localhost:5173/?user=U1&open=U2` signs in as Alice and opens the chat with Bob; `?user=U2&open=U1` the reverse.
Why two profiles: the session is kept in `sessionStorage` per tab, but appearance is in `localStorage` shared by all tabs of one browser profile. Two tabs in one profile also work for chatting.

Other machine's backend: `COMMS_SERVER=http://192.168.1.20:8000 npm run dev` (bash) / `$env:COMMS_SERVER="http://192.168.1.20:8000"; npm run dev` (PowerShell).

### 4.2 Tests

| What | Command | Needs |
|---|---|---|
| Package unit tests | `cd web; npx vitest run` (or `npm test`) | Node only. **88 tests in 6 files passed** when I ran it. |
| Types | `cd web; npx tsc --noEmit` | passed with no output |
| Everything before publishing | `cd web; npm run verify` | typecheck + tests + build |
| Example app type check + build | `cd examples/web-app; npm run build` | `web/dist` built first (`npm run build:web` does it) |
| Browser end-to-end (16 steps) | `cd examples/web-app; npm run build:web; npm run build; npm run e2e` | Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` or `CHROME_PATH`; `backend/backend-python/.venv` with python; free ports (picked automatically); `playwright-core` (installed by `npm install`, it drives your Chrome and downloads no browser) |

Detail of the e2e run is in the [web example doc](../example/web-example.md). I did not run `npm run e2e` while writing this.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser console: "blocked by CORS policy" on `/chats/...`, or a failed `OPTIONS` | Page and API on different origins without CORS | Same-origin proxy, or add `CORSMiddleware` for the page origin; demo: `COMMS_CORS_ORIGINS=http://localhost:5173`. Allow headers `Authorization, Content-Type` and methods `GET, POST, DELETE`. |
| Banner stays on "Connecting..." / "Offline. Retrying in Ns", console shows WebSocket 400 / 404 / failed to connect | Proxy does not forward the upgrade (no `Upgrade`/`Connection` headers) or `/ws` is not proxied | nginx block above; Vite: `"/ws": { target, ws: true }` (already in the example). Check `ws://` URL in devtools Network > WS. |
| Socket connects then closes after about 60 s | Proxy idle timeout (nginx default 60 s), no pings | `proxy_read_timeout 3600s` and/or `pingIntervalMs={25000}` on `CommsWebProvider`. |
| "Mixed Content: ... insecure WebSocket" | HTTPS page with `ws://` (for example `wsUrl` or `baseUrl` set to `http://`) | Use `https://` in `baseUrl` (derives `wss://`) or `wss://` in `wsUrl`. |
| Close code **1008** ("Invalid token") in `useConnectionStatus().lastCloseCode`; client keeps retrying | Token expired, wrong secret / algorithm / claim (`uid`), or token for another backend | Return a fresh token from `getToken()`; check the backend `JwtAuth` settings. |
| Status `unauthenticated`, nothing connects | `getToken()` returned null / undefined at connect time | Mount the stack after login, or call `useComms().client.reconnect()` once a token exists. |
| Blank page or a thin strip | The parent has no height (`ChatApp` fills 100% of its parent) | Give the parent `height: 100dvh` (see `examples/web-app/src/app.css`). |
| Unstyled / ugly | `commskit-web/styles.css` not imported, or `AppearanceProvider` missing | Import the CSS once; wrap screens in `AppearanceProvider`. |
| "Invalid hook call" / `useComms() must be used inside <CommsWebProvider>` | Two copies of React (linked package), or components outside the providers | `resolve.dedupe: ["react","react-dom"]`; check provider nesting. |
| Old behaviour after changing the package | Stale build: the app uses `web/dist` | `cd web; npm run build`, then restart the dev server (`npm install` again for tarballs). Vite may cache: delete `node_modules/.vite`. |
| Images show but Download opens a new tab | Media host has no CORS (download uses `fetch`) | Add CORS on the media host / use the proxy. |
| Images / files 404 | Relative `/media/...` resolved against the wrong host | Set `mediaBaseUrl`, or proxy `/media` on the page origin. |
| Upload fails for a big file or the socket drops while uploading | A proxy limits WebSocket message size below about 14 MB (10 MiB base64) | Raise it; uvicorn's default `ws_max_size` is 16 MiB. |
| Bell button missing / no desktop notifications | Permission `denied`, not HTTPS / localhost, browser has no `Notification` (some iOS Safari versions), or the tab is visible (banners are used then) | Reset the site permission in the browser; test by switching to another tab. |
| Appearance resets on reload; sheet says choices are kept for this session | `localStorage` blocked (private mode) or quota full | Expected; pass `storage` of your own, or `onStorageError` to inform the user. |
| Port 5173 / 8000 busy | Another process | `PORT=5174 npm run dev` / `--port 8001`; set `COMMS_SERVER` accordingly. |

---

## 5. Deploying

### 5.1 The split: static web, long-running backend

| Part | What it is | Where it can run |
|---|---|---|
| **Web** (`commskit-web` inside your site) | Static HTML / JS / CSS after the build | Any static host or CDN: Vercel, Netlify, Cloudflare Pages, S3 + CloudFront, GitHub Pages, nginx |
| **Backend** (FastAPI + kit) | Holds **open WebSockets** for every connected user, in-memory presence, timers, a database | A long-running server process: a VM, a container service (Fly.io, Render, Railway, ECS, Cloud Run with long timeouts **(check the platform limits)**), Kubernetes, behind a load balancer that supports WebSockets |

**Do not run the backend as Vercel (or Netlify, or Lambda) serverless functions.** Those are short-lived, cannot hold the `/ws/{token}` connection for hours, and have no shared memory between requests. The static site can live on Vercel while the API lives elsewhere.

```
Browser ──https──> static host (Vercel / Netlify / S3+CDN)        (HTML, JS, CSS)
Browser ──https──> api.example.com  (REST, media)  ┐
Browser ──wss────> api.example.com  (/ws/<token>)  ┴─> load balancer / nginx ─> FastAPI (uvicorn) ─> PostgreSQL, S3, (Redis if >1 worker)
```

Backend production items (database, S3, Redis, TLS, rate limits) are covered in [../backend/backend-python/03-using-running-and-deploying.md](../backend/backend-python/03-using-running-and-deploying.md). Key points for the web side:
- Replace the demo server (it hands out tokens to anyone and uses SQLite and local disk).
- More than one worker or instance: configure `RedisBridge` (single-worker presence is in-memory).
- Media: use absolute URLs (S3 / CDN) so the page need not proxy `/media`.

### 5.2 Set the API URL at build time

Your build tool inlines public variables:

| Tool | Variable | Use |
|---|---|---|
| Vite | `VITE_API_URL` | `baseUrl: import.meta.env.VITE_API_URL` |
| Next.js | `NEXT_PUBLIC_API_URL` | `baseUrl: process.env.NEXT_PUBLIC_API_URL!` |
| CRA | `REACT_APP_API_URL` | `baseUrl: process.env.REACT_APP_API_URL!` |

Set it per environment in the host's dashboard (staging vs production). It is public, so never put secrets in these variables. Changing it needs a rebuild. (`commskit-web` itself reads no env vars.)
Alternative without rebuilds: load a small `/config.json` at start-up and render the chat after it arrives.

### 5.3 Static host settings (all untested)

Single-page-app fallback, long caching for hashed assets, no caching for `index.html`.

**Vercel (`vercel.json`)**

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    { "source": "/assets/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
    { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
    { "source": "/(.*)", "headers": [
      { "key": "Content-Security-Policy", "value": "default-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com; img-src 'self' data: blob: https://cdn.example.com; media-src 'self' blob: https://cdn.example.com; frame-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; object-src 'none'" }
    ] }
  ]
}
```

(`/assets/` is Vite's output folder; adjust for your tool.) Do not use a Vercel rewrite to proxy `/ws`: do **not rely on** Vercel rewrites for WebSockets **(unverified; point `wsUrl`/`baseUrl` straight at your API host instead)**.

**Netlify (`netlify.toml`)**

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com; img-src 'self' data: blob: https://cdn.example.com; media-src 'self' blob: https://cdn.example.com; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'"
```

Cloudflare Pages / S3 + CloudFront: same ideas (`_headers` file; CloudFront response-headers policy; error page 404 -> `/index.html` for SPA routes).

**nginx (static + proxy):** the block in section 3.9 also serves a static `root` with `try_files`; add `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }`.

### 5.4 Content Security Policy: what the web chat needs

| Directive | Why | Value to include |
|---|---|---|
| `connect-src` | REST `fetch`, the WebSocket, and the Download `fetch` | your API origin, **and its `wss://` form** (`'self'` does not always cover `wss:` on the same host in older browsers: list `wss://host` explicitly), plus the media origin |
| `img-src` | images from the media host / CDN, `data:` (wallpaper picture), `blob:` (preview of a picked file) | `'self' data: blob: https://cdn.example.com` |
| `media-src` | `<video>`, `<audio>` | `'self' blob: https://cdn.example.com` |
| `frame-src` | only if you set `documentViewerUrl` (iframe) | the viewer origin |
| `style-src` | the provider sets CSS variables with inline `style` attributes | `'unsafe-inline'` (or a nonce-based approach **(unverified: inline style attributes need `'unsafe-inline'` in `style-src` or `style-src-attr`)**) |
| `script-src` | no inline scripts or `eval` are needed by the package | `'self'` |
| `worker-src` | not needed today (no service worker) | |

### 5.5 HTTPS and WSS

- Everything on HTTPS; the socket on `wss://` (an https page cannot open `ws://`).
- Terminate TLS at your load balancer / nginx and proxy to uvicorn over plain HTTP on a private network.
- Notifications and any future service worker need a secure context.
- HSTS is recommended (`Strict-Transport-Security`).

### 5.6 Local vs production: what do I need

| Concern | Local (example app) | Production |
|---|---|---|
| Backend | `demo_server.py` (SQLite, 3 fake users, local disk media) | Your FastAPI app with the kit, PostgreSQL, S3 / object storage, Redis if several workers |
| Tokens | `/dev/token/{id}` hands out JWTs to anyone | Your login issues short-lived JWTs; secret in a secret manager |
| Origins | one origin via the Vite proxy | same-origin proxy, or CORS allow-list |
| URL config | `Server URL` field / `COMMS_SERVER` | build-time `VITE_API_URL` (or similar) |
| Transport | `http` / `ws` on localhost | `https` / `wss` everywhere |
| Web hosting | `vite dev` / `vite preview` | static host / CDN with CSP + cache headers |
| Proxy timeouts | none | `proxy_read_timeout` high and / or `pingIntervalMs` |
| Media | `/media` served by the demo | absolute S3 / CDN URLs, CORS for Download |
| Notifications | works on `localhost` | HTTPS required; no closed-tab push (not implemented) |
| Moderation reports | printed to the console | `on_report` hook sends to your moderators |
| Monitoring | none | logs (token masked), uptime check on a REST endpoint, WebSocket connection count |

---

## 6. Go-live checklist

Tick each before launch.

**Security**
- [ ] No private key or secret in the web bundle or its env vars (`grep` your `dist/` for your JWT secret).
- [ ] The demo server and `/dev/*` endpoints are **not** deployed.
- [ ] Chat tokens are short-lived and issued by your login; `getToken()` returns a fresh one.
- [ ] CORS allow-list is explicit (or you use a same-origin proxy); no `*` with credentials.
- [ ] CSP set (section 5.4) and tested in the browser console (no violations when chatting, sending an image, downloading a file).
- [ ] Access logs do not keep the `/ws/<token>` path in clear text (or logs are protected).
- [ ] Optional: `Origin` check on `/ws/` at the proxy ([02 section C7](02-keys-secrets-websockets-and-placeholders.md#c7-origin-checking)).

**Network**
- [ ] Everything on HTTPS; the socket is `wss://`; no mixed-content warnings.
- [ ] Proxy forwards `Upgrade`/`Connection` on `/ws/`; read timeout is high (or `pingIntervalMs` set).
- [ ] WebSocket frame size allows a 10 MiB file (base64 about 14 MB).
- [ ] Backend runs as a long-lived process, with Redis bridge if there is more than one worker.

**Config**
- [ ] `baseUrl` (and `wsUrl` if different) set from build-time env per environment.
- [ ] `unsendWindowSeconds` and `maxUploadBytes` equal the server's `ChatConfig`.
- [ ] `mediaBaseUrl` correct (or media URLs are absolute).
- [ ] `commskit-web/styles.css` imported; parent element has a height.
- [ ] Brand colours set through `AppearanceProvider theme` (see the [design overview](../design/design-overview.md)).

**Behaviour (try in two real browsers)**
- [ ] Two users chat, ticks go to read, typing shows, images and files send and download.
- [ ] Stop the backend: the banner appears and recovers when it returns.
- [ ] Expire / replace a token: the client recovers or shows the login.
- [ ] Notification permission flow works on HTTPS in a hidden tab.
- [ ] Layout checked at 320, 390, 768 and 1280 px; keyboard-only use; reduced motion.
- [ ] Private-mode browser still works (appearance just not saved).

**Operations**
- [ ] Cache headers: `index.html` no-cache, hashed assets immutable.
- [ ] Rebuild and redeploy the site whenever you rebuild `commskit-web` (stale bundles).
- [ ] Moderation: `on_report` goes to a real reviewer; your privacy policy covers chat data.
- [ ] Know the limits: no closed-tab push, no calls in the web package.
