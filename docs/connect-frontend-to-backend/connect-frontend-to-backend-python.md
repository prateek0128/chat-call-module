# Connect your frontend to the commskit Python backend

A start-to-finish guide for a developer who already has a **FastAPI project with its own login** and an **existing frontend** (a React Native / Expo phone app, a React website, or both), and wants chat (and optionally calls) from the kit.

The point of this guide: the kit does not log anybody in. Your login does. The kit only checks a token that your login issued. Almost every "it does not connect" problem is a mismatch between what your login put into the token and what the kit expects. This guide walks the whole chain in order and gives you a test ladder so you can see which link is broken.

Twin guide for the Node backend: `connect-frontend-to-backend-node.md` (same folder; written separately).

## Table of contents

0. [At a glance](#0-at-a-glance)
1. [Prerequisites](#1-prerequisites)
2. [Step 1: The token contract](#2-step-1-the-token-contract)
3. [Step 2: Backend](#3-step-2-backend)
4. [Step 3: Phone app (React Native / Expo)](#4-step-3-phone-app-react-native--expo)
5. [Step 4: Website (React)](#5-step-4-website-react)
6. [Step 5: Verify the connection](#6-step-5-verify-the-connection)
7. [Step 6: What happens on the wire](#7-step-6-what-happens-on-the-wire)
8. [Step 7: Going to production](#8-step-7-going-to-production)
9. [Step 8: Optional extras](#9-step-8-optional-extras)
10. [Troubleshooting by symptom](#10-troubleshooting-by-symptom)
11. [Connection checklist and where to read next](#11-connection-checklist-and-where-to-read-next)
12. [Appendix: what was verified, and how](#12-appendix-what-was-verified-and-how)

**Conventions.** Paths are relative to the `comms-kit/` folder unless stated. Commands are given for PowerShell (Windows) and bash (Linux, macOS, Git Bash) where they differ. **(not verified)** marks something I could not confirm from the code or by running it; **(verified)** means I ran it or read the exact code line. Section 12 lists exactly what was run.

---

## 0. At a glance

```
 1. USER                 2. YOUR EXISTING BACKEND (FastAPI)            3. FRONTEND (phone app / website)
 ---------               ------------------------------------           ---------------------------------
 types name +   ------>  POST /auth/login  (YOUR code)
 password                 checks the password
                          signs a JWT  { "uid": "1001",
                                         "exp": <1 h from now> }
                          with JWT_SECRET (HS256)           ------>     stores the token
                                                                        (memory / secure storage)

                                                            4. KIT CLIENT (commskit / commskit-web)
                                                            ---------------------------------------
                                                            getToken() -> the token
                                                            getUserId() -> "1001"
                                       wss://host/ws/<token>   <------  opens the WebSocket
                                       Authorization: Bearer <token> <- REST calls (/chats/...)

 5. SAME BACKEND PROCESS, kit part
 ---------------------------------
 JwtAuth(JWT_SECRET, "HS256", claim="uid")
    token valid?  no  -> REST: 401        WebSocket: accept, then close 1008 "Invalid token"
                  yes -> user id "1001"
 hub.ws_router()    /ws/{token}      live messages, typing, read ticks, call signalling
 hub.rest_router()  /chats/...       chat list, history, start chat, mark read
 database (SQLAlchemy async)          saved messages; undelivered ones arrive when the user connects
```

Boxes 2 and 5 are the **same FastAPI app**, and they use **the same secret**. The kit never creates tokens and the frontend never decodes them (verified: no JWT decoding anywhere in `mobile/src` or `web/src`).

### What must match on both sides

| Thing | Your login / frontend side | Kit backend side | If it differs |
|---|---|---|---|
| JWT secret | Signs the token | `JwtAuth(secret=...)` | `401 Invalid token` on REST, close `1008` on the WebSocket |
| Algorithm | e.g. `HS256` | `JwtAuth(algorithm="HS256")` (default). Only this one is accepted | Same as above ("The specified alg value is not allowed") |
| Claim name | `uid` in the token payload | `JwtAuth(claim="uid")` (default) | `Token has no 'uid' claim` -> 401 / 1008 |
| No `aud` claim | Do not put `aud` in the token | `JwtAuth` passes no audience to PyJWT | Token rejected: "Invalid audience" (verified). Use a custom `AuthAdapter` if you need `aud` |
| Base URL (REST) | `CommsConfig.baseUrl`, e.g. `https://api.example.com` | Where uvicorn / your proxy listens | "Network request failed", CORS errors, 404 |
| WebSocket URL | `wsUrl`, derived from `baseUrl`: `https` -> `wss`, `http` -> `ws`; then `/ws/<token>` | `hub.ws_router()` mounts `/ws/{token}` | Socket never opens (status `reconnecting`) |
| User-id strings | What `uid` holds, what `getUserId()` returns, and the ids you use for peers (`startChat(id)`, `ChatScreen peerId=`) | The same string is the user's id in `chats`, `messages`, presence and `UserDirectory` | Empty chat list, `403 Not allowed`, messages to nobody |
| Allowed origin (web only) | The website's origin, e.g. `https://app.example.com` | `CORSMiddleware(allow_origins=[...])`, or a same-origin proxy so none is needed | Browser console: "blocked by CORS policy" |
| Protocol version | Wire protocol v1 (`docs/archive/PROTOCOL.md`); `commskit` 0.1.0, `commskit-web` 0.1.0, Python `commskit` 0.1.0 | Same | There is no version field in the handshake (verified: `commskit/core/websocket.py` reads only the token), so a mismatch shows up as unknown/ignored frames, not as a clean error. Use all three packages from the same checkout of the kit |

**What `uid` means.** It is the user's id **as a string**, the same one your database uses for that person (`"1001"`). Everything in the kit is keyed by it. The frontend must pass the very same string as `getUserId()`, and must use the **other** person's same-style id whenever it names a peer. If your login has integer ids, the kit converts the claim with `str()` (verified: `{"uid": 1001}` becomes `"1001"`), and your frontend must also use `"1001"`, not `1001` and not an email address.

---

## 1. Prerequisites

| Need | Detail | Source |
|---|---|---|
| A running FastAPI app | With its own login that can tell who a request belongs to. You only add routes to it | - |
| Python 3.11 or newer | `requires-python = ">=3.11"`. I used 3.12.10 | `backend/backend-python/pyproject.toml` |
| An async SQLAlchemy engine and session factory | `create_async_engine(...)` plus `async_sessionmaker(engine, expire_on_commit=False)`. Drivers: `aiosqlite` (dev) or `asyncpg` (production). The kit ships neither | `backend/backend-python/README.md` |
| An ASGI server **with a WebSocket library** | `pip install "uvicorn[standard]"` (or `uvicorn` plus `websockets`). Without one, `/ws/...` answers 404 and uvicorn logs `No supported WebSocket library detected` (verified) | `docs/web/03` section 4.1 says the same |
| Your login identifies users | You can produce a stable id per user and sign a JWT (or write an adapter, Step 1) | - |
| Node 20+ and npm | For the website and the Expo app | `docs/mobile/03` section 1 |
| Expo SDK 54 app (React Native 0.81, React 19.1) | What the example uses. The kit needs a **development build**, not Expo Go, for calls. Chat-only in Expo Go is **not verified** | `docs/mobile/03` sections 1, 4.3 |
| A website using React 18 or newer | `commskit-web` peers: `react >=18`, `react-dom >=18` | `web/package.json` |
| A way for the frontend to reach the server | Same machine (`localhost`), same Wi-Fi (LAN IP), or a public HTTPS host. See the URL table in Step 3 | - |

You do **not** need the kit's demo server for a real integration. It is only a reference: [`examples/backend/demo-server-python/demo_server.py`](../../examples/backend/demo-server-python/demo_server.py) is the shortest complete wiring of everything in this guide, plus a dev-only `/dev/token/{id}` that hands out tokens to anyone.

---

## 2. Step 1: The token contract

### 2.1 Exactly what the kit checks

Source: `backend/backend-python/commskit/core/adapters.py` (`JwtAuth`, `resolve_user_id`, `bearer_dependency`) and `commskit/core/websocket.py`. The behaviours below were run against PyJWT 2.15.1 (verified); `pyproject.toml` allows `pyjwt>=2.8`, so details marked "PyJWT version" may differ on older versions.

| Question | Answer |
|---|---|
| Algorithm | `HS256` by default. Exactly one algorithm is accepted (`algorithms=[algorithm]`). An `HS512` token is rejected: "The specified alg value is not allowed" |
| Where is the user id? | In the claim named by `claim` (default `uid`). Converted with `str()`. Missing or empty: `AuthError("Token has no 'uid' claim")` |
| `exp` | Checked **if present**. Expired: "Signature has expired". A token with **no** `exp` is accepted forever, so your login must set one |
| `nbf` / `iat` | Checked by PyJWT. A token whose `nbf` or `iat` is in the future is rejected ("The token is not yet valid (iat)"). If your login server's clock runs ahead of the chat server's, tokens are refused until the clocks agree (PyJWT version) |
| `aud` | A token that has an `aud` claim is rejected ("Invalid audience"), because `JwtAuth` passes no audience |
| `sub` as an integer | With `JwtAuth(claim="sub")`, PyJWT 2.15.1 rejects an integer `sub` ("Subject must be a string"). Issue it as a string (PyJWT version) |
| Secret | Must be non-empty (`ValueError` otherwise). Use 32 bytes or more: PyJWT 2.15.1 emits `InsecureKeyLengthWarning` for shorter HMAC keys |
| REST failure | `401 {"detail":"Not authenticated"}` when the `Authorization: Bearer` header is missing or empty. `401 {"detail":"Invalid token"}` for anything the adapter rejects (bad signature, expired, wrong claim, adapter exception) |
| REST wrong user | `403 {"detail":"Not allowed"}` when the id in the path (`GET /chats/<id>`) is not the token's user |
| WebSocket failure | The server **accepts** the connection, then closes it with code **1008**, reason `Invalid token`. Browsers therefore see an open (HTTP 101) socket that closes immediately, not an HTTP error |
| When is the token checked? | Once per WebSocket connect, and on every REST call. An already-open socket keeps working after the token expires (verified: a `ping` still got `PONG` 2 s after expiry) |
| Where does the token travel? | WebSocket: in the URL path, `wss://host/ws/<token>` (browsers cannot set headers on a WebSocket). REST: `Authorization: Bearer <token>` |
| Token characters | A JWT (base64url plus dots) is safe in a path. An **opaque** session id containing `/` can never match the route `/ws/{token}` (TestClient: closed without reaching your adapter). Issue URL-safe ids, for example `secrets.token_urlsafe(32)` |

### 2.2 Issue a compatible token from your existing login

Your login endpoint probably already returns a JWT. You need only two things: sign it with the secret the kit will use, and put the user id in the `uid` claim. This is the login of the complete `main.py` in Step 2 (verified); adapt the user lookup to your code:

```python
import time
import jwt                                   # PyJWT, installed with commskit
from fastapi import HTTPException

JWT_SECRET = os.environ["JWT_SECRET"]        # same value you give JwtAuth in Step 2
JWT_ALGORITHM = "HS256"
TOKEN_LIFETIME_SECONDS = 60 * 60

@app.post("/auth/login")                     # YOUR existing endpoint, keep its path and body
async def login(body: LoginBody) -> dict:
    user = await check_password(body.username, body.password)    # your existing check
    if user is None:
        raise HTTPException(status_code=401, detail="Wrong username or password")
    now = int(time.time())
    token = jwt.encode(
        {"uid": str(user.id), "iat": now, "exp": now + TOKEN_LIFETIME_SECONDS},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return {"token": token, "user_id": str(user.id)}
```

Two ways to hand the token to the frontend:

| Option | When to use | What to do |
|---|---|---|
| A. Reuse your login token | Your login already returns an HS256 JWT, and its claim and secret are yours to choose | Add `uid` to its payload (or point `JwtAuth(claim=...)` at the claim it already has), and share the secret |
| B. A separate chat token | Your login token is an opaque session, a cookie, has `aud`, uses another algorithm, or you do not want the chat to use the same lifetime | Add one endpoint that sits **behind your existing auth** and mints a short-lived chat token (below). The frontend's `getToken()` calls it |

Option B, a complete example (`current_user` is your existing FastAPI dependency; it is not part of the kit):

```python
@app.get("/api/chat-token")
async def chat_token(user=Depends(current_user)) -> dict:        # your existing auth dependency
    now = int(time.time())
    token = jwt.encode({"uid": str(user.id), "iat": now, "exp": now + 15 * 60},
                       JWT_SECRET, algorithm=JWT_ALGORITHM)
    return {"token": token, "expires_in": 15 * 60}
```

Check what you issue by decoding it **without** sending it to a website (tokens are credentials). Save as `decode_token.py` and run `python decode_token.py <token>` (verified, output below):

```python
import sys, jwt
print(jwt.decode(sys.argv[1], options={"verify_signature": False}))
# {'uid': '1001', 'iat': 1793085433, 'exp': 1793089033}
```

### 2.3 If your tokens do not look like that

| Your situation | What to do | Verified |
|---|---|---|
| HS256, but the id is in another claim (`sub`, `user_id`, ...) | `JwtAuth(secret=..., claim="sub")` (use the string form of the id for `sub`) | yes: `claim="sub"` and `claim="user_id"` (integer value became `"7"`) |
| RS256 (public key verification) | `JwtAuth(secret=PUBLIC_KEY_PEM, algorithm="RS256")`: the PEM public key goes into `secret` | yes with a freshly generated RSA key (needs the `cryptography` package). `ES256` and key rotation (JWKS): not tested |
| Tokens carry `aud` and/or `iss` | Write an adapter (below) | yes |
| Opaque session ids looked up in your database | Write an async adapter (below) | yes, on SQLite |
| You already have a function that decodes your tokens | Wrap it in an adapter (below) | the wrapper is trivial; not run |

An adapter is any object with `user_id_from_token(token) -> str` (sync or async). Raise any exception to mean "invalid". The same adapter protects the WebSocket and all REST routes. Pass it as `CommsHub(auth=...)`.

Tokens with `aud` / `iss` (verified):

```python
import jwt

class AudJwtAuth:
    def user_id_from_token(self, token: str) -> str:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"],
                             audience="my-web-app", issuer="https://login.example.com")
        return str(payload["sub"])          # a wrong audience raises InvalidAudienceError -> 401 / 1008
```

Opaque sessions from your own table (verified; `UserSession` is your model):

```python
from sqlalchemy import func, select
from commskit.core import AuthError

class SessionTokenAuth:
    async def user_id_from_token(self, token: str) -> str:
        async with SessionLocal() as db:
            row = (await db.execute(
                select(UserSession.user_id).where(UserSession.token == token, UserSession.expires_at > func.now())
            )).first()
        if row is None:
            raise AuthError("unknown or expired session")
        return str(row[0])                  # this string is the user id everywhere in the kit
```

Wrapping your existing decoder:

```python
class ExistingAuth:
    def user_id_from_token(self, token: str) -> str:
        return str(decode_my_token(token)["user_id"])       # your function; raise when invalid
```

If your adapter does a database lookup, remember the kit calls it on **every REST request** and on every WebSocket connect (it is not cached).

### 2.4 The one rule about user ids

The kit has no users table. A "user" is just a string. The same string must appear in four places:

1. the `uid` claim of the token (or whatever your adapter returns),
2. `getUserId()` in the frontend config,
3. every peer id the frontend uses: `startChat("1002")`, `<ChatScreen peerId="1002" />`, `startCall("1002")`,
4. the keys of `UserDirectory.get_profiles` (Step 2), so the chat list shows real names.

Do not mix `"1002"`, `1002`, `"U2"`, and emails for the same person. Chats are stored as the pair of two such strings, so two spellings are two different people.

> **Smart Matrimony note.** The kit's README shows the Smart Matrimony adapter reading `decode_token(token)["uid"]`, and `docs/backend/backend-python/02` (C.5) repeats it, so its tokens also use the claim `uid`. That is documentation only: I did not check `matrimonial-backend-v2` itself (out of scope).

---

## 3. Step 2: Backend

### 3.1 Install

The package is not on PyPI. Install from a local checkout (editable, good while developing). Do it inside **your project's** virtual environment:

```powershell
# PowerShell, in your API project
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e "C:\path\to\comms-kit\backend\backend-python" "uvicorn[standard]" aiosqlite httpx
```

```bash
# bash
python -m venv .venv
source .venv/bin/activate          # Git Bash on Windows: source .venv/Scripts/activate
pip install -e "/path/to/comms-kit/backend/backend-python" "uvicorn[standard]" aiosqlite httpx
```

(I ran the editable install above into a fresh venv, then ran `main.py` from it: verified. `httpx` is only for the test scripts in Step 5.) Extras, if you need them later: `commskit[redis]`, `[s3]`, `[media]`, `[push]`, `[apns]` (Step 7 and 8), written like `pip install -e "C:\path\to\comms-kit\backend\backend-python[redis,push]"`.

From a git repository where the kit lives in a sub-folder, pip supports a subdirectory URL. The real layout puts the Python package in `backend/backend-python`, so (placeholder URL, **not tested**):

```bash
pip install "commskit @ git+https://github.com/YOUR-ORG/YOUR-REPO.git@v0.1.0#subdirectory=backend/backend-python"
```

Full install notes: [`docs/backend/backend-python/03`](../backend/backend-python/03-using-running-and-deploying.md) section 2.1.

### 3.2 The order of operations

1. Create the engine and `async_sessionmaker(engine, expire_on_commit=False)` (the kit also works with the default).
2. Create `CommsHub(auth=..., session_factory=..., users=...)`.
3. Install features: `ChatFeature(...).install(hub)`, optionally `CallFeature(...)`, `ModerationFeature(...)`, `DevicesFeature(...)`.
4. Link them (`link_chat_and_call`, `link_moderation`) if you use several.
5. **Only then** `app.include_router(hub.ws_router())` and `app.include_router(hub.rest_router())`. `rest_router()` collects the routers of the features installed at that moment (`commskit/core/hub.py`, `rest_router`): a feature installed later has no routes. Installing the same feature twice raises `RuntimeError`.
6. In the lifespan: create the tables (dev), `await hub.connections.start()`; on shutdown `await hub.shutdown()` and `await engine.dispose()`.

### 3.3 A complete runnable `main.py` (chat only, with login, names and CORS)

This is a whole FastAPI app: a stand-in for your existing login (`/auth/login`), and the kit. It is the exact file I ran for the verification ladder in Step 5 (verified). Replace `FAKE_USERS` and the login body with your own code; keep the rest.

```python
# main.py - a FastAPI app with its own login, plus commskit chat.
import os
import time
from contextlib import asynccontextmanager
from typing import Mapping, Sequence

import jwt                                            # PyJWT (installed with commskit)
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from commskit.chat import ChatFeature
from commskit.core import CommsBase, CommsHub, JwtAuth, UserProfile

# ---- settings (from the environment, never hard-coded) ---------------------------------------
JWT_SECRET = os.environ["JWT_SECRET"]                 # the ONE secret used to sign and to verify
JWT_ALGORITHM = "HS256"
TOKEN_LIFETIME_SECONDS = 60 * 60                      # 1 hour
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./app.db")
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

# ---- database ---------------------------------------------------------------------------------
engine = create_async_engine(DATABASE_URL)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

# ---- YOUR existing user store (stand-in: replace with your real users table) -------------------
FAKE_USERS = {   # id -> (password, display name)
    "1001": ("pw-alice", "Alice"),
    "1002": ("pw-bob", "Bob"),
}


class MyUserDirectory:
    """Lets the kit show real names/photos in the chat list. Ids are the same strings as the token's uid."""

    async def get_profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        # Real app: one query, e.g. select(User).where(User.id.in_([int(i) for i in user_ids]))
        return {uid: UserProfile(name=FAKE_USERS[uid][1], avatar=None) for uid in user_ids if uid in FAKE_USERS}


# ---- the kit ----------------------------------------------------------------------------------
hub = CommsHub(
    auth=JwtAuth(secret=JWT_SECRET, algorithm=JWT_ALGORITHM, claim="uid"),
    session_factory=SessionLocal,
    users=MyUserDirectory(),
)
ChatFeature().install(hub)          # chat only; add CallFeature(...) here for calls (see Step 8)


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:                      # dev: create the kit's tables
        await conn.run_sync(CommsBase.metadata.create_all)  # production: use migrations
    await hub.connections.start()
    yield
    await hub.shutdown()
    await engine.dispose()


app = FastAPI(lifespan=lifespan)

if CORS_ORIGINS:   # only needed when the website is on another origin (Step 4)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )


# ---- YOUR existing login, with ONE change: the token carries the `uid` claim --------------------
class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/auth/login")
async def login(body: LoginBody) -> dict:
    user_id = next((uid for uid, (pw, name) in FAKE_USERS.items()
                    if name.lower() == body.username.lower() and pw == body.password), None)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Wrong username or password")
    now = int(time.time())
    token = jwt.encode(
        {"uid": user_id, "iat": now, "exp": now + TOKEN_LIFETIME_SECONDS},   # uid = the id peers use
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return {"token": token, "user_id": user_id}


# ---- the kit's routes --------------------------------------------------------------------------
app.include_router(hub.ws_router())      # WebSocket  /ws/{token}
app.include_router(hub.rest_router())    # REST       /chats/...
```

Notes on this file:

- Only `chat` tables are created because only `commskit.chat` was imported: a table is registered on `CommsBase.metadata` when its module is imported. If you add calls, moderation or devices, import them **before** `create_all` runs (the imports at the top of the file do that).
- The tables are named `chats`, `messages` (and `calls`, `comms_devices`, `comms_blocks`, ... when used). They have no prefix. If your project already has a table called `messages` or `chats`, `create_all` skips it and the kit then fails on different columns. Check first (`docs/backend/backend-python/03` section 2.6).
- `create_all` never alters existing tables. Use migrations in production (Alembic can use `CommsBase.metadata`: general practice, not tested here).
- `FastAPI(lifespan=...)`: if your app already has a lifespan, add the `create_all` / `hub.connections.start()` / `hub.shutdown()` lines to it.

### 3.4 The three modes

All three use the same `hub`, `auth`, `session_factory` and the same two `include_router` lines.

**Chat only** (as above):

```python
hub = CommsHub(auth=JwtAuth(secret=JWT_SECRET), session_factory=SessionLocal, users=MyUserDirectory())
ChatFeature().install(hub)        # AllowAllChatPolicy, LocalDiskStorage("comms_media") (not served: see Step 8)
```

**Call only** (verified: built, `POST /call/turn-credentials` answered 200 with credentials; `/chats/...` is 404 as expected):

```python
from commskit.call import CallConfig, CallFeature

hub = CommsHub(auth=JwtAuth(secret=JWT_SECRET), session_factory=SessionLocal, users=MyUserDirectory())
CallFeature(config=CallConfig(
    turn_secret=os.environ["TURN_SECRET"],
    turn_uris=["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
)).install(hub)
```

Without chat, call payloads carry `chat_id: null`, no chat message is written and no `call_log` is sent. Without `turn_secret`, `/call/turn-credentials` answers 503 (calls then use only public STUN and fail across mobile networks).

**Chat + call** (verified: the install order below built an app with all routes):

```python
from commskit.chat import ChatFeature
from commskit.call import CallConfig, CallFeature
from commskit.integration import link_chat_and_call

hub = CommsHub(auth=JwtAuth(secret=JWT_SECRET), session_factory=SessionLocal, users=MyUserDirectory())
chat = ChatFeature().install(hub)
call = CallFeature(config=CallConfig(turn_secret=os.environ["TURN_SECRET"], turn_uris=[...])).install(hub)
link_chat_and_call(chat, call)        # chat_id lookup, "[Call Initiated]" entry, call_log frames
```

### 3.5 Show real names and photos: `UserDirectory`

Without a directory, the chat list shows each person's **id** as their name (verified in code: `list_chats` falls back to the id, and the socket falls back to "Someone"). Pass `users=` an object with one method:

```python
class MyUserDirectory:
    async def get_profiles(self, user_ids: Sequence[str]) -> Mapping[str, UserProfile]:
        rows = await load_users(user_ids)                       # ONE query for all ids
        return {str(u.id): UserProfile(name=u.display_name, avatar=u.photo_url) for u in rows}
```

Unknown ids may be left out. Errors are logged and treated as "no names" (the kit never fails a message because of the directory). `avatar` is a URL the frontend can load.

### 3.6 CORS (only for a separately hosted website)

If the website is served from another origin than the API, add this exact middleware (it is already in `main.py`, controlled by `CORS_ORIGINS`). A phone app and a same-origin proxy do not need it:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],            # explicit list; origin = scheme + host + port, no path
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)
```

Verified against the running app: a preflight `OPTIONS` from an allowed origin returns 200 with `access-control-allow-origin`, `-methods`, `-headers: ...Authorization...` and `access-control-max-age: 600`; an `OPTIONS` from a non-listed origin returns `400 Disallowed CORS origin`. **WebSockets are not subject to CORS** and the kit does not check the `Origin` header (verified: `websocket.py` never reads it), so the token is the only protection of the socket.

### 3.7 Run it

```powershell
# PowerShell, in your API project, venv active
python -c "import secrets; print(secrets.token_hex(32))"      # copy the output
$env:JWT_SECRET = "<paste the 64 hex characters>"
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

```bash
# bash
python -c "import secrets; print(secrets.token_hex(32))"
export JWT_SECRET="<paste the 64 hex characters>"
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

- `--host 127.0.0.1` (the uvicorn default) is reachable only from the same machine. A real phone needs `--host 0.0.0.0` (Step 3).
- Add `--reload` while developing. Use **one worker** unless you configure Redis (Step 7).
- Use any free port. I ran the verification on port 8765 instead of 8000; nothing else differs.
- The WebSocket path is `/ws/{token}`. It can be changed with `hub.ws_router(path="/realtime/{token}")` but then both clients must be told; the client path configuration was **not checked**, so keep the default.
- Behind a reverse proxy it must forward the HTTP/1.1 upgrade on `/ws/` and not time out quiet sockets (Step 7, nginx block).

Where the demo server does the same thing: [`examples/backend/demo-server-python/demo_server.py`](../../examples/backend/demo-server-python/demo_server.py) (hub, `JwtAuth`, `StaticUserDirectory`, features, `create_all` in the lifespan, `CORSMiddleware` from `COMMS_CORS_ORIGINS`, the two `include_router` lines, and the dev token route). Explained in [`docs/example/backend-example.md`](../example/backend-example.md).

---

## 4. Step 3: Phone app (React Native / Expo)

Everything here is the short version of [`docs/mobile/03`](../mobile/03-using-running-and-deploying.md). Read its Metro and peer-dependency sections once; they are where most install problems come from.

### 4.1 Install the package

The package is TypeScript source (`mobile/package.json`: `main` = `src/index.ts`), named `commskit`, currently `private`.

| Option | How |
|---|---|
| Local link (what the example does) | In your app's `package.json`: `"commskit": "file:../comms-kit/mobile"`, then `npm install`. Needs the Metro config from `docs/mobile/03` ("Metro config"): `watchFolders`, one React, package exports on, optional peers allowed |
| Private registry | Rename to a scoped package, remove `"private": true`, publish: `docs/mobile/03` section 2, option B |
| Vendored copy | `docs/mobile/03` section 2, option C |

Then the peers for what you use (`docs/mobile/03` "Installing peers"):

| Mode | Peers |
|---|---|
| Headless chat (your own UI) | nothing beyond `react` and `react-native` (plus `expo-file-system` to upload) |
| Ready-made chat UI | `npx expo install react-native-safe-area-context @react-native-async-storage/async-storage expo-file-system react-native-gesture-handler expo-haptics expo-clipboard expo-video expo-audio expo-sharing expo-media-library expo-linear-gradient expo-image-picker expo-document-picker` |
| Calls | `npm install @stream-io/react-native-webrtc react-native-incall-manager` and `npx expo install expo-audio`, plus the `commskit` config plugin in `app.json` |
| Push | `npx expo install expo-notifications expo-device expo-application expo-constants` |

Metro and the peers were **not re-run for this guide**; I did not build an Expo app (no emulator here).

### 4.2 `CommsProvider` configuration

```tsx
import { consoleLogger, type CommsConfig } from "commskit/core";

const config: CommsConfig = {
  baseUrl: "https://api.example.com",
  getToken: () => auth.getToken(),        // YOUR login state
  getUserId: () => auth.getUserId(),
  logger: __DEV__ ? consoleLogger("[comms]") : undefined,
};
```

| Field | Type | What it is |
|---|---|---|
| `baseUrl` | `string` | REST base, with scheme and port, no path: `http://10.0.2.2:8000`, `https://api.example.com`. A trailing slash is trimmed. Must start with `http(s)://` or `ws(s)://`, otherwise the kit throws (`deriveWsUrl`) |
| `wsUrl` | `string`, optional | WebSocket base. If omitted it is derived: `https://x` -> `wss://x`, `http://x` -> `ws://x`; a `ws(s)://` value is kept. The kit appends `/ws/<token>` (the token is `encodeURIComponent`-encoded). Set it only if the socket lives on a different host than REST |
| `getToken` | `() => string \| null \| undefined \| Promise<...>` | Returns the JWT from your login. Called on **every connect and reconnect and every REST call**. Return `null` when logged out: the client goes to status `unauthenticated` and does not connect |
| `getUserId` | same shape | The current user's id string: the `uid` from Step 1. Used so the client knows which side is "me" (for example call events and the author of messages) |
| `logger` | `Logger`, optional | `consoleLogger("[comms]")` while integrating |

Verified in `mobile/src/core/config.ts` and `CommsClient.ts`. If the token source is asynchronous (secure storage), return a promise: the client awaits it.

### 4.3 The provider tree and minimal screens

Order: `CommsProvider` outermost (one socket for the whole app), then `ModerationProvider` (optional), `ChatProvider`, `CallProvider` (only when you use calls). Theme / appearance wrap all of it.

```tsx
// App.tsx - signed-in tree. Re-mount with a key so a new login gets a fresh socket and fresh stores.
import { useMemo } from "react";
import { Alert } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppearanceProvider } from "commskit/theme";
import { CommsProvider, type CommsConfig } from "commskit/core";
import { ChatProvider } from "commskit/chat";
import { ConversationListScreen, ChatScreen } from "commskit/chat-ui";

export function SignedIn({ session, navigation }) {              // session = { baseUrl, token, userId }
  const config = useMemo<CommsConfig>(
    () => ({ baseUrl: session.baseUrl, getToken: () => session.token, getUserId: () => session.userId }),
    [session],
  );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppearanceProvider storage={AsyncStorage}>
          <CommsProvider key={session.userId} config={config}>
            <ChatProvider onError={(e) => Alert.alert("Chat", e.message)}>
              <Navigation />
            </ChatProvider>
          </CommsProvider>
        </AppearanceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Inbox screen
<ConversationListScreen
  title="Chats"
  onOpenConversation={(peerId, c) => navigation.navigate("Chat", { peerId, chatId: c.chat_id ?? null })}
/>

// Chat screen (hide the navigator header: the kit screens draw their own)
<ChatScreen peerId={route.params.peerId} chatId={route.params.chatId ?? null} onBack={navigation.goBack} />
```

Names and props (`ConversationListScreen.onOpenConversation(peerId, conversation)`, `ChatScreen.peerId / chatId / onBack`) were checked in `mobile/src/chat-ui`. The full, richer tree (moderation, calls, notifications, navigation container) is in `docs/mobile/03` section 3 and [`examples/expo-app/src/Main.tsx`](../../examples/expo-app/src/Main.tsx). I did not compile this snippet.

**Chat only vs chat + calls.** Chat only: the tree above. Chat + calls: add `CallProvider` inside `ChatProvider` (`iceServers={turnCredentialsIceServers(config, { fallback: PUBLIC_STUN })}`), render `<CallOverlay />` next to the navigator and pass `onCall={(id) => startCall(id, { chatId, peerName })}` to `ChatScreen` (`docs/mobile/03` "Mode 3"). Calls need the native peers, a development build, and TURN on the server (Step 8).

### 4.4 Start a chat with someone

A person with no chat does not appear in the list. Create the chat from your own screens (a profile, a search result):

```tsx
import { useChat, useChatApi } from "commskit/chat";

function MessageButton({ userId, onOpened }) {                   // userId = the peer's id string
  const api = useChatApi();
  const chat = useChat();
  return (
    <Button title="Message" onPress={async () => {
      await api.startChat(userId);          // POST /chats/start?candidate_id=<id>  (get-or-create)
      chat.refresh();                       // re-request the list
      onOpened(userId);                     // navigate to the chat screen with peerId = userId
    }} />
  );
}
```

`POST /chats/start` answers `{chat_id, user1_id, user2_id, ...}` (verified). Starting a chat with yourself is `400 Cannot start a chat with yourself`. Sending the first message with `send_message` also creates the chat, so `startChat` is only needed to make an empty conversation appear.

### 4.5 Login and logout lifecycle

| Moment | Do |
|---|---|
| Login | Call your login, store the token (secure storage), then **mount** the provider tree. `autoConnect` opens the socket. If you keep the providers mounted, call `useComms().client.connect()` after login (or `reconnect()` after a token change) |
| New user on the same phone | Re-mount with `key={userId}` so the client and the chat stores are rebuilt |
| Token refresh | Make `getToken()` return the new token. The client calls it again on every reconnect |
| Logout | With push: `unregisterDevice()` **while the token is still valid**; then `useComms().client.disconnect()`; clear the stored token; unmount the tree. Details: `docs/mobile/03` "Login and logout lifecycle" |

If `getToken()` returns nothing at start, the status is `unauthenticated` and nothing connects until you call `connect()` after login.

### 4.6 Which base URL? (the part that goes wrong most often)

`localhost` on a phone or emulator means the phone itself, not your PC.

| Where the app runs | `baseUrl` | Also needed |
|---|---|---|
| Android emulator | `http://10.0.2.2:8000` (`10.0.2.2` is the emulator's alias for the host PC) | Cleartext HTTP allowed (below). Server reachable on `127.0.0.1` is enough |
| iOS simulator | `http://localhost:8000` | Same Mac. ATS allows `localhost`. **(not verified: no macOS here)** |
| Real phone on the same Wi-Fi | `http://<PC LAN IP>:8000` | Start uvicorn with `--host 0.0.0.0`; allow the port in the PC firewall (Windows: allow Python on Private networks); cleartext allowed |
| Production | `https://api.example.com` (the socket becomes `wss://api.example.com/ws/<token>`) | A TLS certificate; remove the cleartext settings below |

Find the PC's LAN IP: Windows `ipconfig` (IPv4 of the Wi-Fi adapter), macOS `ipconfig getifaddr en0`, Linux `hostname -I`. Test from the phone's **browser**: `http://<PC-IP>:8000/docs` (FastAPI's page) must load before you debug the app.

**Cleartext (`http://` and `ws://`) in development.** Android 9+ blocks it by default, iOS App Transport Security blocks it for non-localhost hosts. The example enables both in `app.json` (`examples/expo-app/app.json`); your app needs the same for local HTTP, and **must remove it for production**:

```json
{
  "expo": {
    "ios": { "infoPlist": { "NSAppTransportSecurity": { "NSAllowsArbitraryLoads": true } } },
    "plugins": [
      ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
    ]
  }
}
```

(After changing native config you need a new development build.) More: [`docs/mobile/02`](../mobile/02-keys-secrets-websockets-and-placeholders.md#cleartext-ws-for-local-development).

Further reading for this step: [`docs/mobile/01`](../mobile/01-overview.md), [`02`](../mobile/02-keys-secrets-websockets-and-placeholders.md), [`03`](../mobile/03-using-running-and-deploying.md); the runnable app: [`docs/example/mobile-example.md`](../example/mobile-example.md).

---

## 5. Step 4: Website (React)

Short version of [`docs/web/03`](../web/03-using-running-and-deploying.md).

### 5.1 Install and configure

`commskit-web` is built from the kit's `web/` folder; the build needs the sibling `mobile/src` (the shared engine is bundled in), so build from a full checkout:

```bash
cd comms-kit/web
npm install
npm run build        # creates dist/index.js, dist/index.d.ts, dist/styles.css
```

Then in your site's `package.json`: `"commskit-web": "file:../comms-kit/web"` (or `npm pack` / a registry: `docs/web/03` section 2), `npm install`, and make sure there is one copy of React (Vite: `resolve: { dedupe: ["react", "react-dom"] }`).

```tsx
// Chat.tsx
import { useMemo } from "react";
import { AppearanceProvider, ChatApp, CommsStack, type CommsConfig } from "commskit-web";
import "commskit-web/styles.css";                     // once, at your app entry

export default function Chat({ user }) {              // user = { id, chatToken } from YOUR login state
  const config = useMemo<CommsConfig>(
    () => ({
      baseUrl: API_BASE,                              // see 5.2
      getToken: () => user.chatToken,
      getUserId: () => user.id,
    }),
    [user],
  );
  return (
    <AppearanceProvider>
      <CommsStack key={user.id} config={config}>      {/* key: a different user rebuilds everything */}
        <div style={{ height: "100dvh" }}>            {/* ChatApp fills its parent: it needs a height */}
          <ChatApp />
        </div>
      </CommsStack>
    </AppearanceProvider>
  );
}
```

`CommsStack` = `CommsWebProvider` -> `ModerationProvider` -> `ChatProvider` (verified in `web/src/providers.tsx`); props `config`, `moderation` (default true), `onError`, `comms`, `chat`. `config` has the same four fields as on the phone (`baseUrl`, `wsUrl?`, `getToken`, `getUserId`); the rules of Step 3 section 4.2 apply: `getToken()` is called on each connect and REST call, `null` means logged out. `baseUrl` must be a full origin: an empty string is rejected, so use `window.location.origin` for same-origin.

Start a chat from a "Message" button exactly as on the phone (`useChatApi().startChat(id)`, then `useChat().refresh()`, then select the peer in `ChatApp selectedPeerId / onSelectedChange`). The working code is [`examples/web-app/src/App.tsx`](../../examples/web-app/src/App.tsx).

**Bundlers.** Vite, webpack 5, esbuild and Parcel: import normally (ESM only). Next.js: import from a `'use client'` file, or `next/dynamic(..., { ssr: false })` (`docs/web/03` "Bundlers, SSR and frameworks").

### 5.2 Same-origin proxy or CORS: choose one

The browser blocks a page from reading responses of another origin unless that server allows it (CORS). You have two ways to make the problem go away:

| | Same-origin proxy | CORS |
|---|---|---|
| Browser sees | one origin for page, REST and `/ws` | page on `https://app.example.com`, API on `https://api.example.com` |
| `baseUrl` | `window.location.origin` | `https://api.example.com` |
| Backend change | none | `CORSMiddleware` (Step 2, section 3.6) |
| Fits | you run a gateway or nginx, or use the Vite dev server | static hosting for the page (Vercel, Netlify, S3) |

**Vite dev proxy** (from [`examples/web-app/vite.config.ts`](../../examples/web-app/vite.config.ts); change the target and trim the path list to what your API uses):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.COMMS_SERVER || "http://localhost:8000";    // your FastAPI app
const paths = ["/auth", "/chats", "/moderation", "/devices", "/media", "/call"];
const proxy = {
  ...Object.fromEntries(paths.map((p) => [p, { target: server, changeOrigin: true }])),
  "/ws": { target: server, ws: true, changeOrigin: true },              // ws: true is what forwards the upgrade
};

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { proxy },
  preview: { proxy },
});
```

(The example proxies `/dev` for its demo token route; a real app proxies its own login path, here `/auth`.) With the proxy, `baseUrl: window.location.origin`, and the browser talks to `http://localhost:5173` only.

**nginx** (same-origin in production; from `docs/web/03` and `docs/backend/backend-python/02` B.6, **not run here**). It also keeps the token out of the access log:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# keep the token in /ws/<token> out of the logs
map $request_uri $loggable_uri { ~^/ws/ "/ws/[token]"; default $request_uri; }
log_format chat '$remote_addr [$time_local] "$request_method $loggable_uri" $status $body_bytes_sent';

server {
  listen 443 ssl http2;
  server_name app.example.com;
  access_log /var/log/nginx/app.access.log chat;

  root /var/www/app;                                   # the built site (dist/)
  location / { try_files $uri /index.html; }

  location ~ ^/(auth|chats|moderation|devices|media|call)(/|$) {
    proxy_pass http://127.0.0.1:8000;                  # FastAPI
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
    proxy_read_timeout 3600s;                          # default 60 s drops quiet sockets
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
```

**CORS** (the other choice): the `CORSMiddleware` block in section 3.6, with `allow_origins=["https://app.example.com"]`, then `baseUrl: "https://api.example.com"`. Every REST call from the package sends `Authorization` and, for POST, `Content-Type: application/json`, which triggers a preflight `OPTIONS`; the allowed headers must include both (verified in the preflight output in Step 5).

### 5.3 `ws://` or `wss://`, and mixed content

`wsUrl` is derived from `baseUrl`: an `https://` page with `baseUrl: "https://..."` gets `wss://`. An `https://` page may only open `wss://` sockets and fetch `https://` URLs; a `ws://` socket from an HTTPS page is blocked as **Mixed Content**. Plain `http://` and `ws://` are fine on `localhost` in development. Calls also need HTTPS (or `localhost`) for the microphone.

### 5.4 Where to keep the token (and why XSS matters)

Any script on your page can read what the page can read, so a cross-site-scripting (XSS) bug lets an attacker copy a stored token and act as the user until it expires.

| Storage | Verdict |
|---|---|
| JavaScript memory (your auth state) | Best default. Gone on reload: fetch a new chat token from your backend after login (the Option B endpoint in Step 1) |
| `sessionStorage` | Readable by scripts, cleared when the tab closes. What the example does. Fine for a demo |
| `localStorage` | Readable by scripts and long-lived. Avoid for tokens unless they are short-lived |
| `HttpOnly` cookie | JavaScript cannot read it, so `getToken()` cannot return it. Use it for your **site session**, and mint a short-lived chat token from it: `getToken: async () => (await fetch("/api/chat-token", { credentials: "include" })).json().then(r => r.token)`. Cache the result for its lifetime, because `getToken()` is called on every REST call |

The token is also in the WebSocket URL, so it can end up in proxy and server access logs (verified: uvicorn's access log prints the full `/ws/<token>`). Use short lifetimes and redact (Step 7). The secret itself never goes to the browser: only the token does.

Further reading: [`docs/web/01`](../web/01-overview.md), [`02`](../web/02-keys-secrets-websockets-and-placeholders.md), [`03`](../web/03-using-running-and-deploying.md); the runnable site: [`docs/example/web-example.md`](../example/web-example.md).

---

## 6. Step 5: Verify the connection

Work down this ladder. **Each rung proves one more link of the chain; stop at the first one that fails** and fix it before going on. Rungs a to e use no frontend at all.

I ran rungs a to e against the `main.py` of Step 2 (in a fresh venv created with the install line above, on port 8765 with an empty SQLite file). The outputs below are the real ones, except that the token text and timestamps differ every run. In the commands, `$BASE` / `BASE` is `http://127.0.0.1:8000`.

```powershell
$BASE = "http://127.0.0.1:8000"          # PowerShell
```

```bash
BASE=http://127.0.0.1:8000               # bash
```

### Rung a: the server is up

```bash
curl -s -o /dev/null -w "%{http_code}\n" $BASE/openapi.json
```

```powershell
(Invoke-WebRequest "$BASE/openapi.json" -UseBasicParsing).StatusCode
```

Expected: `200`. Open `http://127.0.0.1:8000/docs` to see the routes. You should see `/chats/start`, `/chats/send`, `/chats/read`, `/chats/{user_id}`, `/chats/{chat_id}/messages`, `/chats/{chat_id}/read`, `/chats/{user_id}/unread-count`, `/chats/{user_id}/online-status` and your own `/auth/login` (verified). The WebSocket route `/ws/{token}` is **not** listed there (OpenAPI has no WebSockets). If `/chats/...` is missing, `hub.rest_router()` was included before the features were installed, or the feature is not installed.

### Rung b: get a token from YOUR login

```bash
curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" -d '{"username":"alice","password":"pw-alice"}'
```

```powershell
$r = Invoke-RestMethod -Method Post -Uri "$BASE/auth/login" -ContentType "application/json" -Body '{"username":"alice","password":"pw-alice"}'
$r | ConvertTo-Json
$TOKEN = $r.token
```

Expected (the token differs):

```json
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiIxMDAxIiwiaWF0Ijox...","user_id":"1001"}
```

Keep the token in a variable (bash: `TOKEN=$(curl ... | python -c "import sys,json;print(json.load(sys.stdin)['token'])")`) and decode it (section 2.2, `decode_token.py`). You must see your user id under `uid`:

```
{'uid': '1001', 'iat': 1793085433, 'exp': 1793089033}
```

A wrong password gives `401 {"detail":"Wrong username or password"}` (your own login's message). If the payload has no `uid`, or the id is not the string your database uses, fix the login before going on.

### Rung c: REST with the token

```bash
curl -s -w "  [%{http_code}]\n" $BASE/chats/1001 -H "Authorization: Bearer $TOKEN"     # expect [] [200]
curl -s -w "  [%{http_code}]\n" $BASE/chats/1001                                       # no token
curl -s -w "  [%{http_code}]\n" $BASE/chats/1001 -H "Authorization: Bearer not-a-token"
curl -s -w "  [%{http_code}]\n" $BASE/chats/1002 -H "Authorization: Bearer $TOKEN"     # someone else's list
```

```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
$x = Invoke-WebRequest "$BASE/chats/1001" -Headers $h -UseBasicParsing; "$($x.StatusCode) $($x.Content)"
try { Invoke-WebRequest "$BASE/chats/1001" -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

Expected, in that order:

```
[]  [200]
{"detail":"Not authenticated"}  [401]
{"detail":"Invalid token"}  [401]
{"detail":"Not allowed"}  [403]
```

PowerShell: `200 []`, then `401`. (`Invoke-RestMethod` on an empty list prints nothing, because PowerShell unrolls `[]`; use `Invoke-WebRequest` to see the status and body.) `200 []` means: the token is valid, the secret/algorithm/claim match, the database tables exist, and `1001` is the user the kit sees. **`401 Invalid token`** means the secret, algorithm, claim, `aud`, or expiry does not match (section 2.1). **`500`** with `no such table: chats` in the server log means the tables were not created (verified).

### Rung d: the WebSocket handshake and one frame

Install the two helpers into the same venv: `pip install websockets httpx` (they are already there if you installed `uvicorn[standard]` and `httpx` in Step 2). Save the script as `ws_check.py`. Change `login()` if your login differs, and the two user ids to match your database. It checks the bad token, one request/response, and (rung e) a message between two users:

```python
# ws_check.py - rungs d and e:  python ws_check.py http://127.0.0.1:8000
import asyncio, json, sys
import httpx
import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
WS = BASE.replace("https://", "wss://").replace("http://", "ws://")


def login(username: str, password: str) -> str:
    r = httpx.post(f"{BASE}/auth/login", json={"username": username, "password": password})
    r.raise_for_status()
    return r.json()["token"]


async def wait_for(ws, wanted: str, timeout: float = 5.0) -> dict:
    async def loop():
        async for raw in ws:
            frame = json.loads(raw)
            print("   <-", frame["type"])
            if frame["type"] == wanted:
                return frame
    return await asyncio.wait_for(loop(), timeout)


async def main() -> None:
    alice, bob = login("alice", "pw-alice"), login("bob", "pw-bob")

    print("d1: bad token")
    try:
        async with websockets.connect(f"{WS}/ws/not-a-token") as ws:
            await ws.recv()
    except websockets.ConnectionClosed as exc:
        print(f"   closed code={exc.rcvd.code} reason={exc.rcvd.reason!r}")

    print("d2: good token, req_users -> res_users")
    async with websockets.connect(f"{WS}/ws/{alice}") as ws:
        await ws.send(json.dumps({"type": "req_users"}))
        frame = await wait_for(ws, "res_users")
        print("   users:", frame["users"])

    print("e: alice -> bob")
    async with websockets.connect(f"{WS}/ws/{alice}") as a, websockets.connect(f"{WS}/ws/{bob}") as b:
        await a.send(json.dumps({"type": "send_message", "candidate_user_id": "1002", "content": "hello bob"}))
        sent = await wait_for(a, "message_sent")
        got = await wait_for(b, "new_message")
        m = got["message"]
        print("   alice sees:", {k: sent["message"][k] for k in ("sender_id", "content", "sender_type", "is_delivered")})
        print("   bob sees:  ", {k: m[k] for k in ("sender_id", "content", "sender_type", "chat_id")})
        await b.send(json.dumps({"type": "mark_read", "chat_id": m["chat_id"]}))
        await wait_for(a, "messages_read")


asyncio.run(main())
```

```bash
python ws_check.py http://127.0.0.1:8000
```

```powershell
python ws_check.py http://127.0.0.1:8000
```

Expected (real output; rung d is the first two blocks):

```
d1: bad token
   closed code=1008 reason='Invalid token'
d2: good token, req_users -> res_users
   <- res_users
   users: []
e: alice -> bob
   <- message_sent
   <- new_message
   alice sees: {'sender_id': '1001', 'content': 'hello bob', 'sender_type': 'user', 'is_delivered': True}
   bob sees:   {'sender_id': '1001', 'content': 'hello bob', 'sender_type': 'other', 'chat_id': 1}
   <- messages_read
```

- `d1` shows the handshake works (the connection is **accepted**) and a bad token is closed with **1008** `Invalid token`. If `websockets.connect` itself fails with an HTTP 404 or 403, the WebSocket route is not reachable: the router is not included, uvicorn has no WebSocket library (`No supported WebSocket library detected` in its log; verified: the handshake then answers 404), or a proxy is in the way.
- `d2` proves the token reaches the kit, the user is registered, a database session works, and a frame goes both ways. `users: []` is right while nobody has chatted yet.

**Browser console or Node 22 variant** (verified in Node 22.23.2 as an `.mjs` file; in Chrome's devtools console it works too, with the CORS rules of section 5.2 if you paste it on another origin):

```js
const base = "http://127.0.0.1:8000";
const { token } = await (await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alice", password: "pw-alice" }) })).json();
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/${token}`);
ws.onopen = () => { console.log("open"); ws.send(JSON.stringify({ type: "req_users" })); };
ws.onmessage = (e) => console.log("frame:", JSON.parse(e.data).type);
ws.onclose = (e) => console.log("close", e.code, e.reason);
new WebSocket(`${base.replace(/^http/, "ws")}/ws/nope`).onclose = (e) => console.log("bad token -> close", e.code, e.reason);
```

Output: `open`, `bad token -> close 1008 Invalid token`, `frame: res_users`.

### Rung e: two users chatting end to end

That is the `e:` block above. What it proves: the same id strings are used on both sides (`candidate_user_id: "1002"` reached Bob, whose token says `uid: 1002`), the message is saved, `message_sent` goes to the sender (`sender_type: "user"`, `is_delivered: true` because Bob had a socket), `new_message` goes to the recipient (`sender_type: "other"`), and `mark_read` becomes `messages_read` for the sender (the read tick).

Now check the REST list from Rung c again; it shows the conversation, with the **name** from your `UserDirectory`:

```
[{"id":1,"other_user":{"id":"1002","username":"Bob","avatar":null},"last_message":{"content":"hello bob","sender_id":"1001", ... "is_read":true,"is_delivered":true},"unread_count":0,"updated_at":"..."}]
```

If `username` is `"1002"` instead of `Bob`, the directory returns nothing for that id (the id strings do not match what the directory is keyed by).

### Rung f: the same from the real frontend

1. Phone: set `baseUrl` per the table in section 4.6, log in as user A on one device (or emulator) and user B on another device or in the website.
2. Turn on `logger: consoleLogger("[comms]")`. You should see the socket open. In the UI, `useConnectionStatus()` goes `connecting` -> `open`. Status `reconnecting` with `lastCloseCode: 1008` = token rejected; `unauthenticated` = `getToken()` returned nothing.
3. Start a chat (`startChat(otherId)`), send a message from A. It appears on B instantly, with a delivered tick on A. B opens the chat, and A's tick turns to read.
4. Kill the server and start it again: the status shows `reconnecting`, then returns to `open` by itself (backoff 1 s, 2 s, 4 s ... 30 s, then `getToken()` is called again on each attempt).

### Rung g: the browser's Network tab

Open devtools, Network, reload the page while signed in:

| What to look at | Expected |
|---|---|
| Filter **WS**: one request `ws://.../ws/<token>` (or `wss://`) | Status `101 Switching Protocols`. The **Messages** tab lists frames; send a message and watch `send_message` go up and `message_sent` / `new_message` come down. A bad token also shows 101 and then the connection ends: the server accepts first, then closes with 1008 (this is on purpose, section 2.1) |
| Scheme of that URL | `wss://` on an HTTPS page. `ws://` on an HTTPS page = blocked (mixed content) |
| REST calls, e.g. `GET /chats/<your id>`, `POST /chats/start?candidate_id=...` | `200`; **Request Headers** contain `Authorization: Bearer eyJ...` |
| Cross-origin setup only: an `OPTIONS` request just before the first REST call | `200` with `access-control-allow-origin: <your page origin>` (verified with curl above). A red `(blocked:cors)` request means section 3.6 |
| Same-origin proxy setup | No `OPTIONS` requests; every URL has the page's own origin |
| Console | No `Mixed Content`, no `blocked by CORS policy` |

---

## 7. Step 6: What happens on the wire

Full contract: [`docs/archive/PROTOCOL.md`](../archive/PROTOCOL.md) (wire protocol v1). Short version of the two flows you will meet first.

**One message**

```
 Alice's app                          kit backend                          Bob's app
 -----------                          -----------                          ---------
 POST /auth/login (YOUR code)  --->   token { uid: "1001" }
 getToken() -> token
 open wss://host/ws/<token>    --->   accept, validate (else close 1008)
                                      register socket, presence -> partners get user_status
 {type:"req_users"}            --->   res_users {users:[...]}       <---  (Bob did the same)
 {type:"send_message",
  candidate_user_id:"1002",
  content:"hi"}                --->   save in `messages`
                                      message_sent {message}  ---> back to Alice (sender_type "user",
                                                                   is_delivered true/false)
                                      new_message {message}  ------------------------------>  Bob (sender_type "other")
                                      (Bob has no socket? push via PushSender; delivery_status
                                       is sent to Alice when Bob connects later)
                                                             <------  {type:"mark_read", chat_id}
 messages_read {chat_id, read_by} <--                        (read tick); Bob's other devices get chat_read
 {type:"typing", target_user_id, is_typing}  --->  typing_status {user_id, chat_id, is_typing} ---> Bob
```

**One call setup** (only with `CallFeature`)

```
 Caller                               kit backend                           Receiver
 call_initiate {receiver_id,call_type} -->  busy check, CallPolicy.authorize, create `calls` row
 call_initiated  <-----------------------                                  incoming_call {caller_name, ...} -->
 call_ringing    <----- (receiver socket got it; else a push is sent: incoming_call, channel call_ringtone)
 sdp_offer {call_id, sdp}  ------------->  relayed  ------------------------------------------------->
                                                               <---- answer_call {call_id}, sdp_answer {call_id, sdp}
 sdp_answer / call_answered <------------  relayed
 ice_candidate  <---------------------------------- both directions, relayed ---------------------------------->
 end_call {call_id}  ------------------->  call_ended {end_reason, duration_seconds} to both; call_log in the chat
 timers: ring timeout 45 s -> call_missed; socket loss: ringing 20 s, answered 90 s -> ended "disconnected"
```

Every frame is a JSON object with a string `type`. Bad JSON gets `{"type":"error","error":"Invalid JSON"}` (verified), a message to yourself gets `{"type":"error","error":"Cannot send a message to yourself."}` (verified), and unknown types are ignored. The server only talks to sockets: a message is **saved first**, so an offline recipient gets it from the history (`GET /chats/<chat_id>/messages`) and a push, and `delivery_status` once connected.

---

## 8. Step 7: Going to production

Details and the full checklists are in [`docs/backend/backend-python/03`](../backend/backend-python/03-using-running-and-deploying.md) sections 4 to 6 and [`02`](../backend/backend-python/02-keys-secrets-websockets-and-placeholders.md).

| Topic | What to do |
|---|---|
| HTTPS / WSS | Terminate TLS at nginx or your load balancer. Clients then use `https://api.example.com` and the derived `wss://.../ws/<token>`. Remove the cleartext settings from the phone app. Browsers refuse the microphone (calls) on plain HTTP except on `localhost` |
| Secrets from the environment | `JWT_SECRET`, `TURN_SECRET`, database URL, Redis URL, push keys: from environment variables or a secret manager. Never in code, `app.json`, `eas.json`, `EXPO_PUBLIC_*` or `VITE_*` variables. Use at least 32 random bytes for the JWT secret. Rotating it logs everybody out |
| Token lifetime and refresh | The kit checks the token **only when the socket connects** (and on every REST call). Choose a lifetime (for example 15 to 60 minutes) and make `getToken()` return a fresh token before it expires. When an expired token is used, REST answers 401 and the socket is closed with 1008; the client keeps reconnecting (1 s up to 30 s) and calls `getToken()` each time, so a refreshed token heals it. REST calls do not refresh by themselves: they send whatever `getToken()` returns |
| Proxy idle timeout | At least **120 s** on every proxy and load balancer in front of `/ws/` (AWS ALB defaults to 60 s). nginx: `proxy_read_timeout 3600s`. uvicorn sends WebSocket protocol pings every 20 s by default, but do not rely on that alone; you can also set `pingIntervalMs` (for example `25000`) on the client provider |
| Access-log redaction | The token is in the URL path and uvicorn's access log prints it (verified). Run `uvicorn --no-access-log` or redact `/ws/<token>` in your own logging, and use the `log_format` of the nginx block above |
| Several workers or servers | Without Redis, **run exactly one worker**: sockets, presence and rate limits live in process memory, so a user on another worker looks offline. With Redis: install the `redis` extra (`pip install -e "<path to comms-kit>/backend/backend-python[redis]"`), then build the hub like this and keep `await hub.connections.start()` in the lifespan (already in `main.py`). No sticky sessions needed. **(Not run: no Redis available here.)**

```python
from commskit.core import ConnectionManager, RedisRateLimiter
from commskit.core.redis_bridge import RedisBridge

bridge = RedisBridge(url=os.environ["REDIS_URL"])
hub = CommsHub(auth=..., session_factory=SessionLocal, users=...,
               connections=ConnectionManager(bridge=bridge), rate_limiter=RedisRateLimiter(bridge))
``` |
| TURN for calls | Run coturn with `use-auth-secret`, give the same secret to `CallConfig(turn_secret=..., turn_uris=[...])`. Without TURN, calls fail across mobile data and strict NATs (`docs/backend/backend-python/03` section 4.7) |
| Rate limits | Defaults: 20 messages / 10 s, 5 uploads / 60 s, typing 5 / 5 s, 5 call attempts / 60 s per user (`ChatConfig`, `CallConfig.initiate_rate`). Tune with `ChatConfig(message_rate=RateLimit(...))`. Errors: `{"type":"error","code":"rate_limited","retry_after":...}` on the socket, REST 429 |
| Database | Use PostgreSQL: `postgresql+asyncpg://user:pass@host/db` with `pip install asyncpg`, `create_async_engine(url, pool_pre_ping=True)`. SQLite is for development (single writer; see the "database is locked" row). Each incoming frame opens one session, so size the pool for concurrent frames. Use migrations, not `create_all` |
| File storage | `ChatFeature()` defaults to `LocalDiskStorage("comms_media")`, which is **not served** by itself: mount it (`app.mount("/media", StaticFiles(directory=...))`) or use `S3Storage(bucket, region=...)` (`pip install -e ".[s3]"`; `commskit.core.s3`). Media URLs are relative to the API unless S3 gives full ones; the website can set `mediaBaseUrl` |
| Never ship | The demo server, `/dev/token/...`, the demo secret `local-demo-secret-change-me-0000`, cleartext traffic |

---

## 9. Step 8: Optional extras

### 9.1 Push notifications and device registration

Backend: `DevicesFeature` mounts `POST /devices`, `DELETE /devices/{device_id}` and the legacy `POST /chats/expo/push/token[/remove]`. A push sender sends to offline users. Install `[push]` (and `[apns]` for iOS CallKit).

```python
from commskit.core.devices import DevicesFeature, SqlDeviceRegistry
from commskit.core.push import ApnsVoipSender, DevicePushRouter, ExpoPushSender

devices = SqlDeviceRegistry(SessionLocal)
push = DevicePushRouter(devices, expo=ExpoPushSender(access_token=os.getenv("EXPO_ACCESS_TOKEN")),
                        voip=ApnsVoipSender.from_env(), android_call_style="data")
hub = CommsHub(auth=..., session_factory=SessionLocal, users=..., push=push)   # push= goes on the hub
DevicesFeature(devices).install(hub)       # do NOT also pass devices= to ChatFeature (see Troubleshooting)
# lifespan shutdown: await push.aclose()
```

Phone app (after login and on every app start; tokens can rotate): `registerDevice({ config, deviceId, appVersion, projectId })` from `commskit/notifications` posts to `/devices`; on logout `unregisterDevice()` **before** you drop the token. A real device is needed for tokens (the simulator returns `not_a_device`). Docs: `backend/backend-python/README.md` ("Devices and push notifications"), `docs/mobile/03` "Mode 3". The website has no push yet (`docs/web/02` B5). Not run here (no device, no Expo account).

### 9.2 Calls

Backend: `CallFeature` + `CallConfig(turn_secret, turn_uris)` (section 3.4). Phone: `CallProvider`, `CallOverlay`, `startCall(peerId)`, `turnCredentialsIceServers(config, { fallback: PUBLIC_STUN })` (which calls `POST /call/turn-credentials`), the `commskit` config plugin for the microphone permission, a development build, and optional CallKit / full-screen notifications from `commskit/call-native`. The website has no call UI (`ChatApp chat={{ onCall }}` can hook your own). Docs: `docs/mobile/03` "Mode 2" and "Mode 3".

### 9.3 Moderation (block and report)

```python
from commskit.integration import link_moderation
from commskit.moderation import ModerationFeature

async def on_report(report) -> None:                       # runs in the background; errors are logged
    await email_moderators(report.id, report.reporter_id, report.reported_id, report.reason)

chat = ChatFeature().install(hub)                          # keep the return value: link_moderation needs it
moderation = ModerationFeature(on_report=on_report).install(hub)
link_moderation(moderation, chat=chat)                     # also call=call when calls are installed
```

Verified: this wiring built an app with `GET/POST /moderation/blocks`, `DELETE /moderation/blocks/{blocked_id}` and `POST /moderation/reports`. The frontends already speak it (`ModerationProvider`, `useBlocking()`; the chat screens show the menu). Admin review needs `admin_dependency=` (your own FastAPI dependency): README "Admin report review".

### 9.4 Blocking and credit rules through policies

A policy is where **your** rules say "these two may (not) talk" or "this call costs a credit". Pass them to the features:

```python
class MyChatPolicy:
    refusal_message = "You cannot message this user."
    async def can_message(self, session, sender_id, recipient_id) -> bool:
        return await my_rules.may_chat(session, sender_id, recipient_id)        # your tables
    async def block_status(self, session, viewer_id, other_ids):
        return {}                          # {other_id: (is_blocked, blocked_by_other)}
    async def extra_conversation_info(self, session, viewer_id, other_id):
        return {}

ChatFeature(policy=MyChatPolicy()).install(hub)
```

Call policy: `CallFeature(policy=MyCallPolicy(), ...)` with `async authorize(self, session, caller_id, receiver_id, message) -> CallDecision` returning `CallDecision.allow()` or `CallDecision.deny("Not enough credits.", status=402, info={...})`; the phone shows it through `onCallError(err, retry)` with `err.kind === "policy"`. Snippets from `docs/backend/backend-python/03` section 2.8; **not run here**. With moderation, the block list runs first and your policy second.

---

## 10. Troubleshooting by symptom

"Verified" means I reproduced the symptom or read the exact line of code; otherwise the cause comes from the kit's docs or general behaviour.

| # | Symptom | Likely cause | Fix |
|---|---|---|---|
| 1 | REST `401 {"detail":"Not authenticated"}` | No `Authorization: Bearer <token>` header (or an empty one). The frontend's `getToken()` returned nothing (verified) | Send the header; make `getToken()` return the token after login |
| 2 | REST `401 {"detail":"Invalid token"}` | Wrong secret, algorithm, claim name, `aud` present, expired, `iat`/`nbf` in the future (clock skew), or an adapter that raised (all verified, section 2.1) | Decode the token (section 2.2). Make `JwtAuth(secret, algorithm, claim)` match your login. For `aud`, write an adapter |
| 3 | REST `403 {"detail":"Not allowed"}` on `GET /chats/<id>` or `/chats/<id>/unread-count` | The id in the path is not the token's user. Usually `getUserId()` or the code that builds the URL uses a different spelling (`1001` vs `U1`) (verified) | Use the exact `uid` string. Fix the id source on the frontend |
| 4 | WebSocket opens, then closes with `1008` "Invalid token" | Same causes as row 2. The client keeps retrying (status `reconnecting`, `lastCloseCode: 1008`) (verified) | Rungs b to d of the ladder |
| 5 | Browser console: "blocked by CORS policy" / failed `OPTIONS` | Page and API on different origins and the origin is not in `allow_origins` (exact scheme + host + port, no trailing slash); or `Authorization` / `Content-Type` missing from `allow_headers`; a non-listed origin gets `400 Disallowed CORS origin` (verified) | Section 3.6, or the same-origin proxy (section 5.2). A server **crash (500)** also shows up as a CORS error because the error response has no CORS headers (general Starlette behaviour, not re-verified): check the server log first |
| 6 | "WebSocket connection failed" / 404 / 400 at the handshake, behind nginx | The proxy does not forward `Upgrade` / `Connection` on `/ws/`, or `/ws/` is not routed to the app. Or the app itself has no WebSocket library: uvicorn logs `No supported WebSocket library detected` and answers 404 (verified) | nginx block in section 5.2 (`proxy_http_version 1.1`, `Upgrade`, `Connection`); `pip install "uvicorn[standard]"`; test the app directly on its port first |
| 7 | The socket drops about every 60 s behind a proxy | Proxy idle timeout (nginx default `proxy_read_timeout` 60 s; AWS ALB 60 s) | `proxy_read_timeout 3600s`; load balancer idle timeout at least 120 s; optionally `pingIntervalMs` on the client |
| 8 | "Mixed Content: ... insecure WebSocket" | HTTPS page opening `ws://` (for example `baseUrl` or `wsUrl` set to `http://`) | `baseUrl: "https://..."` (derives `wss://`), or `wsUrl: "wss://..."` |
| 9 | Works on the Android emulator but not on a real phone | `baseUrl` is still `http://10.0.2.2:8000` (emulator only); or uvicorn is bound to `127.0.0.1` (its default); or the PC firewall blocks the port; or cleartext is not enabled | LAN IP in `baseUrl`; `--host 0.0.0.0`; allow the port; check `http://<PC-IP>:8000/docs` in the phone's browser; section 4.6 |
| 10 | "Network request failed" on Android (login or REST) | Cleartext HTTP blocked (`usesCleartextTraffic` missing, needs a **new dev build**), wrong host (`localhost` = the phone), server not reachable | Section 4.6; test with the phone browser |
| 11 | Chat list is empty although messages exist | (a) No chat exists yet: the list only shows chats that exist, create one with `startChat` or a first message (verified: `[]` until the first message). (b) Ids differ: the frontend uses other peer ids than the token's `uid` (the chat was created for different strings). (c) Wrong user: `GET /chats/<id>` is 403 for ids that are not yours (verified) | Compare, in the database, `chats.user1_id/user2_id` with the `uid` values; use one spelling everywhere (section 2.4) |
| 12 | Chat list shows ids ("1002") instead of names | No `UserDirectory`, or it returns nothing for that id (verified: falls back to the id; the socket falls back to "Someone") | Section 3.5; the dictionary keys must be the same id strings |
| 13 | Messages appear only after a reload / pull-to-refresh | The socket is not open, so live frames never arrive (the lists are only requested again when the socket opens): check the status (`reconnecting`?) and the WS entry in the Network tab. Or a proxy buffers (`proxy_buffering off` on `/ws/`). Or several workers without Redis: the recipient's socket is on another worker (documented) | Fix the connection first; `proxy_buffering off`; one worker or Redis |
| 14 | A second browser tab / second device sees nothing | Both are signed in as the **same user**: a message to yourself is refused (`Cannot send a message to yourself.`, and `POST /chats/start` to yourself is 400; both verified). Or the second login overwrote the first's token in shared `localStorage`. Or the tabs point at different servers | Use two different users (private window or another browser profile); keep the token in memory/`sessionStorage` per tab |
| 15 | Expired-token loop: status flips `reconnecting` every few seconds, REST gives 401 | `getToken()` keeps returning the same expired token. The client retries forever (backoff up to 30 s) and does not stop on 1008 | Refresh the token inside `getToken()` (or call your refresh endpoint there); log out when refresh fails |
| 16 | Duplicate routes: `POST /chats/expo/push/token` twice in the router | `ChatFeature(devices=registry)` installed **before** `DevicesFeature(registry)`: both mount the legacy routes (verified: 2 copies). Installed in the other order, chat skips its copy (1 copy). With no `devices=` on `ChatFeature`, always 1 | Don't pass `devices=` to `ChatFeature` when you use `DevicesFeature`; if you must, install `DevicesFeature` first |
| 17 | `/chats/...` or `/call/...` return 404 although the feature is installed | `hub.rest_router()` was included **before** the feature was installed (`rest_router()` only collects the features installed so far), or the feature is not installed (call-only app has no `/chats`, verified) | Install, link, then include the routers (section 3.2) |
| 18 | `500` and `no such table: chats` (`OperationalError`) in the log; socket frames answer `Message processing failed: ...` | The tables were not created: `create_all` not run, wrong database file, or the feature modules not imported before `create_all` (verified: 500 without `create_all`) | Run `CommsBase.metadata.create_all` after importing `commskit.chat` / `call` / `moderation` / `core.devices`, or use migrations |
| 19 | `database is locked` (SQLite) | SQLite allows one writer; concurrent frames and your own writes collide (message not reproduced here) | Development: `create_async_engine(url, connect_args={"timeout": 30})` (what the demo does). Production: PostgreSQL |
| 20 | Users on different workers do not receive each other's messages, wrong online status, calls only ring by push | Several uvicorn workers or servers **without** `RedisBridge` (documented in `docs/backend/backend-python/02` B.5) | Run one worker, or configure `ConnectionManager(bridge=RedisBridge(url=...))` and `RedisRateLimiter(bridge)` |
| 21 | Calls ring but there is no audio / one-way audio, or it works only on Wi-Fi | No TURN: `POST /call/turn-credentials` answers 503 when `CallConfig.turn_secret` is unset (verified in code) and the client falls back to public STUN | Run coturn, set `turn_secret` / `turn_uris` (section 8) |
| 22 | Calls silent: microphone prompt never appears (website) or "Microphone access is blocked" | Browsers allow the microphone only on HTTPS or `localhost`; the phone needs the `microphonePermission` plugin option and the OS permission (documented) | Serve over HTTPS (a tunnel for LAN tests); set the plugin option; re-allow in settings |
| 23 | Opaque-session users never connect on the WebSocket, REST works | The session id contains `/` (or other characters that cannot sit in a URL path): the route `/ws/{token}` does not match (verified with TestClient) | Issue URL-safe tokens (`secrets.token_urlsafe(32)`) or use a JWT |
| 24 | Tokens appear in the server log | uvicorn's access log prints `"WebSocket /ws/<token>"` (verified) | `--no-access-log`, and redaction in nginx (section 5.2) |
| 25 | Tokens rejected right after login on a multi-server setup | The login server's clock is ahead: `iat` is in the future for the chat server ("not yet valid (iat)", verified) | Sync clocks (NTP); or issue `iat` slightly in the past |
| 26 | "Invalid hook call" / `useComms() must be used inside <CommsProvider>` | Two copies of React (a linked package) or components outside the providers | Mobile: Metro `blockList` + `nodeModulesPaths`; web: `resolve.dedupe`; check the tree order (`docs/mobile/03`, `docs/web/03` troubleshooting) |
| 27 | Web: blank page or a thin strip | The parent of `ChatApp` has no height | Give it `height: 100dvh` |

---

## 11. Connection checklist and where to read next

Copy this into your ticket:

```
BACKEND
- [ ] commskit installed in the API's venv; uvicorn[standard] (WebSocket library) installed
- [ ] JWT_SECRET comes from the environment, 32+ bytes, same value for login and JwtAuth
- [ ] The login token has the claim `uid` = the user's id as a string (decoded and checked)
- [ ] No `aud` claim (or a custom AuthAdapter handles it); token has an `exp`
- [ ] CommsHub(auth, session_factory, users=UserDirectory) created; features installed BEFORE the routers
- [ ] CommsBase.metadata.create_all (or migrations) ran; no table-name clash with chats / messages / calls
- [ ] hub.ws_router() and hub.rest_router() included in the app
- [ ] Website on another origin: CORSMiddleware with the exact origin (or a same-origin proxy)
- [ ] Single worker, or RedisBridge configured
FRONTEND
- [ ] baseUrl correct for where the app runs (10.0.2.2 / localhost / LAN IP / https host)
- [ ] getToken() returns the token (and refreshes it); getUserId() returns the same uid string
- [ ] Peer ids passed to startChat / ChatScreen / startCall are the same style of ids
- [ ] Provider tree mounted after login, re-mounted with a key per user, disconnect on logout
- [ ] Dev only: cleartext allowed (Android + iOS); removed for production
- [ ] Website: commskit-web/styles.css imported; ChatApp inside a parent with a height
VERIFY
- [ ] a. GET /openapi.json -> 200
- [ ] b. login -> token whose payload has uid
- [ ] c. GET /chats/<uid> with token -> 200 []; without -> 401; other user's id -> 403
- [ ] d. WebSocket with a bad token -> close 1008; with a good token req_users -> res_users
- [ ] e. two users: send_message -> message_sent + new_message; mark_read -> messages_read
- [ ] f. the same from the real app (status goes to `open`)
- [ ] g. browser Network tab: WS 101 on wss://, REST 200 with Authorization, no CORS/mixed-content errors
PRODUCTION
- [ ] HTTPS/WSS; proxy idle timeout >= 120 s; /ws/<token> redacted from logs
- [ ] Token lifetime chosen; getToken() refreshes; secrets not in the client bundle
- [ ] PostgreSQL, migrations, media storage (S3 or served disk), TURN for calls, push keys
- [ ] Demo server, /dev/token and the demo secret are not deployed
```

Where to read next (all links relative to this file):

| Topic | Read |
|---|---|
| The Python backend, in depth | [01 overview](../backend/backend-python/01-overview.md) · [02 keys, secrets, WebSockets](../backend/backend-python/02-keys-secrets-websockets-and-placeholders.md) · [03 using, running, deploying](../backend/backend-python/03-using-running-and-deploying.md) · [backend README](../../backend/backend-python/README.md) |
| The phone app | [01](../mobile/01-overview.md) · [02](../mobile/02-keys-secrets-websockets-and-placeholders.md) · [03](../mobile/03-using-running-and-deploying.md) · [mobile README](../../mobile/README.md) |
| The website | [01](../web/01-overview.md) · [02](../web/02-keys-secrets-websockets-and-placeholders.md) · [03](../web/03-using-running-and-deploying.md) · [web README](../../web/README.md) |
| Working examples | [demo server (Python)](../example/backend-example.md) · [`demo_server.py`](../../examples/backend/demo-server-python/demo_server.py) · [Expo app](../example/mobile-example.md) · [web app](../example/web-example.md) |
| The exact messages | [`docs/archive/PROTOCOL.md`](../archive/PROTOCOL.md) |

---

## 12. Appendix: what was verified, and how

All runs were on Windows 10, Python 3.12.10, PyJWT 2.15.1, FastAPI 0.162.0, SQLAlchemy 2.1.6, uvicorn 0.54.0, websockets 17.3, Node 22.23.2, against the kit as checked out on 2026-10-27. Scratch files lived in a temporary folder and were deleted afterwards.

| What | How | Result |
|---|---|---|
| `main.py` (section 3.3) | Fresh venv, `pip install -e <backend-python> "uvicorn[standard]" aiosqlite httpx`, `uvicorn main:app` on port 8765, empty SQLite file | Starts; tables created |
| Rung a to c | `curl` and PowerShell (`Invoke-RestMethod`, `Invoke-WebRequest`) | Outputs as printed above |
| Rung d, e | `ws_check.py` (section 6) with `websockets` and `httpx`; the same flow in Node 22 with the global `WebSocket` | Outputs as printed above |
| CORS | `curl` preflight `OPTIONS` with allowed and disallowed `Origin` | 200 with the headers shown; `400 Disallowed CORS origin` |
| Token rules (section 2.1, 2.3) | `JwtAuth` called directly and over the wire: good, int uid, no `exp`, expired, wrong secret, `sub` instead of `uid`, `aud`, HS512, empty uid, future `nbf`/`iat`, `claim="sub"` with int `sub`, RS256 with a generated key pair; an open socket after expiry | Results as stated in the tables |
| Custom adapters | `AudJwtAuth` and `SessionTokenAuth` in tiny apps with Starlette's `TestClient` (SQLite) | Valid sessions 200, expired/unknown 401 on REST and 1008 on the socket; `/` in the token never matched the route |
| Modes | Call-only app (`/call/turn-credentials` 200, `/chats` 404); chat + call + moderation + devices (route list) | As stated |
| Duplicate routes | Counted routes of `hub` for the three install orders | 2 / 1 / 1 as in row 16 |
| Symptoms | App without `create_all` (500, `no such table: chats`); `uvicorn --ws none` (handshake 404 + warning); uvicorn access log content | As in rows 6, 18, 24 |

**Not verified:** anything on a phone or emulator (Expo/Metro build, `10.0.2.2`, cleartext flags, push, calls, CallKit); iOS in any form; the Vite proxy and nginx snippets and the website itself in a browser (I used Node and `curl`, not devtools); Redis and multi-worker behaviour; PostgreSQL; the git-subdirectory pip URL; `database is locked` itself; TURN / coturn; Alembic; Next.js; a CORS error produced by a 500 response. Where the text says "documented", the statement comes from the kit's own docs and was not re-run.
