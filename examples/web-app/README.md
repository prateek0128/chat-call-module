# Web chat demo app (commskit-web)

A Vite + React + TypeScript app: sign in as a demo user, then the full chat UI from [`commskit-web`](../../web/README.md).

## Run it

```bash
# 1. the demo server (chat only is enough; "chat,call" also works, calls are not used here)
# from the comms-kit folder
COMMS_FEATURES=chat backend/backend-python/.venv/Scripts/python -m uvicorn demo_server:app --app-dir examples/backend/demo-server-python --port 8000   # PowerShell: $env:COMMS_FEATURES="chat"

# 2. the web package, then this app
cd web && npm install && npm run build
cd ../examples/web-app && npm install && npm run dev       # http://localhost:5173
```

Open `http://localhost:5173` in two browser profiles (or one normal and one private window) and sign in as **Alice** and **Bob**;
use the pencil button ("New chat") to start a chat. Shortcuts: `?user=U1&open=U2` signs in as Alice and opens the chat with Bob.
Alice is `U1`, Bob `U2`, Carol `U3`. Sessions are kept per tab (`sessionStorage`); appearance is shared by tabs of one browser (`localStorage`).

### Server URL, proxy and CORS
- The login screen has a **Server URL** (default `http://localhost:8000`) and **Use the dev proxy** (on by default).
  With the proxy the browser talks only to the Vite origin; Vite forwards `/dev /chats /moderation /devices /media /call` and the
  WebSocket `/ws` to `COMMS_SERVER` (default `http://localhost:8000`): `COMMS_SERVER=http://192.168.1.20:8000 npm run dev`.
  No CORS involved. This also applies to `npm run preview` (the production build).
- Without the proxy the demo server must allow your origin. `examples/backend/demo-server-python/demo_server.py` has an opt-in switch:
  `COMMS_CORS_ORIGINS=http://localhost:5173 uvicorn ...` (comma-separated; unset = no CORS middleware). WebSockets are not subject to CORS.
- `VITE_DEFAULT_SERVER` changes the default text of the Server URL field.
- The demo server hands out tokens to anyone (`/dev/token/{id}`): never deploy it.

## What to try
Messages with ticks that turn blue when read, typing, reply (right-click, or swipe right on touch) and quote jump, images (lightbox, download)
and files, delete for me / for everyone, clear chat, block / unblock, report, search and the Unread filter, appearance (palette button: mode,
7 themes, wallpapers, your own picture, per-chat wallpaper from the chat menu), desktop notifications (bell button, then switch tabs),
reconnect (stop the server: "Offline. Retrying in Ns" + Retry).

## Tests

```bash
npm run build:web && npm run build        # builds the package and this app (tsc + vite build)
npm run e2e                               # real Chrome, two or three browser contexts, demo server on a free port
```
`npm run e2e` starts its own demo server (backend venv, free port, temporary `COMMS_DEMO_DATA`) and `vite preview`, drives Chrome through
`playwright-core` (`CHROME_PATH` or `C:\Program Files\Google\Chrome\Application\chrome.exe`), and writes screenshots to `e2e/screenshots/`.
