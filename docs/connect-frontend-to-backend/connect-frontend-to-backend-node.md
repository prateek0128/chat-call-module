# Connect a frontend to the commskit Node backend (`commskit-node`)

A start-to-finish guide for a developer (or tech lead) who already has a **Node project with its own login** and an **existing frontend**, a React Native / Expo phone app and/or a React website, and wants chat (and optionally calls) from the kit.
The Python twin of this guide is [connect-frontend-to-backend-python.md](connect-frontend-to-backend-python.md).

Status and how this was checked (2026-10-27, Windows, Node 22.23.2, npm 10.9.4, SQLite, Fastify 4.29, Express 4.22):

- **Run for real:** a scratch host app built only from the snippets in this guide, in a temp folder outside the repo, installing `commskit-node` from an `npm pack` tarball. The Fastify, Express and plain `node:http` variants each answered login, REST, WebSocket (good token, bad token, wrong path) and a two-user chat. Every "expected output" in step 5 was copied from those runs.
- **Also run:** the JWT rules (section 3.1), the custom auth adapters (3.4), CORS for Express, Fastify and plain `node:http`, a Node reverse proxy (`http-proxy-middleware`), the three feature modes, and the pitfalls in the troubleshooting table that are marked "reproduced".
- **Not run:** anything on a phone or emulator, a browser, nginx, TLS, PostgreSQL, Redis, TURN, push services. Those parts are marked **not verified**. The React Native and React snippets were checked against the kit source (names, props, signatures), not executed.

## Table of contents

- [0. At a glance](#0-at-a-glance)
- [1. Prerequisites](#1-prerequisites)
- [2. Step 1: The token contract](#2-step-1-the-token-contract)
- [3. Step 2: The backend](#3-step-2-the-backend)
- [4. Step 3: The phone app (React Native / Expo)](#4-step-3-the-phone-app-react-native--expo)
- [5. Step 4: The website (React)](#5-step-4-the-website-react)
- [6. Step 5: Verify the connection](#6-step-5-verify-the-connection)
- [7. Step 6: What happens on the wire](#7-step-6-what-happens-on-the-wire)
- [8. Step 7: Going to production](#8-step-7-going-to-production)
- [9. Step 8: Optional features](#9-step-8-optional-features)
- [10. Troubleshooting by symptom](#10-troubleshooting-by-symptom)
- [11. Connection checklist and where to read next](#11-connection-checklist-and-where-to-read-next)

Section numbers and step numbers differ by one on purpose: "Step 1" is section 2, and so on.

---

## 0. At a glance

The kit does **not** have its own login. Your login stays as it is. The only link between your login and the kit is a **token**: a signed JWT that contains the user's id in a claim named `uid`. The kit client sends that token, `commskit-node` checks it with the same secret, and from then on it knows who is talking.

```
 PHONE APP / WEBSITE                  YOUR NODE BACKEND (one process)
 -------------------                  -----------------------------------------------
 1. user types name+password  ---->   YOUR existing  POST /auth/login
                                        - checks the password (your code)
                                        - signs a JWT:  { "uid": "101", "exp": ... }
                              <----     with JWT_SECRET (HS256)  --> returns { token, userId }
 2. app stores token + userId
    (SecureStore / memory)
 3. <CommsProvider config={{
      baseUrl, getToken, getUserId }}>
        |
        |  REST   GET https://host/chats/101
        |         Authorization: Bearer <token> ---->  commskit-node  hub.authenticate()
        |                                                JwtAuth(JWT_SECRET) -> uid "101"
        |                                                path id must equal uid, else 403
        |
        |  WS     wss://host/ws/<token>  ------------>  hub.attach(server) / commskitPlugin
        |                                                accept first, then check the token
        |                                                bad token -> close code 1008
        |         {"type":"send_message",
        |          "candidate_user_id":"102", ...} --->  saved in the database (Kysely),
        |                                                delivered to user "102" if online,
        |  <---- {"type":"message_sent", ...}            pushed (Expo) if not
 4. user "102" gets {"type":"new_message", ...} on their own socket
```

### What must match on both sides

| Thing | Backend side | Frontend side | If it differs |
|---|---|---|---|
| JWT secret | `new JwtAuth(process.env.JWT_SECRET)` | not needed (the browser/phone never sees the secret) | WS closes 1008, REST 401 `Invalid token` |
| Algorithm | `HS256` by default (`JwtAuth` option `algorithm`) | n/a | `"alg" (Algorithm) Header Parameter value not allowed`, same symptoms |
| Claim name | `uid` by default (`claim` option) | n/a | `Token has no 'uid' claim`, same symptoms |
| Token lifetime | your `exp`; checked only when connecting and on each REST call | `getToken()` must return a **fresh** token every time it is called | reconnect loop with 1008 / 401 |
| Base URL | where the HTTP server listens | `baseUrl: "https://api.example.com"` (no path to `/ws`) | "Network request failed", CORS errors |
| WebSocket URL | path is exactly `/ws/<token>` | `wsUrl` derived from `baseUrl` (`http` to `ws`, `https` to `wss`) or set by hand | socket never opens (1006), or hangs |
| User-id strings | `uid` claim value, **and** the ids you pass as the other person (`candidate_user_id`, `candidate_id`, `UserDirectory` keys, `/chats/<uid>`) | `getUserId()` and every `peerId` / `startChat(id)` | empty chat list, 403 `Not allowed` |
| Allowed origin (web only) | CORS allow-list, or a same-origin proxy | the origin the page is served from, e.g. `https://app.example.com` | browser blocks REST ("CORS error"). The WebSocket is **not** subject to CORS and the kit does not check `Origin` on it |
| Protocol version | wire protocol v1 ([PROTOCOL.md](../archive/PROTOCOL.md)); the code has no version field or negotiation (searched `backend-node/src`, `mobile/src`, `web/src`) | same v1 | n/a: backend and clients ship from one repo, keep them from the same checkout |

**The id rule in one sentence:** the string in the `uid` claim is the user's identity everywhere. Whatever id your frontend passes as "the other person" must be the `uid` that person's own token will carry. Numbers are converted to strings (`101` becomes `"101"`), so `101` and `"101"` match, but `"101"` and `"U101"` do not.

---

## 1. Prerequisites

| Need | Detail |
|---|---|
| Node.js **20 or newer** | `engines.node ">=20"`. Checked with 22.23.2 |
| An ESM-capable project | `commskit-node` is **ESM only**. Use `"type": "module"` (the snippets here are `.mjs`/ESM). From CommonJS use `await import("commskit-node/core")`. `require("commskit-node/core")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` (reproduced) |
| A database through **Kysely** | `better-sqlite3` for development (`npm install better-sqlite3@11`), `pg` for production. You create the `Kysely` instance, so install `kysely` yourself. Pin it: `kysely@^0.27.4` (an unpinned `npm install kysely` gave 0.29.7 here, next to the kit's own 0.27.6, so two copies of Kysely were installed) |
| Your own login | Any login that knows the user's id. You only add "sign a JWT with `uid`" to it (step 1) |
| A web framework (optional) | Fastify `^4.28 || ^5`, Express `^4.19 || ^5`, or none (`node:http`) |
| For the phone app | Node + Expo (SDK 53 or newer; the kit relies on package `exports`), a phone or emulator |
| For the website | React 18+ and a bundler (Vite is what the example uses) |
| A way for the frontend to reach the server | Same machine (`localhost`), same Wi-Fi (LAN IP), or a public HTTPS host |
| **`commskit-node` is not published to npm** | Install it from a folder or tarball. The package is built output: run `npm run build` in `backend/backend-node` first (`dist/` is git-ignored) |

Layout you need on disk (a checkout of the kit next to your project):

```
comms-kit/
  backend/backend-node/     package commskit-node   (build it once: npm install && npm run build)
  mobile/                   package commskit        (React Native / Expo, TypeScript source, no build)
  web/                      package commskit-web    (React, needs: npm install && npm run build)
  examples/backend/demo-server-node/server.mjs      the shortest complete wiring (dev only)
my-project/                 YOUR existing project
```

---

## 2. Step 1: The token contract

### 2.1 What the kit checks, exactly

Read from `backend/backend-node/src/core/{adapters,hub,websocket}.ts`, then confirmed with a probe script against the built package.

| Question | Answer |
|---|---|
| Where does the token come from? | WebSocket: the URL path `/ws/<token>` (URL-encoded, the query string is ignored). REST: header `Authorization: Bearer <token>` (case-insensitive `Bearer`) |
| Default verification | `new JwtAuth(secret)`: **HS256**, claim **`uid`**, via the `jose` library |
| Which claims are validated? | The signature, and `exp` / `nbf` **if present**. A token **without `exp`** is accepted forever. `aud` and `iss` are **not** checked: a token with an `aud` is accepted (unlike the Python backend) |
| User id | `String(payload.uid)`. A number becomes a string. Missing or empty gives `Token has no 'uid' claim` |
| Secret length | Any non-empty string works (a 3-character secret was accepted). An empty secret throws `JwtAuth needs a non-empty secret` when you build the hub. Use 32+ random characters anyway |
| Other algorithms | `new JwtAuth(secret, { algorithm: "HS512" })` works. `alg: none` and a different algorithm than configured are rejected. `JwtAuth` only does HMAC (shared secret): for RS256 / public keys write an adapter (2.4) |
| REST failure | `401 {"detail":"Not authenticated"}` (no header) or `401 {"detail":"Invalid token"}` (bad, expired, no claim) |
| REST wrong user | `403 {"detail":"Not allowed"}` when `/chats/<id>` or `/chats/<id>/unread-count` uses an id other than the token's `uid` |
| WebSocket failure | The server **accepts the upgrade first**, then checks the token, then closes with code **1008** and reason `Invalid token`. A client therefore always sees an `open` event followed by `close 1008`, never an HTTP 401 |
| Expiry on an open socket | The token is checked **only at connect time**. A socket stays open after its token expires (reproduced: REST gave 401 five seconds later, the socket stayed open; a new socket with the same token was closed with 1008) |
| Where is the reason logged? | `WS auth failed: <reason>` at *info* level, which the default logger does not print. Pass `logger: { info: console.log, warn: console.warn, error: console.error }` to `CommsHub` while integrating (the snippets below do) |

### 2.2 Issue a compatible token from your existing login

Put the contract in **one file** so the secret, algorithm and claim live in one place. Install `jose` (`npm install jose@^5`). The 3.x snippets import this file.

```js
// auth.mjs - the ONE place that knows the token contract. Your existing login calls issueToken().
import { SignJWT } from "jose";

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error("Set JWT_SECRET to a random string of at least 32 characters");
export const SECRET = secret;
const key = new TextEncoder().encode(secret);

/** userId = the id string your database uses for this user (users.id). It becomes the `uid` claim. */
export function issueToken(userId, ttl = "1h") {
  return new SignJWT({ uid: String(userId) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}

// Stand-in for your existing user table + password check. Replace with your own code.
export const USERS = {
  "101": { name: "Alice", password: "alice-pw", avatar: null },
  "102": { name: "Bob", password: "bob-pw", avatar: null },
};
export async function login(username, password) {
  const id = Object.keys(USERS).find((i) => USERS[i].name.toLowerCase() === String(username).toLowerCase());
  if (!id || USERS[id].password !== password) return null;
  return { token: await issueToken(id), userId: id, name: USERS[id].name };
}
```

In your real login route, keep your own password check and replace the stand-in with one call: `const token = await issueToken(user.id);` and return `{ token, userId: String(user.id) }`. The route has to return **both** values, because the frontend needs `getToken` and `getUserId`.

Generate a secret once: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (works in PowerShell and bash). Keep it in an environment variable or a secret manager, never in the frontend.

### 2.3 If your tokens already look different

| Your situation | What to do |
|---|---|
| HS256 but the user id is in `sub` (or `userId`, `id`...) | `new JwtAuth(secret, { claim: "sub" })` (verified with `claim: "sub"`) |
| HS512 / HS384 | `new JwtAuth(secret, { algorithm: "HS512" })` (verified) |
| Your tokens have `aud`/`iss` | Accepted as they are. If you *want* them checked, write an adapter (2.4) |
| RS256/ES256 (public key), a JWKS URL, or an identity provider | Custom adapter (2.4) |
| Opaque session ids or a cookie-style token | Custom adapter that looks the token up (2.4) |
| Your login issues tokens that never expire | Add an `exp` (1 hour, then refresh). The kit accepts tokens without one, which is a security hole |

### 2.4 Custom auth adapters

Anything with `userIdFromToken(token)` (sync or async) works. Throw to reject; any exception means "invalid" (401 on REST, 1008 on the WebSocket). Both examples below were run.

```js
import { importSPKI, jwtVerify } from "jose";
import { AuthError } from "commskit-node/core";

// A) RS256 public-key tokens (your identity service signs, the kit only verifies)
const PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY_PEM; // "-----BEGIN PUBLIC KEY-----..."
export class PublicKeyAuth {
  #key;
  async userIdFromToken(token) {
    this.#key ??= await importSPKI(PUBLIC_KEY_PEM, "RS256");
    const { payload } = await jwtVerify(token, this.#key, {
      algorithms: ["RS256"], audience: "my-api", issuer: "my-issuer", // now actually checked
    });
    if (!payload.sub) throw new AuthError("no sub claim");
    return String(payload.sub);
  }
}

// B) Opaque session tokens kept by your login (here a Map; use your session store)
export class SessionAuth {
  constructor(sessions) { this.sessions = sessions; } // token -> { userId, expires }
  async userIdFromToken(token) {
    const s = this.sessions.get(token);
    if (!s || s.expires < Date.now()) throw new AuthError("unknown or expired session");
    return String(s.userId);
  }
}
// new CommsHub({ auth: new PublicKeyAuth(), db })   or   new CommsHub({ auth: new SessionAuth(sessions), db })
```

Notes: with opaque tokens every REST call and every WebSocket connect calls your store, so keep it fast. The token is placed in a URL path, so it should only contain URL-safe characters (the kit's clients `encodeURIComponent` it and the server decodes it, so most strings survive, but a JWT or a hex/base64url string is the safe choice).

To protect **your own** routes with the same check you can call `await hub.authenticate(request.headers)`; it throws an `HttpError` 401 for a missing or bad header (a sample of your own route was not run).

### 2.5 The same-id-strings rule

Pick one id format for the whole system (usually your `users.id` as a string) and use it in four places:

1. the `uid` claim (step 1),
2. your `UserDirectory` keys (names and photos, 3.7),
3. the frontend's `getUserId()`,
4. every id the frontend passes as the other person: `startChat(id)`, `peerId` props, `candidate_user_id` in frames.

Mixing formats (`"101"` in the token, `"U101"` in the contact list) is the number one cause of "connected, but the list is empty" (section 10).

---

## 3. Step 2: The backend

### 3.1 Install

`commskit-node` is not on npm. Build it once, then install from a folder or a tarball. The fuller version of this, with Docker/CI advice, is in [../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md) (section 2.1).

**Tarball (recommended; this is what the verification used):**

```powershell
# PowerShell, from the folder that holds comms-kit and my-project
cd comms-kit\backend\backend-node
npm install
npm run build
npm pack --pack-destination ..\..\..\my-project\vendor      # creates commskit-node-0.1.0.tgz (69 files, only dist/)
cd ..\..\..\my-project
npm install .\vendor\commskit-node-0.1.0.tgz kysely@^0.27.4 jose@^5 better-sqlite3@11
```

```bash
# bash
cd comms-kit/backend/backend-node && npm install && npm run build && npm pack --pack-destination ../../../my-project/vendor
cd ../../../my-project
npm install ./vendor/commskit-node-0.1.0.tgz kysely@^0.27.4 jose@^5 better-sqlite3@11
```

**Local folder (symlink, good while you also change the kit):** `npm install ../comms-kit/backend/backend-node kysely@^0.27.4 jose@^5 better-sqlite3@11`. Rebuild after each kit change. Folder installs do not hoist the kit's own dependencies (reported in file 3), so install `kysely` and `jose` yourself, as above.

Peer packages, install what you use:

| Package | When |
|---|---|
| `better-sqlite3@11` | SQLite (development, small single-server use) |
| `pg` | PostgreSQL (production) |
| `fastify` or `express` | the adapter you choose (neither for plain `node:http`) |
| `ws` | already a dependency of the kit; install it in your project only if **you** import it (the check scripts in step 5 do) |
| `ioredis`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `sharp` | Redis (several processes), S3 files, image thumbnails |

### 3.2 Import map (what comes from where)

| Import | You get |
|---|---|
| `commskit-node` | `ensureSchema`, `KIT_TABLES`, plus everything from `/core` and `/chat` |
| `commskit-node/core` | `CommsHub`, `JwtAuth`, `AuthError`, `StaticUserDirectory`, `NullUserDirectory`, `LocalDiskStorage`, `ConnectionManager`, `RateLimit`, `restListener`, `HttpError`, types `AuthAdapter`, `UserDirectory`, `Db` |
| `commskit-node/chat` | `ChatFeature`, `AllowAllChatPolicy`, type `ChatPolicy` |
| `commskit-node/call` | `CallFeature`, `AllowAllCallPolicy`, `allow`, `deny`, type `CallPolicy` |
| `commskit-node/moderation` | `ModerationFeature` |
| `commskit-node/integration` | `linkChatAndCall`, `linkModeration`, `deleteUserEverywhere` |
| `commskit-node/push` | `DevicesFeature`, `SqlDeviceRegistry`, `DevicePushRouter`, `ExpoPushSender`, `ApnsVoipSender` |
| `commskit-node/redis` | `RedisBridge`, `RedisRateLimiter` |
| `commskit-node/s3` | `S3Storage` |
| `commskit-node/fastify` | `commskitPlugin` |
| `commskit-node/express` | `commskitRouter`, `attach` |

Only these subpaths exist. Importing `commskit-node/src/...` or `commskit-node/dist/...` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### 3.3 Build the hub: chat only, call only, or both

One file, `comms.mjs`, imported by whichever server file you pick in 3.4. `ensureSchema` creates the kit's tables (`chats`, `messages`, `calls`, `comms_devices`, `comms_blocks`, `comms_reports`, `comms_message_hidden`, `comms_chat_cleared`) if missing, on every start, safely. The three modes differ only in the `hub.install(...)` lines.

> **Table names:** `chats`, `messages` and `calls` have no prefix. If your project already has tables with those names, `CREATE TABLE IF NOT EXISTS` silently skips them and the kit breaks on the different columns. Check before you start (or use a separate database/schema).

```js
// comms.mjs - builds the commskit hub. Imported by the server file.
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureSchema } from "commskit-node";
import { CommsHub, JwtAuth, LocalDiskStorage } from "commskit-node/core";
import { ChatFeature } from "commskit-node/chat";
import { CallFeature } from "commskit-node/call";
import { linkChatAndCall } from "commskit-node/integration";
import { SECRET, USERS } from "./auth.mjs";

const sqlite = new Database(process.env.SQLITE_PATH ?? "comms.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 30000");
export const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
await ensureSchema(db); // idempotent: creates the kit tables if missing

// Names and photos shown in chat lists (keys are the same ids that go into `uid`).
const users = {
  async getProfiles(ids) {
    const out = {};
    for (const id of ids) if (USERS[id]) out[id] = { name: USERS[id].name, avatar: USERS[id].avatar };
    return out;
  },
};

export const hub = new CommsHub({
  auth: new JwtAuth(SECRET, { algorithm: "HS256", claim: "uid" }),
  db,
  users,
  logger: { info: console.log, warn: console.warn, error: console.error },
});
export const chat = hub.install(new ChatFeature({ storage: new LocalDiskStorage("comms_media", "/media") }));
export const call = hub.install(new CallFeature());
linkChatAndCall(chat, call);
await hub.connections.start(); // only matters with a RedisBridge; harmless otherwise
```

| Mode | Install lines | Result (checked with `GET /chats/101`, `POST /call/turn-credentials`, `POST /devices`, `GET /moderation/blocks`) |
|---|---|---|
| **Chat only** | `hub.install(new ChatFeature())` | `/chats/...` 200; `/call/...` 404 |
| **Call only** | `hub.install(new CallFeature())` | `/chats/...` 404; `/call/turn-credentials` 503 until `turnSecret` is set. Call frames then carry `chat_id: null` |
| **Both** | the file above (`ChatFeature`, `CallFeature`, `linkChatAndCall(chat, call)`) | adds the `[Call ...]` entries and `call_log` messages to the chat |
| Plus devices, push, moderation | see 9.1 and 9.3 | `/devices` 422 without a body (route exists), `/moderation/blocks` 200 |

Rules for the order (all enforced by how the code works):

1. Create the hub, then **install features, then link them, then register the adapter** (`app.register(commskitPlugin...)`, `app.use(commskitRouter(hub))`, `restListener(hub)`). The adapters take a snapshot of the routes at that moment, so a feature installed later has no REST routes (its WebSocket frames still work).
2. If you use `DevicesFeature` (9.1), install it **before** `ChatFeature`. Otherwise both mount `POST /chats/expo/push/token`: with Fastify, startup fails with `FST_ERR_DUPLICATED_ROUTE Method 'POST' already declared for route '/chats/expo/push/token'` (reproduced). Do not also pass `devices:` to `ChatFeature`.
3. Installing the same feature twice throws `Feature 'chat' is already installed on this hub`.
4. `linkChatAndCall` / `linkModeration` can be called once each, after the features are installed.

### 3.4 Three hosting variants (each one was run)

All three assume `auth.mjs` and `comms.mjs` from above and read `PORT` (default 8080). Each includes a stand-in for **your existing login route**; in a real project you add only the two commskit lines marked `// commskit` to your existing server.

**A. Fastify**

```js
// server-fastify.mjs
import Fastify from "fastify";
import { commskitPlugin } from "commskit-node/fastify";
import { login } from "./auth.mjs";
import { hub } from "./comms.mjs";

const app = Fastify({ logger: false });

// YOUR existing login route (stand-in). It must return the token your frontend will store.
app.post("/auth/login", async (req, reply) => {
  const { username, password } = req.body ?? {};
  const session = await login(username, password);
  return session ?? reply.code(401).send({ detail: "Bad credentials" });
});

await app.register(commskitPlugin, { hub }); // commskit: REST routes + /ws/<token>; closes the hub on app.close()
// Hardening: close upgrades for any other path (see 3.9).
app.server.on("upgrade", (req, socket) => { if (!hub.matchesWs(req.url)) socket.destroy(); }); // commskit
await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
console.log("listening (fastify)");
```

`commskitPlugin` replaces Fastify's `application/json` parser (inside the scope it is registered in) with a more tolerant one: a JSON content-type with an empty body is allowed, as in the Python backend. If you define your own JSON content-type parser, check that the two do not collide (not tested). The default Fastify host is `localhost`; `0.0.0.0` makes it reachable from a phone.

**B. Express**

```js
// server-express.mjs
import { createServer } from "node:http";
import express from "express";
import { attach, commskitRouter } from "commskit-node/express";
import { login } from "./auth.mjs";
import { hub } from "./comms.mjs";

const app = express();

// YOUR existing login route (stand-in). express.json() only for your own routes.
app.post("/auth/login", express.json(), async (req, res) => {
  const { username, password } = req.body ?? {};
  const session = await login(username, password);
  session ? res.json(session) : res.status(401).json({ detail: "Bad credentials" });
});

app.use(commskitRouter(hub)); // commskit: /chats/..., /call/..., ... (it has its own JSON parser)
const server = createServer(app);
attach(server, hub); // commskit: the /ws/<token> upgrade
// Hardening: close upgrades for any other path (see 3.9).
server.on("upgrade", (req, socket) => { if (!hub.matchesWs(req.url)) socket.destroy(); });
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log("listening (express)"));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await hub.shutdown(); // closes sockets, cancels call timers, stops the Redis bridge
    server.close(() => process.exit(0));
  });
}
```

`commskitRouter` mounts routes at the root (`/chats/...`), so use `app.use(commskitRouter(hub))`, not `app.use("/api", ...)`; if you want a prefix, put a proxy in front (5.3). A host-wide `app.use(express.json())` placed **before** the kit router also works (reproduced). Your own routes with the same path patterns (for example `GET /chats/:id`) placed before the kit router will shadow the kit.

**C. Plain `node:http` (no framework)**

```js
// server-http.mjs
import { createServer } from "node:http";
import { restListener } from "commskit-node/core";
import { login } from "./auth.mjs";
import { hub } from "./comms.mjs";

const rest = restListener(hub); // commskit: resolves to true when a kit route answered the request
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/auth/login") { // YOUR existing login route (stand-in)
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { username, password } = JSON.parse(raw || "{}");
    const session = await login(username, password);
    return session ? json(res, 200, session) : json(res, 401, { detail: "Bad credentials" });
  }
  if (await rest(req, res)) return; // commskit
  json(res, 404, { detail: "Not Found" });
});
hub.attach(server); // commskit: the /ws/<token> upgrade
// Hardening: close upgrades for any other path (see 3.9).
server.on("upgrade", (req, socket) => { if (!hub.matchesWs(req.url)) socket.destroy(); });

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log("listening (node:http)"));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await hub.shutdown();
    server.close(() => process.exit(0));
  });
}
```

`restListener(hub)` returns `false` when no kit route matched, so you can serve your own routes after it. This is the same shape as `examples/backend/demo-server-node/server.mjs` (which adds a token-for-anyone endpoint, a static demo page and `/media`; **never** deploy that file).

Start any of them:

```powershell
$env:JWT_SECRET = "0123456789abcdef0123456789abcdef"   # dummy value for local tests; use a real random secret
$env:PORT = "8080"
node server-fastify.mjs          # or server-express.mjs / server-http.mjs
```

```bash
JWT_SECRET=0123456789abcdef0123456789abcdef PORT=8080 node server-fastify.mjs
```

TypeScript works the same: use `.ts`, `"module": "ESNext"`, `"moduleResolution": "Bundler"` (or `Node16`/`NodeNext`), top-level `await` needs `target ES2022`.

### 3.5 Routes the kit adds

| Route | Auth | Purpose |
|---|---|---|
| `WS /ws/<token>` | token in path | the one realtime socket |
| `POST /chats/start?candidate_id=<id>` | Bearer | get or create the 1:1 chat |
| `POST /chats/send`, `POST /chats/read` | Bearer | send / mark read over REST |
| `GET /chats/<uid>` | Bearer, `<uid>` must be you | conversation list |
| `GET /chats/<chatId>/messages?limit=&offset=` | Bearer | one page of messages |
| `POST /chats/<chatId>/read`, `GET /chats/<uid>/unread-count`, `GET /chats/<id>/online-status` | Bearer | read state, unread badge, presence |
| `POST /call/turn-credentials`, `POST /call/<callId>/reject` | Bearer | TURN credentials; decline from a notification |
| `GET/POST /moderation/blocks`, `DELETE /moderation/blocks/<id>`, `POST /moderation/reports` (+ `/moderation/admin/...`) | Bearer | block and report |
| `POST /devices`, `DELETE /devices/<deviceId>` | Bearer | register a push device |

If you put a reverse proxy in front, these prefixes must be forwarded: `/chats`, `/call`, `/moderation`, `/devices`, `/media` (only if you serve files from there), and `/ws`.

### 3.6 WebSocket path and what a proxy must allow

The path is exactly `/ws/<token>`: one segment after `/ws/`, no trailing slash, no extra prefix. A proxy that serves the API under a prefix (`/api/ws/<token>`) must strip the prefix before forwarding. The proxy must forward the HTTP/1.1 `Upgrade` and `Connection: upgrade` headers and must not close idle connections early (section 8). Details and an nginx example: [../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md](../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md) section B.6 and 5.3 below.

### 3.7 Names and photos: `UserDirectory`

Without it, the chat list shows the other person's **id** as their name and no avatar. `comms.mjs` above passes an object with `getProfiles(ids)`; return `{ [id]: { name, avatar } }` and leave out ids you do not know. In a real app this reads your `users` table (one query with `WHERE id IN (...)`). `StaticUserDirectory` is for tests. If your function throws, the kit logs it and falls back to ids, so a broken directory looks like "names are numbers".

### 3.8 CORS for a separately hosted website

Needed only when the page and the API have **different origins** (for example `https://app.example.com` and `https://api.example.com`, or `http://localhost:5173` and `http://localhost:8080` in development). Phone apps do not use CORS. If you use a same-origin proxy (5.3) you can skip this. The WebSocket is not covered by CORS and needs nothing.

All three below were run with a preflight (`OPTIONS` with `Access-Control-Request-Method: POST` and `Access-Control-Request-Headers: authorization,content-type`): an allowed origin got `204` plus `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Headers` and `Access-Control-Max-Age: 600`; another origin got no `Access-Control-Allow-Origin`; a `401` response from the kit also carried the allow header (so the browser shows the real 401, not a CORS error).

```js
// Express: npm install cors     (put it BEFORE your routes and before commskitRouter)
import cors from "cors";
app.use(cors({
  origin: ["http://localhost:5173", "https://app.example.com"], // explicit list; never "*" for an API that uses tokens
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 600,
}));
```

```js
// Fastify: npm install @fastify/cors@9   (@fastify/cors 9 is for Fastify 4; use 10+ for Fastify 5). Register BEFORE commskitPlugin
import cors from "@fastify/cors";
await app.register(cors, {
  origin: ["http://localhost:5173", "https://app.example.com"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 600,
});
```

```js
// Plain node:http: a hand-written responder (the demo server does the same, driven by COMMS_CORS_ORIGINS)
const ALLOWED = (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);

/** Returns true when the request was a preflight and has been answered. Call first in your request handler. */
export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
// in createServer(async (req, res) => { if (applyCors(req, res)) return; ... })
```

### 3.9 Hardening: a wrong-path upgrade can crash a bare Node server

`hub.attach(server)` only handles upgrades for `/ws/<token>`. Any other upgrade request (for example `GET /nope` with `Upgrade: websocket`) is left to "other listeners". If nobody handles it, the socket just **hangs** with no response (the `ws` client shows `socket hang up` after its timeout), and if that client then resets the connection, Node emits an unhandled `ECONNRESET` on the socket and **the whole process exits** (reproduced on the plain `node:http` server and on Fastify; the three server files above contain the guard that prevents it):

```js
server.on("upgrade", (req, socket) => { if (!hub.matchesWs(req.url)) socket.destroy(); }); // Fastify: app.server.on(...)
```

With the guard, a wrong-path upgrade is closed at once and the server stays up (reproduced on all three variants). If you have your own WebSocket endpoints on the same server, replace the guard with a router that handles *your* paths and destroys the rest.

---

## 4. Step 3: The phone app (React Native / Expo)

This section was checked against `mobile/src` and `mobile/README.md`; it was **not run** on a device. Full guide: [../mobile/03-using-running-and-deploying.md](../mobile/03-using-running-and-deploying.md); config values and secrets: [../mobile/02-keys-secrets-websockets-and-placeholders.md](../mobile/02-keys-secrets-websockets-and-placeholders.md); a complete working app: `examples/expo-app` ([../example/mobile-example.md](../example/mobile-example.md)).

### 4.1 Install

The package `commskit` (in `mobile/`) is TypeScript source, private, and not on npm. Metro compiles it like your own code.

```jsonc
// your app's package.json
"dependencies": {
  "commskit": "file:../comms-kit/mobile"
}
```

Then `npm install`. With a `file:` link also add the kit folder to Metro's `watchFolders` if your Metro does not follow symlinks (see the mobile README, "Install"). Registry and vendored-copy options: [../mobile/03-using-running-and-deploying.md](../mobile/03-using-running-and-deploying.md) section 2.

Peers depend on what you use (install with `npx expo install` so versions match your SDK):

| You want | Install |
|---|---|
| Chat, headless (your own screens) | nothing beyond `react` / `react-native` (add `expo-file-system` to send pictures/files with the default reader) |
| Chat with the ready-made screens (`commskit/chat-ui`) | `npx expo install react-native-safe-area-context @react-native-async-storage/async-storage expo-file-system react-native-gesture-handler` (more optional polish in file 03) |
| Push | `npx expo install expo-notifications expo-device` |
| Calls | `npm install @stream-io/react-native-webrtc react-native-incall-manager` and `npx expo install expo-audio`, plus the config plugin (`"plugins": ["commskit"]`) and a **dev build** (not Expo Go) |

### 4.2 `CommsProvider` configuration

```ts
import type { CommsConfig } from "commskit/core";
```

| Field | Type | Meaning |
|---|---|---|
| `baseUrl` | `string` | REST base, `https://api.example.com` (trailing slash is trimmed). Must start with `http(s)://` or `ws(s)://`, otherwise the client throws `baseUrl must start with http(s):// or ws(s)://` |
| `wsUrl` | `string?` | Socket base. Left out, it is derived from `baseUrl`: `https://x` becomes `wss://x`, `http://x` becomes `ws://x`. The socket URL is `${wsUrl}/ws/${encodeURIComponent(token)}` |
| `getToken` | `() => string \| null \| Promise<...>` | The JWT from **your** login. Called on **every** connect, reconnect and REST call. Return `null` when logged out: the status becomes `unauthenticated` and nothing reconnects |
| `getUserId` | `() => string \| null \| Promise<...>` | The current user's id: the same string as the token's `uid` (2.5). Called on every connect |
| `logger` | `Logger?` | `consoleLogger("[comms]")` while integrating |

`CommsProvider` also takes `autoConnect` (default true; set false and call `useComms().client.connect()` after login) and `pingIntervalMs` (default **0 = no client pings**; the server sends none either, so set `pingIntervalMs={25000}` when a proxy may close quiet sockets, section 8).

### 4.3 Provider tree and a minimal chat

Order: `CommsProvider` (one socket) outermost, then `ChatProvider`, then `CallProvider` if you use calls. Theme wraps the whole thing. The session below is your existing login result, kept in your own auth store.

```tsx
// App.tsx  (chat only, ready-made screens)
import React, { useMemo } from "react";
import { CommsProvider, consoleLogger, type CommsConfig } from "commskit/core";
import { ChatProvider } from "commskit/chat";
import { ThemeProvider } from "commskit/theme";
import { ChatScreen, ConversationListScreen } from "commskit/chat-ui";
import { useAuth } from "./auth"; // YOUR login state: { token, userId } | null, signIn(), signOut()

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:8080"; // see 4.6

export default function App() {
  const { session } = useAuth();
  const config = useMemo<CommsConfig | null>(
    () =>
      session && {
        baseUrl: API_URL,
        getToken: () => session.token,   // refresh here if it expires (section 8)
        getUserId: () => session.userId, // same string as the token's `uid`
        logger: __DEV__ ? consoleLogger("[comms]") : undefined,
      },
    [session],
  );
  if (!session || !config) return <YourLoginScreen />;

  return (
    <ThemeProvider>
      {/* key = user: logging in as someone else gets a clean socket and clean stores */}
      <CommsProvider key={session.userId} config={config}>
        <ChatProvider onError={(e) => console.warn("chat error", e.message)}>
          <YourNavigation />
        </ChatProvider>
      </CommsProvider>
    </ThemeProvider>
  );
}

// Inbox route: shows the chat list; tap = open the conversation with that peer
function InboxScreen({ navigation }: any) {
  return <ConversationListScreen onOpenConversation={(peerId) => navigation.navigate("Chat", { peerId })} />;
}
// Chat route (set headerShown: false; the screens draw their own header)
function ChatRoute({ route, navigation }: any) {
  return <ChatScreen peerId={route.params.peerId} chatId={route.params.chatId} onBack={navigation.goBack} />;
}
```

Headless version, if you draw your own UI (hooks from `commskit/chat`):

```tsx
import { useConversations, useConversation, useChatApi } from "commskit/chat";

function Inbox({ onOpen }: { onOpen: (peerId: string) => void }) {
  const { conversations, loaded } = useConversations(); // newest first, live; empty until loaded
  // conversations[i]: { user_id, username, avatar, unread_count, last_message, chat_id, ... }
  /* render a list; onPress={() => onOpen(c.user_id)} */
}

function Chat({ peerId }: { peerId: string }) {
  const { messages, send, loadMore } = useConversation(peerId); // messages: newest first (inverted FlatList)
  /* send("hello") returns false if not connected or blocked */
}

// Start a chat with someone who has no conversation yet (profile screen, "Message" button):
function MessageButton({ userId, onOpen }: { userId: string; onOpen: (id: string) => void }) {
  const { startChat } = useChatApi();
  return <Button title="Message" onPress={async () => { await startChat(userId); onOpen(userId); }} />;
}
```

`startChat(id)` calls `POST /chats/start?candidate_id=<id>`; the id is the other person's `uid`. Sending the first message also creates the chat, so `startChat` is optional if you go straight to `useConversation(peerId).send(...)`.

### 4.4 Login and logout lifecycle

| Moment | Do |
|---|---|
| Login | Call your login route, store `{ token, userId }` (Expo `SecureStore`, not plain AsyncStorage, for the token), set state so the tree above mounts. `CommsProvider` connects on mount |
| Switching user | Different `key` on `CommsProvider` (shown above): a full remount, new socket, empty stores |
| Token refreshed | Make `getToken()` return the new value. If the socket was closed for a bad token it reconnects by itself with backoff (1 s, 2 s, ... up to 30 s) and calls `getToken()` again; to reconnect at once call `useComms().client.reconnect()` |
| Logout | `useComms().client.disconnect()` (no more reconnects), unregister the push device while the token is still valid (9.1), clear the stored token, unmount the providers |

### 4.5 Which base URL (this is where phones differ from browsers)

`localhost` on a phone means *the phone*. The server must be bound to an address the phone can reach: `server.listen(port, "0.0.0.0")` (Node), Fastify `host: "0.0.0.0"`. The snippets in 3.4 already do. A server bound to `127.0.0.1` works only from the same machine.

| Where the app runs | `baseUrl` | Notes |
|---|---|---|
| Android emulator | `http://10.0.2.2:8080` | `10.0.2.2` is the emulator's alias for your PC |
| iOS simulator | `http://localhost:8080` | same machine (not verified here, no macOS) |
| Real phone on the same Wi-Fi | `http://<PC LAN IP>:8080` | find it with `ipconfig` (Windows, the Wi-Fi adapter's IPv4), `ipconfig getifaddr en0` (macOS), `hostname -I` (Linux). Server on `0.0.0.0`; allow the port in the firewall (Windows: allow Node.js on "Private networks"). Test from the phone's browser: `http://<IP>:8080/chats/1` should answer `{"detail":"Not authenticated"}` |
| Real phone, no shared network | an HTTPS tunnel or a deployed server | e.g. any tunnel tool that gives you `https://...` |
| Production | `https://api.example.com` | `wss://` is derived automatically |

Plain `http://` and `ws://` are blocked by default on Android 9+ and by iOS App Transport Security. For **development only**, the example app enables cleartext: Android `expo-build-properties` `android.usesCleartextTraffic: true`, iOS `NSAppTransportSecurity.NSAllowsArbitraryLoads: true` (see `examples/expo-app/app.json`). Remove both for production builds. Without them you get "Network request failed" (section 10).

---

## 5. Step 4: The website (React)

Checked against `web/README.md`, `web/src/providers.tsx` and `examples/web-app`; the browser parts were **not run**. Full guide: [../web/03-using-running-and-deploying.md](../web/03-using-running-and-deploying.md); token storage and XSS: [../web/02-keys-secrets-websockets-and-placeholders.md](../web/02-keys-secrets-websockets-and-placeholders.md); a complete app: `examples/web-app` ([../example/web-example.md](../example/web-example.md)). `commskit-web` is **chat only** (no calls in the browser package).

### 5.1 Install

```bash
cd comms-kit/web && npm install && npm run build     # creates dist/index.js, dist/index.d.ts, dist/styles.css
cd ../../my-site
npm install ../comms-kit/web react react-dom         # or a tarball: npm pack in web/, then npm install ./commskit-web-0.1.0.tgz
```

```powershell
cd comms-kit\web; npm install; npm run build
cd ..\..\my-site
npm install ..\comms-kit\web react react-dom
```

The build needs the sibling `mobile/src` folder (the shared engine is bundled in), so build from a full checkout; the resulting package is self-contained. If your bundler ends up with two copies of React ("Invalid hook call"), dedupe it. Vite: `resolve: { dedupe: ["react", "react-dom"] }`.

### 5.2 Quick start

```tsx
// src/ChatPage.tsx
import { useMemo } from "react";
import { AppearanceProvider, ChatApp, CommsStack, type CommsConfig } from "commskit-web";
import "commskit-web/styles.css"; // required: all the chat styling

export function ChatPage({ session }: { session: { token: string; userId: string } }) {
  const config = useMemo<CommsConfig>(
    () => ({
      baseUrl: import.meta.env.VITE_API_URL || window.location.origin, // full origin; an empty string is rejected
      getToken: () => session.token,     // called on every (re)connect and REST call
      getUserId: () => session.userId,   // same string as the token's `uid`
    }),
    [session],
  );
  return (
    <AppearanceProvider>
      {/* key = user: a new login gets a clean socket */}
      <CommsStack key={session.userId} config={config}>
        <div style={{ height: "100dvh" }}>
          <ChatApp />
        </div>
      </CommsStack>
    </AppearanceProvider>
  );
}
```

`CommsStack` = `CommsWebProvider` + `ModerationProvider` + `ChatProvider`. The config is the same as on the phone (4.2): `baseUrl`, optional `wsUrl`, `getToken`, `getUserId`, `logger`. `ChatApp` shows one pane on a phone-width screen and list + chat from 700 px. To start a chat with someone who has no conversation yet use `useChatApi().startChat(userId)` and then select them (`examples/web-app/src/App.tsx`, "New chat"). With your own routing use `ConversationListScreen` and `ChatScreen` (web README).

The page's socket URL is `wss://<host>/ws/<token>` when `baseUrl` is `https://`, and `ws://` for `http://`. A page served over `https://` cannot open `ws://` (browsers block it as mixed content), so an HTTPS site needs an HTTPS API (section 10).

### 5.3 Same-origin proxy or CORS: choose one

| | Same-origin proxy | CORS |
|---|---|---|
| Browser sees | one origin for the page, REST, media and `/ws` | page on `https://app.example.com`, API on `https://api.example.com` |
| `baseUrl` | `window.location.origin` | `https://api.example.com` |
| Backend work | none | CORS config (3.8) |
| Fits | you control a gateway or nginx | static hosting (Vercel, Netlify, S3/CloudFront) for the page |

**Vite dev proxy** (from `examples/web-app/vite.config.ts`; paths adjusted to this guide):

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.COMMS_SERVER || "http://localhost:8080"; // your Node backend
const paths = ["/auth", "/chats", "/moderation", "/devices", "/media", "/call"];
const proxy = {
  ...Object.fromEntries(paths.map((p) => [p, { target: server, changeOrigin: true }])),
  "/ws": { target: server, ws: true, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
```

Use `baseUrl: window.location.origin` in dev. (The example's Vite proxy was not started for this guide; the example's own e2e uses it.)

**A Node gateway** (serves the built site and forwards the API; was run with `http-proxy-middleware` 4.2.1 in front of the Fastify server: login, REST and the WebSocket all worked through it, including `close 1008` for a bad token):

```js
// gateway.mjs   npm install express http-proxy-middleware
import { createServer } from "node:http";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const API = process.env.API_URL ?? "http://127.0.0.1:8080";
const app = express();

const api = createProxyMiddleware({
  target: API,
  changeOrigin: true,
  pathFilter: ["/chats/**", "/call/**", "/moderation/**", "/devices/**", "/media/**", "/auth/**"],
});
const ws = createProxyMiddleware({ target: API, changeOrigin: true, ws: true, pathFilter: "/ws/**" });

app.use(api);
app.use(ws);
app.use(express.static("dist"));                                              // your built website
app.get("*", (_req, res) => res.sendFile("index.html", { root: "dist" }));    // SPA fallback

const server = createServer(app);
server.on("upgrade", ws.upgrade); // forward WebSocket upgrades
server.listen(Number(process.env.PORT ?? 3000), () => console.log("gateway on :" + (process.env.PORT ?? 3000)));
```

**nginx** (**not run**; adapted from the kit's web and backend docs):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# Keep the token in /ws/<token> out of the access log
map $request_uri $loggable_uri { ~^/ws/ "/ws/[token]"; default $request_uri; }
log_format chat '$remote_addr [$time_local] "$request_method $loggable_uri" $status $body_bytes_sent';

server {
  listen 443 ssl http2;
  server_name app.example.com;
  access_log /var/log/nginx/app.access.log chat;

  root /var/www/app;                        # the built site
  location / { try_files $uri /index.html; }

  location ~ ^/(auth|chats|call|moderation|devices|media)(/|$) {
    proxy_pass http://127.0.0.1:8080;       # commskit-node
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20m;               # uploads are base64 over the socket, REST bodies up to 20 MB
  }

  location /ws/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;               # the default 60 s drops quiet sockets
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
```

### 5.4 Where to keep the token (XSS)

Browser code is public and any script on the page can read what the page can read. `localStorage` / `sessionStorage` survive reloads but are readable by any injected script (XSS). The more careful options are an in-memory variable (lost on reload; fetch a fresh token on page load from your own session cookie) or an `HttpOnly` session cookie on your login that is exchanged for a short-lived chat token. Keep the chat token **short-lived** (15 to 60 minutes) with a refresh route, and never put the JWT **secret** in the frontend. Note that the WebSocket URL contains the token, so it appears in server and proxy access logs (section 8). Details: [../web/02-keys-secrets-websockets-and-placeholders.md](../web/02-keys-secrets-websockets-and-placeholders.md) ("Where to keep the token").

---

## 6. Step 5: Verify the connection

Work down the ladder. Each rung needs the one above it. Stop at the first rung that fails and look it up in section 10. Everything below was run against the scratch host app built from this guide's snippets, on a fresh database; the outputs are real (ports, token bytes and timestamps differ). Replace `8080` with your port, and `101` / `102` with your two user ids.

First create the two check scripts in the folder of your host app (they need `npm install ws`).

```js
// ws-check.mjs   usage: node ws-check.mjs <ws-base> <token>
import WebSocket from "ws";

const [base, token] = process.argv.slice(2);
if (!base || !token) throw new Error("usage: node ws-check.mjs <ws-base> <token>");
const ws = new WebSocket(`${base.replace(/\/+$/, "")}/ws/${encodeURIComponent(token)}`, { handshakeTimeout: 5000 });
let opened = false;

ws.on("open", () => {
  opened = true;
  console.log("OPEN (handshake accepted)");
  ws.send(JSON.stringify({ type: "req_users" }));
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) console.log("STILL OPEN after 1.5 s: token accepted");
    ws.close();
  }, 1500);
});
ws.on("message", (raw) => console.log("FRAME", String(raw)));
ws.on("close", (code, reason) => console.log(`CLOSE ${code} ${reason.toString() || "(no reason)"}`));
ws.on("error", (err) => console.log(`ERROR ${err.message}${opened ? "" : " (never opened: URL, port, proxy or TLS)"}`));
```

```js
// chat-check.mjs   usage: node chat-check.mjs <ws-base> <tokenA> <tokenB> <idB>   (A sends a message to B)
import WebSocket from "ws";

const [base, tokenA, tokenB, idB] = process.argv.slice(2);
if (!idB) throw new Error("usage: node chat-check.mjs <ws-base> <tokenA> <tokenB> <idB>");
const open = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/\/+$/, "")}/ws/${encodeURIComponent(token)}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
const next = (ws, type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
    ws.on("message", function onMsg(raw) {
      const frame = JSON.parse(String(raw));
      if (frame.type === type) { clearTimeout(timer); ws.off("message", onMsg); resolve(frame); }
    });
  });

const a = await open(tokenA);
const b = await open(tokenB);
const gotB = next(b, "new_message");
const sentA = next(a, "message_sent");
a.send(JSON.stringify({ type: "send_message", candidate_user_id: idB, content: "hello from A" }));
const m = (await gotB).message;
console.log("B received new_message:", m.content, "from", m.sender_id, "sender_type", m.sender_type);
console.log("A received message_sent: id", (await sentA).message.id, "is_delivered", (await sentA).message.is_delivered);
a.close(); b.close();
```

### Rung (a): the server is up

```bash
curl -i http://localhost:8080/chats/101
```

```powershell
try { Invoke-RestMethod http://localhost:8080/chats/101 } catch { "$($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
```

Expected: `HTTP/1.1 401 Unauthorized` and body `{"detail":"Not authenticated"}` (PowerShell: `401 {"detail":"Not authenticated"}`). That answer proves the kit's routes are mounted and the auth check runs. `Connection refused` means the server is not running or on another port; a `404` means the adapter is not registered or the feature is not installed (section 10).

### Rung (b): a token from YOUR login

```bash
curl -s -X POST http://localhost:8080/auth/login -H "content-type: application/json" \
  -d '{"username":"alice","password":"alice-pw"}'
```

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:8080/auth/login -ContentType 'application/json' `
  -Body '{"username":"alice","password":"alice-pw"}'
$token = $login.token
```

Expected: `{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....","userId":"101","name":"Alice"}`. Check what is inside the token (decoding is not verifying, it only shows the claims):

```powershell
$p = $token.Split('.')[1].Replace('-','+').Replace('_','/'); while ($p.Length % 4) { $p += '=' }
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p))
```

```bash
node -e "console.log(Buffer.from(process.argv[1].split('.')[1],'base64url').toString())" "$TOKEN"
```

Expected: `{"uid":"101","iat":1793085656,"exp":1793089256}`. If `uid` is missing, or is not the same string you use as the user's id elsewhere, fix step 1 now.

### Rung (c): REST with the token

```bash
TOKEN=$(curl -s -X POST localhost:8080/auth/login -H "content-type: application/json" -d '{"username":"alice","password":"alice-pw"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -w ' [%{http_code}]\n' http://localhost:8080/chats/101 -H "Authorization: Bearer $TOKEN"   # your own list
curl -s -w ' [%{http_code}]\n' http://localhost:8080/chats/102 -H "Authorization: Bearer $TOKEN"   # someone else's list
curl -s -w ' [%{http_code}]\n' http://localhost:8080/chats/101 -H "Authorization: Bearer nonsense"
```

```powershell
Invoke-RestMethod -Uri http://localhost:8080/chats/101 -Headers @{ Authorization = "Bearer $token" }          # prints nothing: an empty list
Invoke-RestMethod -Uri http://localhost:8080/chats/101/unread-count -Headers @{ Authorization = "Bearer $token" }
try { Invoke-RestMethod -Uri http://localhost:8080/chats/102 -Headers @{ Authorization = "Bearer $token" } } catch { "$($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
```

| Call | Expected |
|---|---|
| `GET /chats/101` with the token | `[] [200]` (empty on a fresh database) |
| `GET /chats/101/unread-count` | `{"unread_count":0}` |
| `GET /chats/102` with user 101's token | `{"detail":"Not allowed"} [403]` |
| bad token | `{"detail":"Invalid token"} [401]` |
| no token (rung a) | `{"detail":"Not authenticated"} [401]` |

A `200 []` here is the first real proof: the token was accepted **and** the database tables exist.

### Rung (d): the WebSocket handshake and one frame

```bash
node ws-check.mjs ws://localhost:8080 "$TOKEN"
node ws-check.mjs ws://localhost:8080 not.a.token
node ws-check.mjs ws://localhost:8080/nope "$TOKEN"
node ws-check.mjs ws://localhost:1 "$TOKEN"
```

```powershell
node ws-check.mjs ws://localhost:8080 $token
node ws-check.mjs ws://localhost:8080 not.a.token
```

Expected, in order (first run, empty database):

```
OPEN (handshake accepted)
FRAME {"type":"res_users","users":[]}
STILL OPEN after 1.5 s: token accepted
CLOSE 1005 (no reason)            <- 1005 is our own normal close from the script

OPEN (handshake accepted)
CLOSE 1008 Invalid token          <- bad token: accepted first, then closed with 1008

ERROR socket hang up (never opened: URL, port, proxy or TLS)    <- wrong path /nope with the guard from 3.9
CLOSE 1006 (no reason)

ERROR  (never opened: URL, port, proxy or TLS)    <- nothing listening on that port (the message text is empty)
CLOSE 1006 (no reason)
```

Reading it: `OPEN` then `res_users` means the token is valid and the frame loop works (`req_users` is "give me my conversation list"; later runs list your chats). `CLOSE 1008` means the secret, algorithm or claim does not match step 1. In the browser console the same check is:

```js
const ws = new WebSocket("ws://localhost:8080/ws/" + TOKEN);
ws.onopen = () => ws.send(JSON.stringify({ type: "req_users" }));
ws.onmessage = (e) => console.log(e.data);          // {"type":"res_users","users":[...]}
ws.onclose = (e) => console.log("close", e.code, e.reason);   // 1008 Invalid token on a bad token
```

(From an `https://` page use `wss://`. In the console of the page that runs your app, `TOKEN` is whatever your login stored.)

### Rung (e): two users chatting end to end

```bash
A=$(curl -s -X POST localhost:8080/auth/login -H "content-type: application/json" -d '{"username":"alice","password":"alice-pw"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
B=$(curl -s -X POST localhost:8080/auth/login -H "content-type: application/json" -d '{"username":"bob","password":"bob-pw"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
node chat-check.mjs ws://localhost:8080 "$A" "$B" 102
```

```powershell
$a = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/auth/login -ContentType 'application/json' -Body '{"username":"alice","password":"alice-pw"}').token
$b = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/auth/login -ContentType 'application/json' -Body '{"username":"bob","password":"bob-pw"}').token
node chat-check.mjs ws://localhost:8080 $a $b 102
```

Expected:

```
B received new_message: hello from A from 101 sender_type other
A received message_sent: id 1 is_delivered true
```

Then confirm it was saved and is visible over REST as Bob (`GET /chats/102` with Bob's token): one chat, `other_user` `{"id":"101","username":"Alice","avatar":null}`, `last_message.content` `"hello from A"`, `unread_count` `1` (it is `0` for Alice, who sent it). The `username` coming back as `Alice` proves your `UserDirectory` works; `101` instead of a name means it returned nothing for that id (3.7).

### Rung (f): the same from the real frontend

(**Not run** for this guide: needs a device or a browser.)

1. Start the backend, log in with a real user in the app/site. In the app's logs (`consoleLogger("[comms]")`) or the status banner you should see the connection reach `open`. `useConnectionStatus()` returns `{ status: "open" }`.
2. On a second device, browser or private window, log in as the other user.
3. Start a chat (`startChat(otherId)` or the "New chat" flow), send a message. The other side shows it without a reload.
4. Close the app on the second device: the first user's message gets `is_delivered: false`. Reopen: it arrives.

### Rung (g): browser Network tab checks

Open DevTools, **Network**:

| Look at | Healthy | Not healthy means |
|---|---|---|
| Filter `WS` | one entry `ws/<token>`, status `101 Switching Protocols`, a green dot; **Messages** tab shows `res_users` after load | red entry: wrong URL/proxy; `101` then immediately closed: bad token (1008, shown in the entry) |
| Any `chats/...` XHR/fetch | status `200`, request header `Authorization: Bearer eyJ...` | `401`: token; `403`: id mismatch; status `(failed)` with a CORS message: section 3.8 |
| Cross-origin API only | a preflight `OPTIONS` that returns `204`, followed by the real call | no `Access-Control-Allow-Origin` in the preflight response: CORS not configured for this origin |
| Console | no "mixed content" or "blocked by CORS policy" lines | see section 10 |

---

## 7. Step 6: What happens on the wire

The full list of frames, all payloads and the legacy quirks are in [../archive/PROTOCOL.md](../archive/PROTOCOL.md). In short:

**One chat message** (A sends to B):

```
A  -> {"type":"send_message","candidate_user_id":"102","content":"hello"}
server: policy check, rate limit, creates the chat if needed, saves the message
B  <- {"type":"new_message","message":{...,"sender_id":"101","sender_type":"other"}}    (if B is online)
A  <- {"type":"message_sent","message":{...,"is_delivered":true|false}}
B offline -> a push through your PushSender (if configured); B's next connect gets the data via req_users / get_messages
B opens the chat -> {"type":"mark_read","chat_id":1}   =>   A  <- {"type":"messages_read",...}
```

Other chat frames: `req_users` / `res_users` (list), `get_messages` / `res_messages` (history), `typing` / `typing_status`, `media_upload` / `media_upload_success`, `delete_message`, `clear_chat`, `user_status` (online/away), `ping` / `PONG`.

**One call setup** (P2P WebRTC; the server only relays signalling):

```
A -> call_initiate {receiver_id:"102", call_type:"audio"}   A <- call_initiated      B <- incoming_call  (+ push if B has no socket)
A <- call_ringing
A -> sdp_offer {call_id, sdp}                                B <- sdp_offer
B -> sdp_answer {call_id, sdp}  and  answer_call {call_id}   A <- sdp_answer, call_answered   (ICE candidates both ways: ice_candidate)
...media flows directly A <-> B (or through TURN)...
A -> end_call {call_id}                                      A,B <- call_ended {end_reason:"hangup"}  (+ call_log in the chat)
```

Timeouts: ring 45 s then `call_missed`; socket loss while ringing 20 s, while answered 90 s (`disconnected`). `POST /call/turn-credentials` returns the TURN username/password for the media path.

---

## 8. Step 7: Going to production

Each item is short; deeper material is in [../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md) (sections 4 to 6) and [../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md](../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md). None of the deployment items below were run here.

| Topic | What to do |
|---|---|
| HTTPS / WSS | Terminate TLS at nginx, a load balancer or your platform. Use `https://` for `baseUrl`; the clients then use `wss://`. Browsers also allow the microphone (calls) only on HTTPS or `localhost`. Remove the Android/iOS cleartext settings from release builds |
| Secrets | `JWT_SECRET` (and `TURN_SECRET`, `EXPO_ACCESS_TOKEN`, DB URL) from environment variables or a secret manager. 32+ random characters. Never in the frontend or the repo. `auth.mjs` above refuses to start without one |
| Token lifetime and refresh | The kit checks the token only when a socket connects and on each REST call (reproduced). Issue short tokens (for example 1 hour) and give the frontend a refresh route; make `getToken()` return the *current* token. When the socket drops (network change, server restart) the client reconnects and calls `getToken()` again, so an expired token ends in a 1008 loop until `getToken()` returns a fresh one. A long-lived socket outlives its token: if you need hard cut-offs, close the user's sockets yourself on logout/ban |
| Idle timeouts | The Node server sends **no** WebSocket pings (`websocket.ts` has no ping timer; the only interval is the Redis heartbeat), and the clients' `pingIntervalMs` defaults to 0. Set the proxy/load-balancer idle timeout to **at least 120 s** (nginx `proxy_read_timeout 3600s` as in 5.3; AWS ALB defaults to 60 s, raise it) and/or set `pingIntervalMs={25000}` on the providers so the client sends `{"type":"ping"}` (the server answers `PONG`) |
| Log redaction | The token is in the URL path `/ws/<token>`. Redact it in access logs (nginx `map` in 5.3; in your own app logger do not log the URL of `/ws/` requests). Not tested. Treat existing logs as sensitive |
| More than one process | Presence and live delivery are per process by default. With several Node processes or containers use `RedisBridge` (`commskit-node/redis`, needs `ioredis`): `new ConnectionManager({ bridge })` and `await hub.connections.start()` after building the hub. **Nothing in the kit, the Fastify plugin or the Express adapter calls `start()` for you** (searched `src/`; the demo and `comms.mjs` call it). Without it a configured bridge never connects. Also use `RedisRateLimiter`. Redis itself was not tested here (the kit's own tests use fakes). One process needs none of this |
| TURN for calls | Calls across different networks / mobile data need your own TURN server (coturn): set `CallFeature({ config: { turnSecret, turnUris } })`; the app fetches credentials from `POST /call/turn-credentials` (`503` while `turnSecret` is unset) |
| Rate limits | Defaults: 20 messages per 10 s, 5 uploads per 60 s, 5 typing events per 5 s, 5 `call_initiate` per 60 s, per user. Change through `ChatFeature({ config: { messageRate: new RateLimit(...) } })`; set `null` to turn one off. Limit the **login** route yourself too |
| PostgreSQL | `new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }) })`. Processes x `max` must stay under the server's `max_connections`. Create tables with a migration (DDL text: `chatDdl`, `callDdl`, `devicesDdl`, `moderationDdl`) rather than `ensureSchema` on every start when several processes boot at once. **Never run against a real PostgreSQL here** |
| File storage | `LocalDiskStorage` writes files but does **not** serve them (`file_url` is `/media/...`: you must serve that folder, the demo does). For production use `S3Storage` from `commskit-node/s3` (`new S3Storage({ bucket, region, prefix, publicBaseUrl, private })`, needs the AWS SDK peers) |
| Process manager | A long-running Node process: systemd, PM2, Docker, a PaaS web service. **Not** serverless functions (no persistent sockets, no call timers). Handle `SIGTERM` with `await hub.shutdown()` as in the snippets |
| Health check | Add your own route; for example Fastify `app.get("/healthz", async () => ({ ok: true }))`. A kit route needs a token, so it is not a good health check |

---

## 9. Step 8: Optional features

### 9.1 Push notifications and device registration

The backend stores each device's push token; the app registers it after login.

```js
// in comms.mjs: devices + push. DevicesFeature goes BEFORE ChatFeature.
import { DevicePushRouter, DevicesFeature, ExpoPushSender, SqlDeviceRegistry } from "commskit-node/push";

const devices = new SqlDeviceRegistry(db);
export const push = new DevicePushRouter({
  registry: devices,
  expo: new ExpoPushSender({ accessToken: process.env.EXPO_ACCESS_TOKEN ?? null }),
});
// build the hub with   push,   in its options, then:
hub.install(new DevicesFeature(devices));   // POST /devices, DELETE /devices/<deviceId>, legacy token routes
// then ChatFeature / CallFeature as before. In the shutdown handler also:  await push.aclose();
```

(Installing these in the three modes and calling the routes was run: `POST /devices` exists and answers 422 without a body. Sending a real push to Expo/APNs was **not verified**.) iOS call push also needs `voip: ApnsVoipSender.fromEnv(devices)` (see `examples/backend/demo-server-node/server.mjs`).

On the phone (`commskit/notifications`):

```tsx
import { registerDevice, unregisterDevice } from "commskit/notifications";
// after login and on every app start
await registerDevice({ config, deviceId: await getStableInstallId(), appVersion: Constants.expoConfig?.version });
// on logout, BEFORE dropping the token
await unregisterDevice();
```

Needs `expo-notifications` and `expo-device`, and a dev build for real push. See [../mobile/03-using-running-and-deploying.md](../mobile/03-using-running-and-deploying.md) and the backend guide section 2.5.

### 9.2 Voice calls

Backend: `hub.install(new CallFeature({ config: { turnSecret, turnUris } }))` and `linkChatAndCall(chat, call)` (already in `comms.mjs`; TURN as in section 8). Phone app: install the WebRTC peers (4.1) and add the provider inside `ChatProvider`:

```tsx
import { CallProvider, turnCredentialsIceServers, PUBLIC_STUN } from "commskit/call";
import { CallOverlay } from "commskit/call-ui";

const iceServers = turnCredentialsIceServers(config, { fallback: PUBLIC_STUN }); // POST /call/turn-credentials, cached

<CommsProvider key={userId} config={config}>
  <ChatProvider>
    <CallProvider iceServers={iceServers} onCallError={(err, retry) => Alert.alert("Call", err.message)}>
      <YourNavigation />
      <CallOverlay />
    </CallProvider>
  </ChatProvider>
</CommsProvider>
// start a call:  const { startCall } = useCall();  await startCall(peerId, { peerName: "Bob" });
```

Calls need a dev build (native WebRTC), microphone permission, and TURN for mobile data. The website package has no call UI. Usage and edge cases: [../mobile/03-using-running-and-deploying.md](../mobile/03-using-running-and-deploying.md) section 3.

### 9.3 Moderation (block and report)

```js
import { ModerationFeature } from "commskit-node/moderation";
import { linkModeration } from "commskit-node/integration";

const moderation = hub.install(new ModerationFeature({ onReport: (report) => console.log("report", report.id) })); // notify your moderators
linkModeration(moderation, { chat, call }); // AFTER chat/call are installed: blocks are enforced and end a live call
```

Admin review routes (`/moderation/admin/...`) need an `adminDependency` that you supply (backend guide, file 2 section C.2). The phone app uses `ModerationProvider` / `useBlocking` from `commskit/moderation`; the website's `CommsStack` includes it.

### 9.4 Blocking and credit rules through policies

Implement `ChatPolicy` (`canMessage`, `blockStatus`, `extraConversationInfo`, `refusalMessage`) and `CallPolicy` (`authorize` returning `allow()` or `deny(...)`), then pass them: `new ChatFeature({ policy: new MyChatPolicy() })`, `new CallFeature({ policy: new MyCallPolicy() })`. The policy receives the hub's Kysely instance, so it can read your own tables ("only matched users may chat", "a call costs one credit"). A "check then charge" is **not atomic** (there is no per-frame transaction): use `db.transaction().execute(...)` or an atomic `UPDATE ... WHERE credits >= 1`. Complete verified samples: [../backend/backend-node/03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md) section 2.8.

---

## 10. Troubleshooting by symptom

"Reproduced" means I triggered it against the scratch host app and saw the quoted result. "From the docs" means the cause comes from the kit docs or code reading and was not triggered here.

| # | Symptom | Likely cause and fix |
|---|---|---|
| 1 | REST `401 {"detail":"Not authenticated"}` | No `Authorization: Bearer <token>` header (reproduced). Your `fetch`/axios call is missing it, or a proxy strips it. The kit's own clients add it from `getToken()`; if `getToken()` returned `null` there is no header |
| 2 | REST `401 {"detail":"Invalid token"}` | The header is there but the token is rejected: wrong `JWT_SECRET`, different algorithm, no `uid` claim, expired or not-yet-valid (`nbf`) (all reproduced with `JwtAuth`). Compare with the token contract table (0) and decode the token (rung b) |
| 3 | REST `403 {"detail":"Not allowed"}` on `/chats/<id>` | The id in the path is not the token's `uid` (reproduced). Pass the logged-in user's id, i.e. fix `getUserId()` or the token's `uid` |
| 4 | WebSocket opens and immediately closes with **1008** (`Invalid token`) | Same causes as #2, for the socket. Turn on the hub `logger.info` to see `WS auth failed: <reason>` (`signature verification failed`, `"exp" claim timestamp check failed`, `Token has no 'uid' claim`, ...). Reproduced |
| 5 | WebSocket never opens, close code **1006**, "socket hang up" | Wrong host/port, wrong path (must be `/ws/<token>` with nothing before or after it; reproduced with `/nope`), proxy not forwarding `Upgrade`, or TLS mismatch (`ws://` to an HTTPS-only port) |
| 6 | Browser console: "blocked by CORS policy" / preflight fails | Page and API have different origins and the API does not allow this origin. Add the CORS config (3.8) with the **exact** page origin (scheme + host + port, no trailing slash), or use a same-origin proxy (5.3). Allow the `Authorization` header |
| 7 | WebSocket fails or drops behind nginx | Missing `proxy_http_version 1.1`, `Upgrade` / `Connection` headers, or the default `proxy_read_timeout 60s` closes quiet sockets (5.3 and file 2 section B.6). Not run here |
| 8 | "Mixed content" / `SecurityError` opening `ws://` from an HTTPS page | The page is HTTPS but the socket URL is `ws://`. Use an HTTPS `baseUrl` (the socket becomes `wss://`) or set `wsUrl` to a `wss://` address. Browser rule, not reproduced |
| 9 | Works on the emulator, not on a real phone | `10.0.2.2` / `localhost` only exist on the emulator/simulator. Use the PC's LAN IP, bind the server to `0.0.0.0` (3.4), open the firewall port, put phone and PC on the same Wi-Fi, allow cleartext in dev (4.5). Test `http://<IP>:8080/chats/1` in the phone's browser: it should show `{"detail":"Not authenticated"}` |
| 10 | Chat list is empty although messages exist | Id mismatch: `getUserId()` / the `uid` claim and the peer ids differ in format (`"101"` vs `"U101"`), or the app logged in as a different user than the data. Check `GET /chats/<uid>` with the token (rung c) and `res_users` (rung d). Reproduced the empty-list answer `[]` for a user with no chats |
| 11 | Messages appear only after reload / pull-to-refresh | The socket is not open, so only REST works. Check the status (`useConnectionStatus()` shows `unauthenticated`, `reconnecting`, ...), the Network tab `WS` entry, the 1008 reason, proxy buffering (`proxy_buffering off` on `/ws/`) |
| 12 | The second tab/device sees nothing | One user may hold many sockets and every socket gets every frame (from the code), so check that the second tab uses the *same user id*. If it is another user: that user's id must match what the sender used as `candidate_user_id`. With **several server processes** and no `RedisBridge`, a message is delivered only on the process that owns the recipient's socket (section 8) |
| 13 | Android: "Network request failed" (login or REST) | Wrong host for where the app runs (4.5), server bound to `127.0.0.1`, firewall, or cleartext `http://` blocked (needs `usesCleartextTraffic` in dev or an `https://` URL). From the docs |
| 14 | Reconnect loop, close 1008 every few seconds, REST 401 after an hour | The token expired and `getToken()` keeps returning the same one. The client reconnects with backoff (1 s up to 30 s) forever and calls `getToken()` each time; the open socket itself survived the expiry (reproduced). Refresh the token in `getToken()` or log the user out |
| 15 | Server fails to start: `FST_ERR_DUPLICATED_ROUTE ... '/chats/expo/push/token'` | `DevicesFeature` was installed **after** `ChatFeature({ devices })`. Install `DevicesFeature` first and do not pass `devices` to `ChatFeature` (reproduced) |
| 16 | `500 {"detail":"Internal Server Error"}` on `/chats/...`; log: `no such table: chats` (SQLite) or `relation "chats" does not exist` (PostgreSQL) | `ensureSchema(db)` was not called (or ran on another database file/schema). Reproduced |
| 17 | `ERR_PACKAGE_PATH_NOT_EXPORTED` | You used `require("commskit-node/core")` (CommonJS) or a path that is not exported (`commskit-node/dist/...`). The package is ESM only: use `import`, or `await import(...)`. Reproduced for `require` |
| 18 | TypeScript `TS2307: Cannot find module 'commskit-node/core'` | `moduleResolution` is `node`/`node10`; use `Bundler`, `Node16` or `NodeNext`. From the docs (file 3, checked there, not re-run) |
| 19 | `Cannot find package 'kysely'` (or `jose`) | You import it in your own code but did not install it (folder installs do not hoist the kit's dependencies). `npm install kysely@^0.27.4 jose@^5`. Also avoid two Kysely versions in one project |
| 20 | `Cannot find module .../backend-node/dist/...` / `Cannot find package 'commskit-node'` | `dist/` is not built (it is git-ignored). `npm install && npm run build` in `backend/backend-node`, then reinstall the tarball. From the docs, not reproduced |
| 21 | A request inside `db.transaction().execute(...)` never returns (SQLite) | Inside the callback you used `db` instead of the transaction handle `trx`. The SQLite driver has one connection, so the second query waits for the transaction that is waiting for it. Use `trx` for every query inside. Reproduced (hung after 2 s). Policies get the hub's `db`: keep them out of your own transactions |
| 22 | `database is locked` (SQLite) | One writer at a time. Set `PRAGMA busy_timeout` (the snippet does) and move to PostgreSQL for real load |
| 23 | With Redis configured nothing is shared between processes; log `Redis unavailable (...)` | `await hub.connections.start()` was never called, or `ioredis` is not installed / Redis unreachable (file 3). From the docs |
| 24 | Calls ring but there is no audio, or calls fail between networks | No TURN (set `turnSecret` + `turnUris`, check `POST /call/turn-credentials` is 200, not 503); no microphone permission; browser calls need HTTPS or `localhost`; in the app WebRTC needs a dev build |
| 25 | Wrong-path upgrade hangs, or the whole server exits with `ECONNRESET` | Something opened a WebSocket upgrade to a path other than `/ws/<token>` and then reset. Add the guard from 3.9. Reproduced on `node:http` and Fastify (before the guard) |
| 26 | `404` on `/chats/...` | The adapter was registered *before* the feature was installed (routes are a snapshot), the feature is not installed (call-only mode has no `/chats`), or a proxy path rule does not forward `/chats`. In Express, a route of yours placed before the kit router can shadow it |
| 27 | `422` on `/chats/start` | `candidate_id` query parameter missing (reproduced: `loc: ["query","candidate_id"]`, `Field required`) |
| 28 | Names show as ids / no avatars | `UserDirectory` missing, returning nothing for these ids, or throwing (logged as `UserDirectory.getProfiles failed`). See 3.7 |

---

## 11. Connection checklist and where to read next

### Checklist

```
BACKEND
[ ] Node >= 20, ESM project; commskit-node built (npm run build) and installed from a tarball/folder
[ ] kysely@^0.27.4, jose@^5, a database driver (better-sqlite3@11 or pg), fastify or express (if used) installed in MY project
[ ] JWT_SECRET (32+ random chars) set from the environment; same value used by the login and by JwtAuth
[ ] My login returns { token, userId }; the token has claim "uid" (or JwtAuth claim option matches), exp set
[ ] ensureSchema(db) runs before the first request; no clash with my own "chats"/"messages"/"calls" tables
[ ] hub created -> features installed (DevicesFeature before ChatFeature) -> linked -> adapter registered
[ ] await hub.connections.start() called (needed with Redis)
[ ] Server listens on 0.0.0.0 (phone/LAN) and the wrong-path upgrade guard is in place
[ ] UserDirectory returns names/avatars for my user ids
[ ] CORS configured for the website's exact origin, or a same-origin proxy is used
VERIFY (section 6)
[ ] a) unauthenticated GET /chats/<uid> = 401   b) login token decodes with uid
[ ] c) GET /chats/<uid> with token = 200 [], other uid = 403
[ ] d) ws-check: OPEN + res_users; bad token = CLOSE 1008
[ ] e) chat-check: new_message + message_sent; REST shows the chat
PHONE
[ ] commskit installed (file: link / registry), Metro watchFolders if needed, peers installed
[ ] CommsProvider config: baseUrl for where the app runs (10.0.2.2 / LAN IP / https), getToken, getUserId (same id as uid)
[ ] Provider tree remounted with key={userId}; cleartext allowed in dev only
WEBSITE
[ ] commskit-web built and installed; "commskit-web/styles.css" imported; React deduped
[ ] baseUrl = window.location.origin (proxy) or the API origin (CORS); https page -> https API
[ ] Token storage chosen with XSS in mind; short-lived token + refresh
PRODUCTION
[ ] HTTPS/WSS; proxy idle timeout >= 120 s or pingIntervalMs set; token redacted in access logs
[ ] Several processes -> RedisBridge; calls -> TURN; PostgreSQL + migrations; S3Storage for files
[ ] Push: DevicesFeature + registerDevice on login, unregisterDevice on logout
```

### Where to read next

| Topic | File |
|---|---|
| Python backend version of this guide | [connect-frontend-to-backend-python.md](connect-frontend-to-backend-python.md) |
| Node backend: overview, keys/secrets/WebSockets, using and deploying | [../backend/backend-node/01-overview.md](../backend/backend-node/01-overview.md), [02-keys-secrets-websockets-and-placeholders.md](../backend/backend-node/02-keys-secrets-websockets-and-placeholders.md), [03-using-running-and-deploying.md](../backend/backend-node/03-using-running-and-deploying.md) |
| Phone app (React Native / Expo) | [../mobile/01-overview.md](../mobile/01-overview.md), [02-keys-secrets-websockets-and-placeholders.md](../mobile/02-keys-secrets-websockets-and-placeholders.md), [03-using-running-and-deploying.md](../mobile/03-using-running-and-deploying.md) |
| Website (React) | [../web/01-overview.md](../web/01-overview.md), [02-keys-secrets-websockets-and-placeholders.md](../web/02-keys-secrets-websockets-and-placeholders.md), [03-using-running-and-deploying.md](../web/03-using-running-and-deploying.md) |
| Runnable examples | [../example/backend-node-example.md](../example/backend-node-example.md), [../example/mobile-example.md](../example/mobile-example.md), [../example/web-example.md](../example/web-example.md); code in `examples/backend/demo-server-node/server.mjs`, `examples/expo-app`, `examples/web-app` |
| Wire protocol | [../archive/PROTOCOL.md](../archive/PROTOCOL.md) |
| Package READMEs | [../../backend/backend-node/README.md](../../backend/backend-node/README.md), [../../mobile/README.md](../../mobile/README.md), [../../web/README.md](../../web/README.md) |
