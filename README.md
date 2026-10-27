# commskit

Generic, reusable **chat** and **voice calling** for any app: a Python/FastAPI backend package (with a Node.js/TypeScript twin) and a
React Native/Expo client package. It was first extracted from (and stays wire-compatible with)
the Smart Matrimony apps.

> ## Start here: to set up or import commskit, follow the guides in [`docs/`](docs/)
>
> This README is a **map** of what is in the repository. **The step-by-step instructions to import the kit into your project, wire it
> up, run it locally and deploy it are in [`docs/`](docs/).** Read the guides for the parts you use, in this order:
>
> 1. **Connect your frontend to your backend** (the whole chain, start to finish):
>    [Python backend](docs/connect-frontend-to-backend/connect-frontend-to-backend-python.md) or
>    [Node.js backend](docs/connect-frontend-to-backend/connect-frontend-to-backend-node.md).
> 2. **Set up the server:** [Python guides](docs/backend/backend-python/) or [Node.js guides](docs/backend/backend-node/)
>    (overview, keys and secrets, install / run / deploy).
> 3. **Set up the client:** [phone app guides](docs/mobile/) or [website guides](docs/web/).
> 4. **See it working:** the [example guides](docs/example/) for the demo servers (Python and Node), the phone app and the website.
>
> Each guide folder has the same three files: **01** what it is and what is inside, **02** every key, secret, WebSocket detail and
> placeholder, **03** how to use it in your project, run it locally and deploy it.

Use chat only, call only, or both:

| | Backend (Python / FastAPI) | Backend (Node / TypeScript) | Mobile (React Native / Expo) | Web (React) |
|---|---|---|---|---|
| Shared base (always) | `commskit.core` | `commskit-node/core` | `commskit/core` | `commskit-web` (includes the shared engine) |
| Chat | `commskit.chat` | `commskit-node/chat` | `commskit/chat` | `commskit-web` |
| Call | `commskit.call` | `commskit-node/call` | `commskit/call` | not included yet (the plain-HTML demo has web calls) |
| Chat + call glue | `commskit.integration.link_chat_and_call` | `commskit-node/integration` (`linkChatAndCall`) | nothing extra: pass `onOpenChat` to `CallProvider` | - |

The two backends speak the same protocol and use the same table names and Redis keys, so pick the one that matches your server stack; every client works with either.

Chat and call never import each other, so an app that uses only one of them doesn't load the other's code. On mobile, a chat-only app doesn't need to install WebRTC at all.

## How the pieces fit together

commskit has a **server half** and **client halves**. They talk to each other over one WebSocket (live messages, typing,
call setup) plus a few REST routes. That conversation is written down in
[docs/archive/PROTOCOL.md](docs/archive/PROTOCOL.md), and every folder below is built to it.

```text
   phone app (mobile/)  --+
                          +--  WebSocket + REST  -->  server (backend/)  -->  your database, file storage, push
   website (web/)  -------+
        both look the same because both read design/tokens.json
```

- A **message** goes phone → server → saved → delivered to the other phone or browser, with read ticks coming back.
- A **voice call** is set up through the server (who is calling, who answered), then the audio goes **directly between the two
  devices** (WebRTC). Call audio never passes through your server.
- **Your app's own rules** (who is allowed to chat, who pays for a call, user names and photos, where files are stored) are not
  built in. You plug them in through small hooks, so the kit stays generic.

## What is in this repository

```text
comms-kit/
├── backend/                 the SERVER, in two flavours (pick one)
│   ├── backend-python/      Python package `commskit` (FastAPI + SQLAlchemy)
│   └── backend-node/        Node/TypeScript: npm package `commskit-node` (Fastify / Express / plain Node; same protocol)
├── mobile/                  the PHONE client: npm package `commskit` (React Native / Expo)
├── web/                     the BROWSER client: npm package `commskit-web` (React)
├── design/                  the shared LOOK: colours, sizes, spacing, themes (one source for all clients)
├── examples/                runnable sample apps that use everything above
│   ├── backend/             the demo (test) servers: demo-server-python/ and demo-server-node/
│   ├── expo-app/            a complete phone app
│   └── web-app/             a small website
├── docs/                    written guides for each folder, plus the protocol
│   ├── backend/             backend-python/ and backend-node/ (three guides each)
│   ├── connect-frontend-to-backend/   end-to-end guides: connect your frontend to your backend (Python, Node)
│   └── mobile/, web/, design/, example/, archive/
└── README.md                this file
```


### The folders in the kit's root, in one table

Every folder directly inside `comms-kit/` and what it is for. Each one has a longer section further down.

| Folder | The basics | Needed by | Start with |
|---|---|---|---|
| [`backend/`](backend/) | **The server.** A parent folder with two interchangeable servers that speak the same protocol: `backend-python/` (Python package `commskit`, FastAPI) and `backend-node/` (npm package `commskit-node`, Fastify / Express / plain Node). It keeps every connection open, saves and delivers messages, sets up calls, sends push notifications and enforces block and report. It has no screens, no user table and no login: your app supplies those. | **Every app.** Pick one of the two servers. | [docs/backend/](docs/backend/) |
| [`mobile/`](mobile/) | **The phone client.** The npm package `commskit` for React Native / Expo (SDK 54): the server connection, chat, the call engine, ready-made chat and call screens, push, the iPhone and Android "incoming call" screens, report and block, and themes. Each part is a separate import, so an app loads only what it uses. Needs a development build (not Expo Go). | Apps on iOS / Android. | [docs/mobile/](docs/mobile/) |
| [`web/`](web/) | **The browser client.** The npm package `commskit-web` for React websites: the same chat features as the phone app (reply, files, delete, block, report, themes, notifications), reusing the phone app's chat engine. Chat only; no calls in this package. | Websites. | [docs/web/](docs/web/) |
| [`design/`](design/) | **The shared look.** Two files, no code: `tokens.json` (colours, sizes, spacing, the 7 themes, wallpapers) and `DESIGN_SYSTEM.md` (how every screen should look). The phone app, the website and the demo page all read it, and tests fail if they drift. | Anyone rebranding or adding a theme. | [docs/design/](docs/design/) |
| [`examples/`](examples/) | **Runnable sample apps** (not part of the kit): `backend/` has the two test servers (`demo-server-python/`, `demo-server-node/`, with three fake users and a plain-HTML test page); `expo-app/` is a complete phone app; `web-app/` is a small website. The fastest way to try the kit. Dev only: the test servers hand out login tokens to anyone. | Anyone trying or testing the kit. | [docs/example/](docs/example/) |
| [`docs/`](docs/) | **The written guides.** How to connect your frontend to your backend (`connect-frontend-to-backend/`, Python and Node), three guides for each of the server, phone and web parts (what it is, keys and secrets, install / run / deploy), one guide per example, the design guide, and the protocol in `archive/`. **This is where the setup and import instructions are.** | Everyone, first. | [docs/connect-frontend-to-backend/](docs/connect-frontend-to-backend/) |

Two files sit next to them: `README.md` (this file) and `.gitignore` (keeps virtual environments, `node_modules`, build output and local demo data out of git).

### Which folder do I need?

| I want to... | Use |
|---|---|
| Add chat / calls to my **server** (FastAPI) | `backend/backend-python/` |
| Add chat / calls to my **server** (Node.js / TypeScript: Fastify, Express, plain Node) | `backend/backend-node/` |
| Add chat / calls to my **React Native / Expo** app | `mobile/` (and a running `backend/backend-python/` or `backend/backend-node/`) |
| Add chat to my **website** (React) | `web/` (and a running `backend/backend-python/` or `backend/backend-node/`) |
| Change colours, fonts or themes for every client at once | `design/` |
| See everything working, or try it on my machine | `examples/` |
| Connect my frontend to my backend, step by step | `docs/connect-frontend-to-backend/` |
| Understand a part in depth, set it up, or deploy | `docs/` |

Every client needs a server (`backend/backend-python/` or `backend/backend-node/`: either one works). The server is useless on its own, because it has no screens.

---

### `backend/`: the server

`backend/` is a parent folder with two interchangeable servers. Both speak the same protocol, use the same database table names and the same Redis key names. Pick one per deployment:

- `backend/backend-python/`: the Python package `commskit` (below).
- `backend/backend-node/`: the Node.js / TypeScript package `commskit-node` (further below).

#### `backend/backend-python/`: the server, in Python

- **What it is:** a Python package, `commskit`, that you install into your own FastAPI project.
- **Why it exists:** a chat app can't be built from the phone alone. Something has to keep every connection open, save the
  messages, deliver them to the right person, pass call setup messages between phones, send push notifications to people who are
  offline, and enforce block and report. That is this folder.
- **What it contains:**

| Folder / file | What it does |
|---|---|
| `commskit/core/` | the shared base, always needed: the WebSocket connection (`/ws/{token}`), login check, who is online, push (Expo, Apple VoIP), device registration, rate limits, file storage (local disk or S3), thumbnails, and the Redis bridge for several servers |
| `commskit/chat/` | 1:1 messaging: messages, replies, files and images, read and delivered ticks, typing, unread counts, delete and unsend, clear chat, system messages |
| `commskit/call/` | voice calls: ring, answer, decline, busy, timeouts, re-ring when a phone reconnects, credentials for the TURN relay server, push when the app is closed |
| `commskit/moderation/` | report and block, a blocked-users list, admin review of reports |
| `commskit/integration/` | glue for using features together: call logs inside the chat, a block ending a call, deleting a user's data everywhere |
| `tests/` | 130 automated tests |
| `pyproject.toml` | the install definition and optional extras (`redis`, `s3`, `push`, `apns`, `media`) |

- **You use it in three modes:** chat only, calls only, or both. Chat and calls never import each other.
- **What it does not do:** it has no user table, no login screen and no admin screen. Your app supplies users and login.
- **Run the tests:** `cd backend/backend-python` then `python -m pytest -q tests`.
- **Read more:** [backend/backend-python/README.md](backend/backend-python/README.md) · [docs/backend/backend-python/](docs/backend/backend-python/)

#### `backend/backend-node/`: the server, in Node.js

- **What it is:** an npm package, `commskit-node` (TypeScript, ESM, Node 20 or newer), that you install into your own Node project
  (Fastify, Express, or plain `node:http`). It is a port of `backend/backend-python/`: it speaks the same protocol
  ([docs/archive/PROTOCOL.md](docs/archive/PROTOCOL.md)), uses the same database table names and the same Redis key names, so the existing
  clients work against it unchanged and a Python and a Node server can share a database and Redis. It is not published to npm: install it
  from the folder or a tarball.
- **Why it exists:** for teams whose server is Node/TypeScript and who do not want to add a Python service just for chat and calls. It does
  the same job as `backend/backend-python/` (connections, messages, call setup, push, block and report). Choose one backend per deployment.
- **What it contains:**

| Folder / file | What it does |
|---|---|
| `src/core/` | the shared base, always needed: the WebSocket connection (`/ws/:token`), login check, who is online, push (Expo, Apple VoIP), device registration, rate limits, file storage (local disk or S3), thumbnails, and the Redis bridge for several servers |
| `src/chat/` | 1:1 messaging: messages, replies, files and images, read and delivered ticks, typing, unread counts, delete and unsend, clear chat, system messages |
| `src/call/` | voice calls: ring, answer, decline, busy, timeouts, re-ring when a phone reconnects, credentials for the TURN relay server, push when the app is closed |
| `src/moderation/` | report and block, a blocked-users list, admin review of reports |
| `src/integration/` | glue for using features together: call logs inside the chat, a block ending a call, deleting a user's data everywhere |
| `src/fastify/`, `src/express/` | adapters that mount the REST routes and the WebSocket on a Fastify or Express app (plain `node:http` works without them) |
| `src/schema.ts` | `ensureSchema(db)`: creates the 8 tables |
| `test/` | 172 automated tests (+ 1 optional, skipped without a Redis server), including frames recorded from the Python backend that the Node server must reproduce |
| `scripts/dist-smoke.mjs` | a check of the built package: chat, a call and a block over a real server (`npm run smoke`) |
| `package.json` | the install definition: entry points `commskit-node`, `/core`, `/chat`, `/call`, `/moderation`, `/integration`, `/push`, `/redis`, `/s3`, `/fastify`, `/express`; optional peers (`better-sqlite3` or `pg`, `ioredis`, AWS SDK, `sharp`) |

- **You use it in three modes:** chat only, calls only, or both. Chat and calls never import each other.
- **What it does not do:** it has no user table, no login screen and no admin screen. Your app supplies users and login. It needs a long-running Node process (no serverless).
- **Run the tests:** `cd backend/backend-node` then `npx tsc --noEmit && npx vitest run` (or `npm test`); `npm run build && npm run smoke` checks the built package.
- **Read more:** [backend/backend-node/README.md](backend/backend-node/README.md) · [docs/backend/backend-node/](docs/backend/backend-node/)

### `mobile/`: the phone client

- **What it is:** a TypeScript npm package, `commskit`, for React Native / Expo apps (Expo SDK 54).
- **Why it exists:** it holds everything a phone app would otherwise have to build: the server connection, chat state, the call
  engine, ready-made screens, push handling, the native "incoming call" screens, report and block, and theming.
- **What it contains** (each part is a separate import, so an app loads only what it uses):

| Import | What it gives you |
|---|---|
| `commskit/core` | the single server connection with automatic reconnect |
| `commskit/chat` | chat state and hooks, for example `useConversation(peerId)` |
| `commskit/call` | the call engine (WebRTC) and `useCall()` |
| `commskit/theme` | colour themes, dark mode, wallpapers, saved appearance |
| `commskit/chat-ui` | ready-made chat screens: list, chat, bubbles, message box, long-press menu, appearance panel, report sheets |
| `commskit/call-ui` | the ready-made call screen, `CallOverlay` |
| `commskit/notifications` | push registration, and opening the right chat from a tap |
| `commskit/call-native` | iPhone CallKit and Android full-screen ringing when the app is closed |
| `commskit/moderation` | block and report logic |
| `commskit/engine` | the plain, no-React core that `web/` shares |
| `plugin/` + `app.plugin.js` | an Expo plugin that adds the permissions and native setup |
| `__tests__/` | 325 automated tests |

- **Needs a development build:** calls use native code, so it does not run in Expo Go.
- **Run the tests:** `cd mobile` then `npm run typecheck && npm test`.
- **Read more:** [mobile/README.md](mobile/README.md) · [docs/mobile/](docs/mobile/)

### `web/`: the browser client

- **What it is:** a React npm package, `commskit-web`, with the same chat features as the phone app, for websites.
- **Why it exists:** a website needs the same chat, but can't use React Native screens. It reuses the phone app's chat engine (so
  both behave identically) and adds browser screens and styles.
- **What it contains:**

| Folder / file | What it does |
|---|---|
| `src/ChatApp.tsx` | a ready-made responsive chat (list and chat side by side on desktop, one at a time on phones) |
| `src/ConversationListScreen.tsx`, `ChatScreen.tsx`, `Composer.tsx`, `messages.tsx` | the individual screens and parts, if you want your own layout |
| `src/sheets.tsx`, `appearance.tsx`, `notifications.tsx` | report and block sheets, themes and wallpapers, desktop notifications |
| `src/providers.tsx`, `hooks.ts` | the connection and the hooks, for example `useConversation` |
| `src/styles.css` | the stylesheet, built from the shared design values |
| `test/` | 88 automated tests |

- **Not included:** voice calls in the web package (the plain-HTML demo in `examples/backend/demo-server-python/` has them), and notifications
  when the tab is closed.
- **Run the tests:** `cd web` then `npx tsc --noEmit && npx vitest run`.
- **Read more:** [web/README.md](web/README.md) · [docs/web/](docs/web/)

### `design/`: the shared look

- **What it is:** two files and no code: `tokens.json` (every colour, size, spacing, shadow and animation speed, the 7 colour
  themes and the wallpaper options) and `DESIGN_SYSTEM.md` (how every screen should look and behave).
- **Why it exists:** the phone app, the website and the demo page must look identical. Each one reads its values from
  `tokens.json` instead of keeping its own copy. Tests fail if a copy drifts away from it.
- **When you touch it:** to rebrand or add a theme. Edit `tokens.json`, update each client's copy, and run the tests. The steps are
  in [docs/design/design-overview.md](docs/design/design-overview.md).

### `examples/`: runnable sample apps

These aren't part of the kit. They show it working, and they are the fastest way to try it.

| Folder | What it is |
|---|---|
| `examples/backend/` | the two demo servers, listed next. |
| `examples/backend/demo-server-python/` | a ready-to-run **test server** with three fake users (Alice, Bob, Carol), a plain-HTML test page that has chat **and** voice calls, and 75 browser tests. **Dev only:** it hands out login tokens to anyone. The other two examples talk to it. |
| `examples/backend/demo-server-node/` | the same test server on the **Node backend** (`backend/backend-node/`): same pages, same three users, same endpoints. `DEMO_BACKEND=node` runs the existing browser tests and the web end-to-end test against it instead of the Python one. **Dev only.** |
| `examples/expo-app/` | a complete **phone app** using every part of `mobile/`: login, chat, calls, push, closed-app calls, report and block, themes. Needs a development build. |
| `examples/web-app/` | a small **website** using `web/`, with a 16-step real-browser test (two or three Chrome windows). |

Start the test server (run from the `comms-kit` folder), then open two browser tabs as two users:

```bash
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --port 8000
# open http://localhost:8000/#U1 and http://localhost:8000/#U2
```

Or start the Node version of the test server (needs Node 20+ and `cd backend/backend-node && npm install && npm run build` once; run from the `comms-kit` folder):

```bash
cd examples/backend/demo-server-node && npm install && npm start      # http://localhost:8000, same pages and users
```

Read more: [docs/example/](docs/example/)

### `docs/`: the written guides

| Folder | What is in it |
|---|---|
| `docs/backend/backend-python/`, `docs/backend/backend-node/`, `docs/mobile/`, `docs/web/` | three guides each (`docs/backend/` holds the two server guide sets; `docs/backend/backend-node/` is the Node twin of `docs/backend/backend-python/`): **1** an overview (what it is, why, what is inside), **2** every key, secret, setting, WebSocket detail and placeholder (which are private, which file holds each, what to put there), **3** how to use it in an existing project, run it locally, and deploy it |
| `docs/connect-frontend-to-backend/` | two end-to-end guides, one for the Python backend and one for the Node.js backend: the token your login must issue, the backend wiring, the phone app and website configuration, a test ladder that checks each link of the chain, production notes and a troubleshooting table |
| `docs/example/` | one guide for each example: `backend-example.md` (the demo server), `backend-node-example.md` (the Node demo server), `mobile-example.md`, `web-example.md` |
| `docs/design/` | `design-overview.md`: what is in `design/` and how to change colours or add a theme |
| `docs/archive/` | `PROTOCOL.md` (the exact messages between server and clients) and `IMPLEMENTATION_PLAN.md` (how the kit was planned and built; its status table is out of date) |

**Where to start reading:** the `docs/connect-frontend-to-backend/` guide for your backend (Python or Node), then the `03-using-running-and-deploying.md` of the backend and of each client you use. Each folder's `01-overview.md` explains what it is and what is inside.

## Web client

[`web/`](web/README.md) is `commskit-web`: the React (react-dom) chat UI for browsers, with the same chat features as the React Native UI
(list, chat, reply, media, delete / unsend, block / report, appearance, notifications). It reuses the framework-free engine through the
`commskit/engine` entry of the mobile package (no forked logic, no `react-native` in the web bundle). No calls in this package.

```bash
COMMS_FEATURES=chat backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --port 8000
cd web && npm install && npm run build
cd ../examples/web-app && npm install && npm run dev     # http://localhost:5173, sign in as Alice / Bob in two browser profiles
```

[`examples/web-app`](examples/web-app/README.md) is the runnable demo (Vite proxy to the demo server, no CORS setup; `COMMS_CORS_ORIGINS`
enables CORS on the demo server for a separately hosted app). Tests: `cd web && npm test` (vitest + jsdom, fake WebSocket) and
`cd examples/web-app && npm run e2e` (real Chrome, three browser contexts).

## App-specific rules are plug-ins

Anything specific to one product is supplied by the host app through small adapters, not built into the kit:

- **Rules:** blocking, chat consent, call credits.
- **User data:** profile names and photos.
- **Delivery:** push notifications and file storage.
- **App wiring:** navigation and branding.

## Test it locally

### 1. Automated tests

```bash
cd backend/backend-python
.venv/Scripts/python -m pytest -q        # 130 tests: chat-only / call-only / chat+call apps on SQLite

cd ../backend-node
npm install && npx tsc --noEmit && npx vitest run   # 172 tests (+1 skipped without a Redis server); `npm run build && npm run smoke` checks the built package

cd ../../mobile
npm run typecheck && npm test            # 325 tests: client, chat store, call engine, UI helpers and render smoke tests

cd ../web
npx tsc --noEmit && npx vitest run       # 88 tests: web hooks, components, appearance, notifications
```

### 2. Try chat and calls by hand in the browser (no phone needed)

`examples/backend/demo-server-python/demo_server.py` runs the kit with SQLite and three demo users (Alice U1, Bob U2, Carol U3).
The browser demo is `examples/backend/demo-server-python/demo.html` + `demo.css` + `demo.js` (+ `demo-call.js`, loaded only when
the call feature is on). It speaks the same protocol as the app, follows [design/DESIGN_SYSTEM.md](design/DESIGN_SYSTEM.md)
and uses the [design/tokens.json](design/tokens.json) values. No build step and no CDN: the server serves the files.

```bash
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --reload --port 8000     # run from the comms-kit folder
```

1. Open `http://localhost:8000/#U1` in one tab and `http://localhost:8000/#U2` in another (or another browser).
   `#U1:U2` signs in as Alice and opens the chat with Bob directly. The page is responsive: on a phone-sized
   window it shows one pane at a time (← goes back, so does Esc); from 700 px wide it shows the list and the chat side by side.
2. Click the other person in the chat list (or use ↑/↓ and Enter). The `</>` button opens a drawer with every WebSocket frame.
3. Chat: messages, ✓/✓✓ ticks, ✓✓ in light blue when read, "typing…", 📎 files and photos (a preview sheet opens
   before sending; the limit is 10 MB), a full-screen photo viewer, and older messages that load as you scroll up.
4. Call: the phone button in the chat header in one tab, **Accept** in the other. Allow microphone access. Use headphones,
   or two devices, otherwise the two tabs echo each other. During the call: Mute, Speaker (picks the audio output,
   shown only in browsers with `setSinkId`), and End.
5. Hang up, and the call log ("Voice call · 00:12") appears in the chat with a **Call back** button.
6. The half-circle button on the sign-in card switches the theme: system → light → dark (remembered in this browser).
7. Appearance (themes + wallpapers): the palette button in the chat list header opens the Appearance sheet with
   Mode (Auto / Light / Dark), seven chat themes (Indigo, Rose, Emerald, Ocean, Amber, Violet, Graphite) and the
   chat wallpaper (default, solid colours, gradients, or your own picture via "Choose image…" or drag and drop, with
   a Dim slider). In a chat, ⋮ → **Wallpaper** sets it for that chat only ("This chat" / "All chats", "Reset this chat").
   It is all stored locally in this browser and nothing is sent to the other person. Call-only mode shows Mode and Theme only.

Modes: use the **Chat · Calls · Both** switch on the sign-in card or under the search box. Switching
reloads the page in that mode (Chat never loads the calling code); the choice is remembered and is also
in the address as `?mode=chat|call|both`, so two tabs can use different modes.

The switch only offers what the server runs. To start the server itself with one feature, set
`COMMS_FEATURES` first (PowerShell: `$env:COMMS_FEATURES="chat"`; Git Bash:
`COMMS_FEATURES=chat backend/backend-python/.venv/Scripts/python -m uvicorn ...`). Values: `chat`, `call`, `chat,call` (default).
Chat-only has no call button and never loads the call code. Call-only shows a list of people to call and no message box.
Data lives in `examples/backend/demo-server-python/.demo_data/` (delete it to start fresh); `COMMS_DEMO_DATA` points it somewhere else.
After you edit the demo files, a normal reload picks up the change.

**Node server instead of Python:** build the Node backend once (`cd backend/backend-node && npm install && npm run build`), then from the
`comms-kit` folder run `cd examples/backend/demo-server-node && npm install && npm start`. It serves the same page, the same three users and
the same endpoints on `http://localhost:8000` (stop the Python demo first, or pass `--port`). See
[docs/example/backend-node-example.md](docs/example/backend-node-example.md).

### 3. Browser UI tests (headless Chrome)

```bash
cd examples/backend/demo-server-python
../../../backend/backend-python/.venv/Scripts/python -m pytest -q      # ~75 tests, about 2-3 minutes (own pytest.ini)
```

- They need Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`, or set `CHROME_PATH`).
  Without Chrome, the browser tests are skipped. They drive Chrome over the DevTools Protocol with the `websockets`
  package that is already installed, so there is nothing else to install.
- Each feature mode (`chat,call`, `chat`, `call`) gets its own demo server on a free port (never 8000) with a temporary
  `COMMS_DEMO_DATA`. Your running server and `examples/backend/demo-server-python/.demo_data` are not touched.
- What they check:
  - Layout at 320×568, 360×740, 390×844, 844×390, 768×1024, 1280×800 and 1920×1080: no horizontal overflow; header,
    composer and call controls on screen and clickable; a simulated phone keyboard.
  - Behaviour: live messages and unread badges, ✓ → ✓✓ → read, typing, paging older messages, keyboard navigation
    and Esc, attachments and the 10 MB limit, the reconnect banner, a real two-tab call (accept, mute, output, hang up),
    and the declined, busy, no-answer and microphone-blocked screens.
  - Modes: chat-only never loads `demo-call.js` or calls `getUserMedia`; call-only shows no composer;
    the in-page switch reloads into each mode and greys out what the server doesn't run.
  - Theme and motion: dark mode, the theme toggle, and reduced motion.
  - `test_tokens.py`: the CSS custom properties equal `design/tokens.json` in both themes.
- Screenshots of the key states are written to `examples/backend/demo-server-python/ui_tests/screenshots/` (git-ignored).
- `python -m pytest -q` run from `backend/backend-python/` runs only the backend unit tests (a separate suite).
- **Against the Node server:** set `DEMO_BACKEND=node` and the same tests start the Node demo server instead of the Python one
  (PowerShell: `$env:DEMO_BACKEND="node"`; bash: `DEMO_BACKEND=node ../../../backend/backend-python/.venv/Scripts/python -m pytest -q`).
  The web end-to-end test works the same way: `cd examples/web-app && DEMO_BACKEND=node npm run e2e`. Build `backend/backend-node` first.

Two devices on your Wi-Fi: start with `--host 0.0.0.0` and open `http://<your-PC-IP>:8000`.
Browsers only allow the microphone on `localhost` or HTTPS, so for calls between two computers
serve over HTTPS (e.g. an ngrok/cloudflared tunnel). Chat works over plain HTTP.

The demo server hands out tokens to anyone (`/dev/token/{id}`); never deploy it.

### 4. On phones (Expo example app)

[`examples/expo-app`](examples/expo-app/README.md) is a runnable Expo SDK 54 app that uses every mobile
entry point (chat + chat-ui, calls + call-ui, CallKit / Android full-screen calls, push, appearance,
report & block). It needs a development build (Expo Go is not supported):

```bash
backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --host 0.0.0.0 --port 8000
cd examples/expo-app && npm install
eas build --profile development --platform android   # or ios; then install it on the phone
npx expo start --dev-client                           # sign in with http://<your-PC-LAN-IP>:8000
```

Its README covers two-phone testing, push, killed-app calls, TURN for mobile data, APNs for iOS VoIP
and the Maestro E2E flows (`maestro test .maestro`).
