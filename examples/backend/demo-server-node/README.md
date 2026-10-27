# comms kit demo server (Node)

The Node twin of `../demo-server-python/demo_server.py`: the same three demo users (U1 Alice, U2 Bob, U3 Carol), the same
`/dev/users` and `/dev/token/:id` endpoints and the same chat / call / moderation / devices stack, built on
[`commskit-node`](../../../backend/backend-node). The existing clients (the demo page, `examples/web-app`, `examples/expo-app`)
work against it unchanged. **DEV ONLY: it hands out tokens to anyone.**

## Run

```bash
cd ../../../backend/backend-node && npm install && npm run build   # once: commskit-node is linked from ../../../backend/backend-node/dist
cd ../../examples/backend/demo-server-node
npm install
node server.mjs --port 8000            # add --host 0.0.0.0 to reach it from a phone
```

Open http://localhost:8000 in two tabs (one per user). `PORT` also sets the port; the default is 8000 on 127.0.0.1.

The page files (`demo.html`, `demo.css`, `demo.js`, `demo-call.js`) are read from the sibling `../demo-server-python/` folder
through an explicit allow-list (nothing else in that folder is served). Uploaded files are served from `/media`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMS_FEATURES` | `chat,call` | `chat`, `call` or `chat,call` |
| `COMMS_DEMO_DATA` | `./.demo_data` | folder for `demo.db` (SQLite) and `media/` |
| `COMMS_DEMO_SECRET` | `local-demo-secret-change-me-0000` | HS256 secret for the demo tokens |
| `COMMS_CORS_ORIGINS` | unset (off) | comma-separated origins allowed by CORS |
| `EXPO_ACCESS_TOKEN` | unset | optional Expo push access token |
| `ANDROID_CALL_STYLE` | `data` | `data` or `notification` |
| `APNS_KEY_PATH` (or `APNS_KEY`), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_USE_SANDBOX` | unset | iOS VoIP push |
| `TURN_SECRET`, `TURN_URIS` | unset | coturn REST credentials (`POST /call/turn-credentials` answers 503 without the secret) |

## Use it as the backend of the existing test suites

```bash
# 75 browser UI tests (needs Chrome)
cd ../demo-server-python && DEMO_BACKEND=node ../../../backend/backend-python/.venv/Scripts/python -m pytest -q
# web app end-to-end
cd ../../web-app && DEMO_BACKEND=node npm run e2e
```

## Differences from the Python demo

- Plain `node:http` + `restListener(hub)` + `hub.attach(server)` instead of FastAPI / uvicorn; unknown routes answer
  `404 {"detail":"Not Found"}`, but a wrong method on a known path is a 404 (FastAPI: 405).
- SQLite through `better-sqlite3` (WAL mode) instead of aiosqlite.
- The CORS responder is hand-written (same behaviour for the listed origins).
- Run it with `node`, not `--reload`.
