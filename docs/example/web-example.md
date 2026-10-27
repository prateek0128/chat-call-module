# Web example app (`examples/web-app`)

A small Vite + React + TypeScript app that uses `commskit-web` against the kit's demo server. It is the fastest way to see the web chat working
and the reference for how to wire it into your own site.

Series: [Web 01 Overview](../web/01-overview.md) | [Web 02 Keys, WebSockets, placeholders](../web/02-keys-secrets-websockets-and-placeholders.md) | [Web 03 Using, running, deploying](../web/03-using-running-and-deploying.md) | **Web example (this file)** | [Design](../design/design-overview.md)

Verified by reading every file in `examples/web-app` (except `package-lock.json`). **(unverified)** marks what I did not run: I did not run the e2e suite while writing this.

## Table of contents
1. [What it is, why, for whom](#1-what-it-is-why-for-whom)
2. [File map](#2-file-map)
3. [How login works](#3-how-login-works)
4. [How to run](#4-how-to-run)
5. [The end-to-end test (16 steps)](#5-the-end-to-end-test-16-steps)
6. [Limitations](#6-limitations)
7. [What to copy into your own site](#7-what-to-copy-into-your-own-site)

## 1. What it is, why, for whom

| | |
|---|---|
| What | A runnable chat client: a login screen for the three demo users, then the full `ChatApp` with a "New chat" picker and a Sign out button. |
| Why | Shows the minimal wiring (providers, config, starting a chat, styles), exercises every web-package feature in a real browser, and hosts the Playwright e2e test. |
| For | Web developers evaluating the kit, and the team's QA. It is **not** a starting template for production: its login is a dev shortcut. |
| Depends on | `commskit-web` (`file:../../web`, so build `web/` first), `react` / `react-dom` ^19.1, Vite ^6, `@vitejs/plugin-react`, `playwright-core` (dev). |
| Server | `examples/backend/demo-server-python/demo_server.py` (dev only: it hands out tokens to anyone). |

`package.json` scripts: `dev` (vite), `build` (`tsc --noEmit && vite build`), `preview` (vite preview), `typecheck`, `build:web` (`npm --prefix ../../web run build`), `e2e` (`node e2e/run.mjs`).

## 2. File map

| File | Lines | What it does | Web-package APIs it demonstrates |
|---|---|---|---|
| `index.html` | 13 | Page shell: `viewport-fit=cover` (safe-area insets), `color-scheme: light dark`, `<div id="root">`, loads `/src/main.tsx`. | |
| `vite.config.ts` | 19 | React plugin; `resolve.dedupe` for `react` / `react-dom` (the package is linked and imports React itself); **proxy** for dev (`server`) and `vite preview` (`preview`). Details below. | |
| `src/main.tsx` | 11 | Imports `commskit-web/styles.css` then `./app.css`, renders `<App />` in `StrictMode`. | `commskit-web/styles.css` |
| `src/App.tsx` | 117 | Session handling (`sessionStorage`), builds the `CommsConfig`, mounts providers, the **"New chat"** flow, header buttons. | `AppearanceProvider`, `CommsStack`, `ChatApp` (controlled `selectedPeerId` / `onSelectedChange`, `list.title`, `list.headerActions`), `useChatApi().startChat`, `useChat().refresh`, `Dialog`, `Avatar`, `Icon`, type `CommsConfig` |
| `src/Login.tsx` | 110 | Server URL field, "Use the dev proxy" checkbox, loads users, signs in. | none (plain `fetch` against the demo server) |
| `src/app.css` | 14 | Gives the kit a height (`.app-shell { height: 100dvh }`, `.app-shell > .ck-root { height: 100% }`), styles the login card using the kit's CSS variables (`--ck-surface`, `--ck-border`, ...). | CSS variables |
| `e2e/env.mjs` | 89 | Starts a demo server and `vite preview` on free ports (`startStack`). | |
| `e2e/run.mjs` | 494 | The 16-step Playwright-core test. | |
| `README.md` | 44 | Short run instructions. | |
| `e2e/.tmp/`, `e2e/screenshots/` | | Generated files (both git-ignored via `e2e/.gitignore`). | |
| `tsconfig.json`, `.gitignore` | | Strict TS, `vite/client` types; ignores `node_modules/`, `dist/`. | |

### `vite.config.ts` in detail

```ts
const server = process.env.COMMS_SERVER || "http://localhost:8000";
const paths = ["/dev", "/chats", "/moderation", "/devices", "/media", "/call"];
// each path -> { target: server, changeOrigin: true }; "/ws" -> { target: server, ws: true, changeOrigin: true }
server:  { port: Number(process.env.PORT) || 5173, proxy }
preview: { port: Number(process.env.PORT) || 4173, proxy }
```

- The browser talks to **one origin** (Vite's); Vite forwards the API paths and the WebSocket upgrade on `/ws` to the demo server. No CORS needed.
- The same proxy is used by `vite preview` (production build), which is what e2e uses.
- Environment variables read: `COMMS_SERVER` (target, default `http://localhost:8000`), `PORT`, and in `Login.tsx` `VITE_DEFAULT_SERVER`.
- A static production host has **no** such proxy: replace it with a real reverse proxy or CORS ([Web 03](../web/03-using-running-and-deploying.md#39-same-origin-proxy-or-cors-choose-one)).

### `App.tsx` flow

1. `loadSession()` reads `sessionStorage["commskit.demo.session"]` (`{baseUrl, token, userId, userName, people}`).
2. No session: `<Login>`. Session: `<Chat key={baseUrl|userId}>`, which builds
   `config = { baseUrl: session.baseUrl, getToken: () => session.token, getUserId: () => session.userId }` (memoised on the session) and renders `<CommsStack config>` around `<Shell>`. `wsUrl` is not set, so it is derived from `baseUrl`.
3. `Shell` renders `<ChatApp selectedPeerId={selected} onSelectedChange={setSelected} list={{ title: "Chats", headerActions: ... }} />`.
   `selected` starts from the URL parameter `?open=<id>`.
4. **New chat** (pencil button): opens a `Dialog` listing `session.people` (everyone except you). "Chat" calls `api.startChat(id)` (errors ignored; the chat screen shows its own), then `chat.refresh()`, then `setSelected(id)`.
5. **Sign out** removes the session and shows the login.

`<AppearanceProvider>` wraps everything with defaults (theme and wallpaper saved in `localStorage` key `commskit.appearance.v1`).

## 3. How login works

Against the demo server (`examples/backend/demo-server-python/demo_server.py`), in `Login.tsx`:

| Step | Request | Result |
|---|---|---|
| 1. Pick the base | "Use the dev proxy" on (default): `base = window.location.origin`. Off: `base = <Server URL>` (default `http://localhost:8000`, or `VITE_DEFAULT_SERVER`), trailing slashes trimmed. | |
| 2. Load users | `GET {base}/dev/users` | `{features, users: [{id, name}]}`: Alice `U1`, Bob `U2`, Carol `U3` |
| 3. Sign in | `GET {base}/dev/token/{id}` | `{token}`: an HS256 JWT with claim `uid`, signed with the demo secret |
| 4. Store | `onSignIn({baseUrl: base, token, userId, userName, people})` | saved in `sessionStorage`, chat mounts |

URL shortcuts: `?user=U1` signs in straight away; `?user=U1&open=U2` also opens the chat with Bob (used by e2e).
If the server is unreachable, the page shows an error that mentions the proxy / CORS (`COMMS_CORS_ORIGINS`).

**This is a dev shortcut.** `/dev/token/{id}` gives a token to anybody. A real site gets the token from its own authenticated backend ([Web 02 section A](../web/02-keys-secrets-websockets-and-placeholders.md#a-the-rule-browser-code-is-public)).
Also note the demo keeps the token in `sessionStorage`, readable by any script on the page.

## 4. How to run

Full clean-machine steps and troubleshooting: [Web 03 section 4](../web/03-using-running-and-deploying.md#4-running-locally). Short version:

```powershell
# PowerShell, terminal 1: demo server (chat only is enough)
cd comms-kit\examples\backend\demo-server-python
$env:COMMS_FEATURES = "chat"
..\..\..\backend\backend-python\.venv\Scripts\python -m uvicorn demo_server:app --port 8000
```

```bash
# bash, terminal 1
cd comms-kit/examples/backend/demo-server-python
COMMS_FEATURES=chat ../../../backend/backend-python/.venv/bin/python -m uvicorn demo_server:app --port 8000   # Git Bash on Windows: .venv/Scripts/python
```

```bash
# terminal 2 (both shells): build the package, then run the app
cd comms-kit/web && npm install && npm run build
cd ../examples/web-app && npm install && npm run dev       # http://localhost:5173
```

Open it in two browser profiles, sign in as Alice and Bob, use the pencil to start a chat.
Try: ticks that turn blue when read, typing, reply and quote jump, images (lightbox, download), files, delete for me / for everyone, clear chat, block / unblock, report, search and the Unread filter, appearance (palette button), desktop notifications (bell, then switch tabs), reconnect (stop the server).

Production-style preview: `npm run build` then `npm run preview` (port 4173, same proxy).

## 5. The end-to-end test (16 steps)

`examples/web-app/e2e/run.mjs`: a real Chrome, three browser contexts (Alice, Bob, Carol, viewport 1280x800), the real demo server and the built app.

### How it runs
```bash
cd examples/web-app
npm run build:web      # builds ../../web
npm run build          # tsc + vite build of this app (e2e refuses to start without dist/index.html)
npm run e2e
```
`e2e/env.mjs` (`startStack`): finds two free ports, makes a temporary data folder (`commskit-web-e2e-*` in the OS temp dir), starts the demo server with the backend venv's Python
(`python -m uvicorn demo_server:app` with `cwd` `examples/backend/demo-server-python`, env `COMMS_DEMO_DATA`, `COMMS_FEATURES=chat`, `COMMS_CORS_ORIGINS=<app url>`), then `vite preview` on the second port with `COMMS_SERVER` pointing at the server.
It waits for both to answer, runs the steps, then kills both processes (`taskkill` on Windows).

### Requirements
| Need | Detail |
|---|---|
| Chrome | `CHROME_PATH`, else `C:\Program Files\Google\Chrome\Application\chrome.exe` (launched headless, `--no-sandbox`) |
| Python venv | `backend/backend-python/.venv` (`Scripts/python.exe` on Windows, `bin/python` elsewhere); otherwise the run fails with "backend venv python not found" |
| Built app | `examples/web-app/dist` |
| Node | the same as for the app (I used v22) |
| Ports | free ones are chosen automatically |

### What each step checks

| # | Step title in the test | What it checks |
|---|---|---|
| 1 | login: demo users load, sign in as Alice, Bob and Carol | The login lists users; all three sign in (`?user=` for Bob and Carol); Alice sees "No chats yet". Screenshot `01`. |
| 2 | open chat via New chat; first message; Bob sees row, unread badge and in-app banner | New chat picker works; Alice's message reaches delivered; Bob's list shows a row with "1 unread" and a badge; the in-app banner appears; the link in the text is clickable, trailing dot outside, `rel` contains `noopener`. |
| 3 | Bob opens the chat: message arrives, ticks turn read on Alice's side | Read receipts; Bob's unread badge clears. |
| 4 | text both ways + optimistic send | Messages both ways; Shift+Enter makes a newline and the multi-line text arrives intact. |
| 5 | typing indicator: header + bubble on the other side, clears after idle | "typing..." in the header and a status bubble; clears on its own. |
| 6 | search matches names AND last-message text; unread filter with counts | Carol writes; Unread chip with count; All / Unread filtering; search by last-message text and by name; "No chats match"; arrow keys keep focus on rows. |
| 7 | desktop notification: hidden tab + message from another chat; click opens it | Faked `Notification` records the call (permission granted by context); tab is made "hidden"; Carol's message produces a notification with her name and body; clicking opens Carol's chat. |
| 8 | reply with quote, jump to the quoted message highlights it | Alice replies to Bob ("Replying to Bob" bar), the quote shows on both sides; after 25 filler messages, clicking the quote jumps to and highlights the original. |
| 9 | send an image and a file; thumbnails, file card, download link; 10 MB check | Preview dialog; thumbnail loads from `/media` on Bob's side (width 320); lightbox with Download; PDF card with a `PDF` badge (colour token `danger`), download link and `download` attribute; an oversize file shows "too large" and no preview. Screenshots `02`, `03`. |
| 10 | appearance: theme, dark mode, uploaded wallpaper (downscaled) persist after reload | Rose theme, Dark mode, your-own-picture wallpaper with Dim; `localStorage["commskit.appearance.v1"]` holds preset / mode / wallpaper kind; the stored image is at most 1600 px; after reload `data-ck-preset="rose"`, `data-ck-scheme="dark"`, `--ck-accent` is `#fb7185`; older messages load when scrolled to the top and keep the position; per-chat gradient wallpaper overrides only that chat. Screenshots `04`, `05`. |
| 11 | unsend for everyone, delete for me, clear chat | Delete for everyone shows "You deleted this message" / "This message was deleted"; delete for me affects only Bob; no unsend on incoming messages; clear chat only on one side ("Say hi" empty state). |
| 12 | block / unblock: blocked composer on both sides | "You blocked Bob." / "You can't reply to this conversation", header states; unblock restores composers. Screenshot `06`. |
| 13 | report flow: 7 categories, details, also-block option, confirmation toast | Report sheet has 7 radios, Report disabled until a category is chosen, confirmation "Reported Bob"; "Report message" opens its own sheet. Screenshot `07`. |
| 14 | responsive screenshots: 390x844, 768x1024, 1280x800 and no horizontal overflow at 320 | Phone single pane with Back button; tablet is `data-layout="split"`; no horizontal overflow at each size including 320x568. Screenshots `10` to `15`. |
| 15 | reconnect: server restart shows the banner, then recovers and messages flow | Stops the server; banner "Connecting / Offline" appears; restarts the server (same data); banner disappears (Retry clicked if needed, up to 40 s); messages flow both ways. Screenshot `16`. |
| 16 | no page errors in the browser consoles | No `pageerror` and no console errors in any of the three pages (network "Failed to load resource" / WebSocket noise is filtered out). |

Output: `PASS  <name> (<ms> ms)` / `FAIL  <name>` lines, then `N/16 E2E steps passed; screenshots in ...`. Exit code 1 if anything failed (the last 15 lines of the server log are printed).

### Screenshots
`examples/web-app/e2e/screenshots/` (git-ignored): `01-alice-empty-1280.png`, `02-attachment-preview.png`, `03-lightbox.png`, `04-appearance-sheet.png`, `05-dark-rose-wallpaper-1280.png`, `06-blocked-composer.png`, `07-report-sheet.png`, `10-phone-chat-390x844.png`, `11-phone-list-390x844.png`, `12-tablet-split-768x1024.png`, `13-desktop-1280x800.png`, `14-narrow-chat-320x568.png`, `15-narrow-list-320x568.png`, `16-reconnecting-banner.png`. There is no `08` or `09`. A failing step also writes `FAIL-<step>-<n>.png`. Test files (generated PNG, PDF, big file) are written to `e2e/.tmp/`.

## 6. Limitations

- Dev login only; no real authentication, no registration, no user search. The "New chat" list is just the three demo users.
- Chat only: calls are not wired (`onCall` is not passed). The demo server can run `chat,call`, but the web app ignores calls.
- Token in `sessionStorage`; no refresh logic.
- Notification test uses a faked `Notification` object (real notifications are not observable in headless Chrome); sound and icon are not set.
- e2e covers Chrome only, headless, on a developer machine; it is not wired to CI here **(unverified)**. Windows path to Chrome is the default.
- Relies on the Vite proxy for same-origin; static hosting needs its own proxy or CORS.
- The example does not set `mediaBaseUrl`, `documentViewerUrl`, `unsendWindowSeconds` (default 3600 matches the demo server), a CSP, or cache headers.

## 7. What to copy into your own site

Copy the **ideas**, not the login:

| Copy | From |
|---|---|
| `import "commskit-web/styles.css"` once | `main.tsx` |
| Provider order `AppearanceProvider` > `CommsStack config` > `ChatApp` | `App.tsx` |
| A config with `baseUrl`, `getToken`, `getUserId` backed by **your** auth | `App.tsx` `Chat` |
| `key` on the stack that changes with the user | `App.tsx` |
| Controlled `selectedPeerId` + `startChat` + `chat.refresh()` for a "Message" button | `App.tsx` `open()` |
| The parent with a height (`100dvh`) and `.ck-root` height 100% | `app.css` |
| `resolve.dedupe` for React when linking the package locally | `vite.config.ts` |
| The reverse-proxy idea (same origin for REST, media and `/ws`) | `vite.config.ts` -> nginx in [Web 03](../web/03-using-running-and-deploying.md#nginx-same-origin-proxy-untested) |
| Playwright e2e structure (helpers, three contexts, screenshots) | `e2e/run.mjs` |

Do **not** copy: `/dev/users`, `/dev/token`, the Server URL field, the `?user=` shortcut, `sessionStorage` token storage.
