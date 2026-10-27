# commskit-node backend: using, running and deploying

File 3 of 3. Previous: [keys, secrets, WebSockets and placeholders](02-keys-secrets-websockets-and-placeholders.md). Start: [overview](01-overview.md).

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Installing into an existing Node project](#2-installing-into-an-existing-node-project)
3. [Running locally from a clean machine](#3-running-locally-from-a-clean-machine)
4. [Deploying to a server](#4-deploying-to-a-server)
5. ["What do I need" checklist](#5-what-do-i-need-checklist)
6. [Go-live checklist](#6-go-live-checklist)

Verification legend: the TypeScript samples in section 2 were **compiled with `tsc` (strict) and run** on 2026-10-26 against the built package installed from an `npm pack` tarball
(Node 22.23.2, Windows, SQLite, Fastify 4.29, Express 4.22). Each of chat only, call only and chat + call + moderation + devices + push, behind Fastify, Express and plain `node:http`, answered
REST calls and WebSocket chat/call frames. The policy sample refused a message, returned a `402` call error and ended a call on block. Server configs (nginx, systemd, PM2, coturn, Docker, compose) were
**not run**; they are marked "untested". Anything involving real Redis, S3, PostgreSQL, coturn, APNs or Expo is **not verified** (the kit's own tests use SQLite and fakes).

---

## 1. Prerequisites

| Need | Version / detail | Source |
|---|---|---|
| Node.js | **20 or newer** (`engines.node ">=20"`). Checked with 22.23.2 | `backend/backend-node/package.json` |
| Package manager | npm (checked with 10.9.4); pnpm and yarn were not tried | |
| A module setup that can import ESM | The package is ESM only. Your project can be ESM (`"type": "module"`) or CommonJS using dynamic `import()`; `require("commskit-node/core")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` (checked) | `package.json` exports |
| TypeScript (optional) | 5.x. In `tsconfig.json` use `"moduleResolution": "Bundler"`, `"Node16"` or `"NodeNext"`; the old `"node"` / `node10` setting cannot resolve `commskit-node/core` (checked: error TS2307) | |
| Database driver | `better-sqlite3` (SQLite, dev) or `pg` (PostgreSQL, production). Not installed by the kit | file 2, A.2 |
| `kysely` | Installed with the kit; also install it in your project, because your code creates the `Kysely` instance | |
| Fastify or Express (optional) | Fastify `^4.28 \|\| ^5`, Express `^4.19 \|\| ^5` (peer ranges). Or no framework: `node:http` | file 1, section 3.8 |
| Redis 5+ (optional) | Only for more than one Node process. Needs `ioredis ^5.4` | file 2, A.5 |
| S3 bucket (optional) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | file 2, A.6 |
| `sharp` (optional) | Image thumbnails | file 2, A.7 |
| coturn (optional but needed for mobile data calls) | Your own TURN server | file 2, A.3 |
| ffmpeg/ffprobe (optional) | Video thumbnails and audio/video duration | file 2, A.7 |
| Chrome (optional) | Only for the browser UI tests of the demo | `examples/backend/demo-server-python` |

Peer dependency ranges are in `backend/backend-node/package.json`. One thing I noticed: `better-sqlite3` is declared as `^11.0.0` and the kit is tested with 11.x; npm accepted 13.x without complaint when I installed
`better-sqlite3` unpinned into a scratch project (the peer dependency is optional), and I did not run the kit on 13.x. Pin `better-sqlite3@11` unless you test it.

---

## 2. Installing into an existing Node project

### 2.1 Get the package

`commskit-node` is **not published to npm** (nothing in the repo says it is; `package.json` has version `0.1.0` and no publish config). `npm install commskit-node` from the registry will not give you this package
(it may find an unrelated one, or none). Install it from the folder, a tarball or git. `dist/` is **git-ignored** and generated, so the package must be built once before a folder install works.

**Option 1: from a local copy of the repo** (good while you develop; npm makes a symlink):

```powershell
# Windows PowerShell
cd ..\comms-kit\backend\backend-node
npm install
npm run build
cd ..\..\..\my-project
npm install ..\comms-kit\backend\backend-node kysely better-sqlite3@11
```

```bash
# Linux / macOS
cd ../comms-kit/backend/backend-node && npm install && npm run build
cd ../../../my-project
npm install ../comms-kit/backend/backend-node kysely better-sqlite3@11
```

With a folder install, the kit's own dependencies are not hoisted into your `node_modules` (I saw `kysely`, `ws` and `jose` missing there), so install `kysely` yourself as shown. Rebuild (`npm run build` in `backend/backend-node`) after you change kit code.

**Option 2: from a tarball** (what CI and Docker builds should use; checked here):

```powershell
cd comms-kit\backend\backend-node
npm run build
npm pack --pack-destination ..\..\..\my-project\vendor          # creates commskit-node-0.1.0.tgz (only dist/ is packed; 69 files)
cd ..\..\..\my-project
npm install .\vendor\commskit-node-0.1.0.tgz kysely better-sqlite3@11
```

```bash
cd comms-kit/backend/backend-node && npm run build && npm pack --pack-destination ../../../my-project/vendor
cd ../../../my-project && npm install ./vendor/commskit-node-0.1.0.tgz kysely better-sqlite3@11
```

Commit the `.tgz` (or publish it to your private registry) so a fresh `npm ci` works. With a tarball install npm also installs `jose`, `kysely` and `ws` (checked).

**Option 3: from git.** npm cannot install a package that lives in a sub-folder of a git repository by URL alone, and `dist/` is not committed, so this needs a repo (or a split-out copy) that has the package at its root plus a `prepare` script that runs the build. **Not tested here.**
The reliable route is option 2.

Then install the peers you use:

| Peer package | Install it when |
|---|---|
| `better-sqlite3` (`@11`) | SQLite (development, small single-server use) |
| `pg` | PostgreSQL (production) |
| `fastify` or `express` | you use that adapter |
| `ioredis` | `RedisBridge` / `RedisRateLimiter` (more than one process) |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | `S3Storage` (the presigner only for `private: true`) |
| `sharp` | image thumbnails |

### 2.2 Order of operations (applies to all modes)

1. Create the Kysely instance (`new Kysely({ dialect })`) and run `await ensureSchema(db)` (dev; see 2.6 for production).
2. Create the `CommsHub` with your auth adapter and the `db` (and, optionally, `users`, `push`, `connections`, `rateLimiter`).
3. Install features: `hub.install(new DevicesFeature(...))` first if you use it, then `ChatFeature`, `CallFeature`, `ModerationFeature`.
4. Link them: `linkChatAndCall`, then `linkModeration`.
5. **Only then** register the adapter (`app.register(commskitPlugin, { hub })`, `app.use(commskitRouter(hub))`, or `restListener(hub)`). They take a snapshot of `hub.restRoutes()` at that moment (`src/core/hub.ts`, `restRoutes`; `src/core/http.ts:23`): REST routes of a feature installed later are missing (the WebSocket handlers still work, because the handler table is live).
6. At startup: `await hub.connections.start()` (needed for `RedisBridge`; harmless without one). On shutdown: `await hub.shutdown()` (the Fastify plugin does this for you on `app.close()`), plus `await push.aclose()` if you made a push router, and `await db.destroy()`.

Installing the same feature twice throws `Feature 'chat' is already installed on this hub`.

### 2.3 Mode A: chat only

Two files. `src/comms.ts` builds the hub; the server file is your choice of Fastify, Express or plain `node:http`.

```ts
// src/comms.ts  (chat only)
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureSchema } from "commskit-node";
import { CommsHub, JwtAuth, LocalDiskStorage } from "commskit-node/core";
import { ChatFeature } from "commskit-node/chat";

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET is not set");

export const db = new Kysely<any>({
  dialect: new SqliteDialect({ database: new Database(process.env.SQLITE_PATH ?? "comms.db") }),
});
await ensureSchema(db); // creates the 8 kit tables if they are missing (safe to run on every start)

export const hub = new CommsHub({ auth: new JwtAuth(secret), db });
export const chat = hub.install(
  new ChatFeature({ storage: new LocalDiskStorage(process.env.MEDIA_DIR ?? "comms_media", "/media") }),
);
```

**With Fastify:**

```ts
// src/server.ts  (Fastify)
import Fastify from "fastify";
import { commskitPlugin } from "commskit-node/fastify";
import { hub } from "./comms.js";

const app = Fastify({ logger: true });
await app.register(commskitPlugin, { hub }); // REST routes + the /ws/:token upgrade; closes the hub on app.close()
await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
```

**With Express:**

```ts
// src/server.ts  (Express)
import { createServer } from "node:http";
import express from "express";
import { attach, commskitRouter } from "commskit-node/express";
import { hub } from "./comms.js";

const app = express();
app.use(commskitRouter(hub)); // REST routes (installed features only)
const server = createServer(app);
attach(server, hub); // the /ws/:token upgrade
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await hub.shutdown(); // closes sockets, cancels call timers, stops the Redis bridge
    server.close(() => process.exit(0));
  });
}
```

**With plain `node:http`:**

```ts
// src/server.ts  (plain node:http, no framework)
import { createServer } from "node:http";
import { restListener } from "commskit-node/core";
import { hub } from "./comms.js";

const rest = restListener(hub); // true when a kit route answered the request
const server = createServer(async (req, res) => {
  if (await rest(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "Not Found" }));
});
hub.attach(server); // the /ws/:token upgrade
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await hub.shutdown();
    server.close(() => process.exit(0));
  });
}
```

`new ChatFeature()` with no arguments uses `AllowAllChatPolicy` and `LocalDiskStorage("comms_media")` (relative to the working directory, and not served; see file 2, C.1). The sample passes a storage with `baseUrl "/media"`: **you still have to serve that folder**.
Build and run (`tsc` compiles `src` to `dist`; the `.js` suffix in the imports is the normal ESM-TypeScript convention):

```powershell
npx tsc            # tsconfig: target ES2022, module ESNext, moduleResolution Bundler, outDir dist
$env:JWT_SECRET = "0123456789abcdef0123456789abcdef"   # dummy; use your real secret
node dist/server.js
```

```bash
npx tsc
JWT_SECRET=0123456789abcdef0123456789abcdef node dist/server.js
```

### 2.4 Mode B: call only

Same server files as above; only `src/comms.ts` changes.

```ts
// src/comms.ts  (call only)
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureSchema } from "commskit-node";
import { CommsHub, JwtAuth } from "commskit-node/core";
import { CallFeature } from "commskit-node/call";

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET is not set");

export const db = new Kysely<any>({
  dialect: new SqliteDialect({ database: new Database(process.env.SQLITE_PATH ?? "comms.db") }),
});
await ensureSchema(db);

export const hub = new CommsHub({ auth: new JwtAuth(secret), db /* , users: myUserDirectory, push: myPushSender */ });
export const call = hub.install(
  new CallFeature({
    config: {
      turnSecret: process.env.TURN_SECRET ?? null,
      turnUris: (process.env.TURN_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  }),
);
```

Without chat, call frames carry `chat_id: null`, no chat message is written and no `call_log` frame is sent. `ensureSchema` still creates every kit table, chat tables included.
Names and push make calls usable: pass a `UserDirectory` (`users`) and a `PushSender` (`push`) to the hub (file 2, C.1).
`ensureSchema` comes from the root entry, which also loads chat code; that is harmless. If you want chat code to stay unloaded, import only from `/core` and `/call` and create the tables with your own migration (2.6).

### 2.5 Mode C: chat + call (with moderation, devices, push and optional Redis)

```ts
// src/comms.ts  (chat + call + moderation + devices + push)
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureSchema } from "commskit-node";
import { CommsHub, ConnectionManager, JwtAuth, LocalDiskStorage, StaticUserDirectory } from "commskit-node/core";
import { ChatFeature } from "commskit-node/chat";
import { CallFeature } from "commskit-node/call";
import { ModerationFeature } from "commskit-node/moderation";
import { linkChatAndCall, linkModeration } from "commskit-node/integration";
import { ApnsVoipSender, DevicePushRouter, DevicesFeature, ExpoPushSender, SqlDeviceRegistry } from "commskit-node/push";
import { RedisBridge, RedisRateLimiter } from "commskit-node/redis";

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET is not set");

export const db = new Kysely<any>({
  dialect: new SqliteDialect({ database: new Database(process.env.SQLITE_PATH ?? "comms.db") }),
});
await ensureSchema(db);

// Push: Expo for everyone, APNs VoIP for iOS CallKit (null unless the APNS_* variables are set).
const devices = new SqlDeviceRegistry(db);
export const push = new DevicePushRouter({
  registry: devices,
  expo: new ExpoPushSender({ accessToken: process.env.EXPO_ACCESS_TOKEN ?? null }),
  voip: ApnsVoipSender.fromEnv(devices),
  androidCallStyle: "data", // default is "notification"
});

// Several Node processes? Share presence and delivery through Redis. One process: leave these out.
const bridge = process.env.REDIS_URL ? new RedisBridge({ url: process.env.REDIS_URL }) : null;

export const hub = new CommsHub({
  auth: new JwtAuth(secret),
  db,
  users: new StaticUserDirectory({ U1: { name: "Alice", avatar: null } }), // replace with your own UserDirectory
  push,
  ...(bridge ? { connections: new ConnectionManager({ bridge }), rateLimiter: new RedisRateLimiter(bridge) } : {}),
  onHandlerError: (userId, frame, err) => console.error("handler error", userId, err), // send to Sentry etc.
});

hub.install(new DevicesFeature(devices)); // BEFORE ChatFeature: POST /devices, DELETE /devices/:id, legacy token routes
export const chat = hub.install(
  new ChatFeature({ storage: new LocalDiskStorage(process.env.MEDIA_DIR ?? "comms_media", "/media") }),
);
export const call = hub.install(
  new CallFeature({
    config: {
      turnSecret: process.env.TURN_SECRET ?? null,
      turnUris: (process.env.TURN_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  }),
);
linkChatAndCall(chat, call); // chat_id on calls, the "[Call Initiated]" entry, call_log frames

export const moderation = hub.install(
  new ModerationFeature({
    onReport: async (report) => console.log("new report", report.id), // notify your moderators
  }),
);
linkModeration(moderation, { chat, call }); // blocks are enforced; a block ends a live call

await hub.connections.start(); // connects the Redis bridge (does nothing without one)
```

Rules that matter:

- `DevicesFeature` goes **before** `ChatFeature`. Both can mount the legacy `POST /chats/expo/push/token[/remove]` routes; `ChatFeature` skips its copy only when it finds `devices` already installed (`src/chat/router.ts:68`; `test/devices.test.ts`). Do not also pass `devices:` to `ChatFeature`.
- `linkChatAndCall` and `linkModeration` require every feature to be on the same hub, and can be called once each (a second call throws).
- `ModerationFeature` alone does nothing to chat/call. `linkModeration` is what makes blocks enforced: it wraps the chat and call policies you installed, so call it **after** installing them (it takes `chat.policy` as it is at that moment).
- `adminDependency` is required for the admin review routes (file 2, C.2).
- Without `REDIS_URL` the sample runs single-process. With it, install `ioredis`; if the module is missing or Redis is down, the log shows `Redis unavailable (...); running single-worker` and it keeps running (I ran this with the variable set and `ioredis` missing: the warning appeared and chat, call and devices still worked).
- In the Express and `node:http` servers, also call `await push.aclose()` in the shutdown handler if you use the push router (`import { push } from "./comms.js"`).

### 2.6 Create the tables

`ensureSchema(db)` (`src/schema.ts`) creates the 8 kit tables with `CREATE TABLE IF NOT EXISTS`: `chats`, `messages`, `calls`, `comms_devices`, `comms_blocks`, `comms_reports`, `comms_message_hidden`, `comms_chat_cleared` (file 1, section 7).
It detects the dialect from your Kysely instance (SQLite or PostgreSQL) and is idempotent (`test/schema.test.ts` runs it twice).

```ts
import { ensureSchema, KIT_TABLES } from "commskit-node";
await ensureSchema(db);                         // or: await ensureSchema(db, { dialect: "postgres" })
console.log(KIT_TABLES);                        // the 8 names
```

- **Name clash warning:** `chats`, `messages` and `calls` are plain generic names with no prefix option. If your project already has tables with these names, `IF NOT EXISTS` silently skips them and the kit will fail or misbehave on different columns. Check before you install. (These names are the Smart Matrimony originals on purpose, and the same as the Python backend.)
- `ensureSchema` only creates missing tables; it never alters existing ones. In production use migrations (Kysely migrations, Knex, Prisma Migrate, or plain SQL): the DDL text is available as `chatDdl(dialect)`, `callDdl(dialect)`, `devicesDdl(dialect)` and `moderationDdl(dialect)` (exported from the `/chat`, `/call`, `/core` and `/moderation` entries); put it in your first migration.
- **Several processes starting at once:** run `ensureSchema` once in a one-off script (or a migration) before you start the processes. Concurrent `CREATE TABLE IF NOT EXISTS` on PostgreSQL can race (general PostgreSQL behaviour; not tested here).
- **A database created by the Python backend** already has the same tables, so `ensureSchema` does nothing there. Whether a database from an *older* Python kit version needs the manual `comms_reports` column upgrade described in `docs/backend/backend-python/03-using-running-and-deploying.md` section 2.6 is not verified for Node.

SQLite vs PostgreSQL:

| | SQLite (`better-sqlite3`) | PostgreSQL (`pg`) |
|---|---|---|
| Use for | development, tests, the demo | production |
| Kysely dialect | `new SqliteDialect({ database: new Database(file) })` | `new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) })` |
| Timestamps | stored as text `YYYY-MM-DD HH:MM:SS.ffffff` (UTC) | `TIMESTAMP WITH TIME ZONE` (`Date` values) |
| Writers | one at a time (`database is locked` under load; set `PRAGMA busy_timeout`) | many |
| Status here | all tests | DDL text generated and shape-checked only; **never run against a real server** |

PostgreSQL pool: processes x `max` must stay below the server's `max_connections`. A frame that needs the database uses one pooled connection for the length of its query only.

### 2.7 Auth wiring with your existing JWT

The kit needs one thing: given a token string, return the user id (or throw). The same adapter protects the WebSocket (token in the path) and all REST routes (`Authorization: Bearer`).

If your tokens are HS256 with the user id in a claim, use the built-in class (set `claim` to your claim name). Unlike the Python backend, a token with an `aud` claim is **accepted** (file 2, A.1):

```ts
new JwtAuth(process.env.JWT_SECRET!, { algorithm: "HS256", claim: "sub" })
```

Otherwise write an adapter (sync or async; any thrown error means "invalid"):

```ts
import type { AuthAdapter } from "commskit-node/core";
import { decodeMyToken } from "./my-auth.js";      // your existing function; throws when invalid or expired

class HostAuth implements AuthAdapter {
  async userIdFromToken(token: string): Promise<string> {
    const payload = await decodeMyToken(token);
    return String(payload.userId);
  }
}
const hub = new CommsHub({ auth: new HostAuth(), db });
```

To protect your own REST routes with the same check: `const userId = await hub.authenticate(request.headers)` (throws `HttpError` 401 for a missing or bad header). The kit's own routes use it; a sample of your own route was not run.

### 2.8 Plugging policies (blocking, credits)

Verified sample (compiled, and run: a message without a match row was refused with your text; with the row it was delivered; a call without credits got `{"error":"Not enough credits.","status":402,"info":{...},"context":"call"}`; with credits one was charged; a block ended the live call with `end_reason: "blocked"`):

```ts
// src/policies.ts
import type { Db } from "commskit-node/core";
import type { ChatPolicy } from "commskit-node/chat";
import { allow, deny, type CallDecision, type CallPolicy } from "commskit-node/call";

// Your own tables: here a "matches" table and a credit wallet.
export class MyChatPolicy implements ChatPolicy {
  refusalMessage = "You cannot message this user."; // sent as {"type":"error","error": ...}

  async canMessage(db: Db, senderId: string, recipientId: string): Promise<boolean> {
    const match = await db
      .selectFrom("my_matches")
      .select("id")
      .where((eb) => eb.or([
        eb.and([eb("user_a", "=", senderId), eb("user_b", "=", recipientId)]),
        eb.and([eb("user_a", "=", recipientId), eb("user_b", "=", senderId)]),
      ]))
      .executeTakeFirst();
    return match !== undefined; // false: send_message and media_upload are refused, typing is dropped
  }

  // { otherId: [iBlockedThem, theyBlockedMe] }; ids you leave out count as [false, false]
  async blockStatus(_db: Db, _viewerId: string, _otherIds: readonly string[]): Promise<Record<string, [boolean, boolean]>> {
    return {};
  }

  // merged into res_messages.info
  async extraConversationInfo(_db: Db, _viewerId: string, _otherId: string): Promise<Record<string, unknown>> {
    return { chat_consent_given: true };
  }
}

export class MyCallPolicy implements CallPolicy {
  // Runs after busy detection and before the call row exists, so a busy receiver never costs a credit.
  async authorize(db: Db, callerId: string, _receiverId: string, message: Record<string, any>): Promise<CallDecision> {
    const wallet = await db.selectFrom("my_wallets").select("credits").where("user_id", "=", callerId).executeTakeFirst();
    const credits: number = wallet?.credits ?? 0;
    if (credits < 1) return deny("Not enough credits.", { status: 402, info: { credit_balance: credits } });
    await db.updateTable("my_wallets").set({ credits: credits - 1 }).where("user_id", "=", callerId).execute();
    return allow(); // message is the raw call_initiate frame, e.g. message.credit_acknowledged
  }
}
```

Wire them in, then link moderation after (it wraps both policies, so the block list runs first and your policy second):

```ts
const chat = hub.install(new ChatFeature({ policy: new MyChatPolicy() }));
const call = hub.install(new CallFeature({ policy: new MyCallPolicy() }));
linkChatAndCall(chat, call);
const moderation = hub.install(new ModerationFeature());
linkModeration(moderation, { chat, call });
```

`CallPolicy.authorize` runs after busy detection and before the call row exists, so charging here does not charge for busy receivers. Details: file 2, C.1. Note that `db` in policies is the hub's Kysely instance: there is no per-frame transaction, so a "check then charge" like the one above is not atomic. For real credits use `db.transaction().execute(...)` with a row lock, or an atomic `UPDATE ... WHERE credits >= 1`.

### 2.9 Mounting order and route conflicts

The kit adds these top-level paths: `/ws/:token`, `/chats/...`, `/call/...`, `/moderation/...`, `/devices...` (full list: file 2, B.4).

| Situation | What happens (checked unless stated) |
|---|---|
| **Express**: your route and the kit's share a method and path | The first one mounted wins. The kit's `GET /chats/:userId` matches any single segment, so a host `GET /chats/archived` answered `403 {"detail":"Not allowed"}` when `app.use(commskitRouter(hub))` came first, and your handler (`200`) when your route came first. Mount your more specific routes first, or rename them |
| **Fastify**: the same route pattern | Registration fails loudly: `FST_ERR_DUPLICATED_ROUTE: Method 'GET' already declared for route '/chats/:id'`. A static route such as `GET /chats/archived` registered next to the kit's `GET /chats/:userId` without error (Fastify prefers static segments; that request itself was not sent) |
| **`restListener`** | First matching route wins; it answers `false` when nothing matched, and you decide the response |
| Feature installed **after** the adapter was registered | its REST routes are missing (404); its WebSocket frames still work. Install everything first (2.2) |
| `/ws/...` | The WebSocket path is fixed: `/ws/:token`. It cannot be moved with the kit's API. Other `upgrade` paths on the same server are left alone (`hub.attach` only handles `/ws/...`), so you can run your own WebSocket server on another path |
| A path prefix for REST | The adapters have no prefix option. In Express, `app.use("/comms", commskitRouter(hub))` would shift the URLs and the clients would have to use the same prefix (not verified against the mobile/web clients); the WebSocket path would stay `/ws/:token` |
| Two hubs in one process | Not tested; use one hub |

### 2.10 Middleware and cache pitfalls

General Node advice (not specific code in this repo; not tested here, except where stated):

- **Response caching** (CDN page rules, `apicache`, Fastify caching plugins) must never cache `/chats/...`, `/call/...`, `/moderation/...` or `/devices...`. The responses are per user and depend on the `Authorization` header.
- Auth middleware that blocks requests without a header will reject `/ws/<token>` (browsers cannot set headers on WebSockets). The kit's upgrade handling runs on the raw `upgrade` event, outside Express and Fastify middleware, so your HTTP middleware normally does not see it; a reverse proxy or WAF in front does.
- **Body parsers:** `commskitRouter` installs its own `express.json({ limit: "20mb" })` inside the router. A global `express.json()` mounted **before** it with a smaller limit decides first. The Fastify plugin replaces the `application/json` parser **inside the plugin's own scope** only (the plugin is not wrapped in `fastify-plugin`), so your other Fastify routes keep your parser.
- Request-logging or APM middleware records URLs: redact `/ws/` paths (file 2, A.11). With Fastify's built-in logger the upgrade request is not logged (checked: no `/ws/` line in the log of the Fastify sample), but nginx, ALB and APM tools still see it.
- Compression is fine for REST; do not apply it to the WebSocket.
- CORS: if a web client on another origin calls the REST routes, add `@fastify/cors` or `cors` with exact origins. WebSockets are not subject to CORS, and the kit does not check the `Origin` header; the token in the path is the only protection.
- Graceful shutdown: call `hub.shutdown()` on SIGTERM (the Express and `node:http` samples do; Fastify's plugin does it on `app.close()`). Without it, call timers and sockets are dropped abruptly.

### 2.11 Server-side helpers you may need

- `await chat.sendMessageAs("U1", "U2", "hello")` and `await chat.sendSystemMessage("U2", "You matched with Asha", { aboutUserId: "U1" })` send messages from your own code (`src/chat/feature.ts`).
- `await deleteUserEverywhere(hub, userId)` (from `commskit-node/integration`) in your delete-account flow.
- `hub.events.on("call.finalized", fn)` and the other events (file 1, section 6; list in `src/core/events.ts`).
- `hub.on("my_frame_type", async (userId, message, db) => { ... })` for host-only WebSocket frames; `hub.send(userId, payload)` to push a frame to one user; `hub.joinRoom` / `hub.broadcastRoom`.
- `hub.authenticate(headers)` for your own REST routes (2.7).

---

## 3. Running locally from a clean machine

This runs the kit's own tests and then the **demo server** (`examples/backend/demo-server-node/server.mjs`, see [`../../example/backend-node-example.md`](../../example/backend-node-example.md)): SQLite, three fixed users, tokens handed to anyone. Development only.

### 3.1 Install, test and build

```powershell
# Windows PowerShell
git clone <your-repo-url> comms-kit
cd comms-kit\backend\backend-node
npm install
npx tsc --noEmit                            # type check: no output means no errors
npm test                                    # expect: 172 passed, 1 skipped (as of 2026-10-26), about 10 s
npm run build                               # creates dist/ (needed by everything that imports commskit-node)
npm run smoke                               # runs the BUILT package: expect "dist smoke test: all checks passed"
```

```bash
# Linux / macOS
git clone <your-repo-url> comms-kit
cd comms-kit/backend/backend-node
npm install
npx tsc --noEmit
npm test
npm run build
npm run smoke
```

Node 20 or newer. The numbers above are from my run (Node 22.23.2 on Windows); Linux and macOS were not run. `better-sqlite3` is a native module: `npm install` downloads a prebuilt binary, and if none exists for your Node version it needs a C++ toolchain (node-gyp).
The one skipped test needs a `redis-server` binary on `PATH` and is optional.

### 3.2 Start the demo server

```powershell
# Windows PowerShell (from comms-kit\backend\backend-node, after npm run build)
cd ..\..\examples\backend\demo-server-node
npm install
npm start                                   # http://localhost:8000  (same as: node server.mjs --port 8000)
# chat only:  $env:COMMS_FEATURES="chat"; npm start
```

```bash
# Linux / macOS
cd ../../examples/backend/demo-server-node
npm install
npm start
# chat only:  COMMS_FEATURES=chat npm start
```

The demo server depends on `commskit-node` through `"file:../../../backend/backend-node"`, so `backend/backend-node/dist` must exist first (3.1). I started it with `node server.mjs --port 8141` on 2026-10-26 (with `COMMS_DEMO_DATA` pointing to a scratch folder) and got:
`GET /dev/users` listing Alice, Bob and Carol, `GET /dev/token/U1` returning a token, `GET /` serving the demo page (`200 text/html`), and `{"detail":"Not Found"}` for an unknown path. The two-browser chat and call flow was not driven here.
Change the port with `--port` or `PORT`; to reach it from a phone add `--host 0.0.0.0`. Environment variables: file 2, A.8. In PowerShell the variable stays set for that window; clear it with `Remove-Item Env:COMMS_FEATURES`.

### 3.3 Test with two users in the browser

1. Open `http://localhost:8000/#U1` in one tab (Alice) and `http://localhost:8000/#U2` in a second tab or another browser (Bob). `#U1:U2` opens the chat with Bob directly. `U3` is Carol.
2. Send messages, files (max 10 MB), try typing, read ticks.
3. For a call: press the phone button in one tab, **Accept** in the other, allow the microphone. Use headphones, or the two tabs echo.
4. The `</>` button shows every WebSocket frame.

The page is the same one the Python demo serves (the Node demo reads the page files from `examples/backend/demo-server-python/`). Microphone access works only on `localhost` or HTTPS.

### 3.4 Web and Expo example clients

Both speak the same protocol, so they should work against the Node demo server unchanged; I did not run them against it here.

- Web (React): [`examples/web-app/README.md`](../../../examples/web-app/README.md) and [`../../example/web-example.md`](../../example/web-example.md). Start the demo server with `COMMS_FEATURES=chat`, then `cd examples/web-app && npm install && npm run dev` (`http://localhost:5173`).
  If the web app is hosted separately without the proxy, set `COMMS_CORS_ORIGINS="http://localhost:5173"` on the server.
- Expo (phones): [`examples/expo-app/README.md`](../../../examples/expo-app/README.md) and [`../../example/mobile-example.md`](../../example/mobile-example.md). Start the server with `--host 0.0.0.0 --port 8000` and sign in with `http://<your-PC-LAN-IP>:8000`. Needs a development build (not Expo Go).
- To run the existing browser tests and the web e2e against the **Node** server instead of the Python one, see `DEMO_BACKEND=node` in [`../../example/backend-node-example.md`](../../example/backend-node-example.md).

### 3.5 Where data lives, and how to reset

| What | Where |
|---|---|
| Database | `examples/backend/demo-server-node/.demo_data/demo.db` (SQLite, WAL mode: also `demo.db-wal` / `demo.db-shm`) |
| Uploaded files | `examples/backend/demo-server-node/.demo_data/media/` |
| Change the folder | `COMMS_DEMO_DATA=<folder>` |

Reset: stop the server, delete the folder, start again (tables are recreated on startup).

```powershell
Remove-Item -Recurse -Force examples\backend\demo-server-node\.demo_data   # from comms-kit\
```

```bash
rm -rf examples/backend/demo-server-node/.demo_data    # from comms-kit/
```

`examples/backend/demo-server-node/.gitignore` exists (its content was not checked in detail).

### 3.6 Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Cannot find package 'commskit-node'` / `Cannot find module .../backend-node/dist/...` | `dist/` is not built. Run `npm run build` in `backend/backend-node` (it is git-ignored). Not reproduced here, but the package `main`/`exports` all point into `dist/` |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` with `require(...)` | The package is ESM only. Use `import`, or `await import("commskit-node/core")` from CommonJS |
| TypeScript `TS2307: Cannot find module 'commskit-node/core'` | `moduleResolution` is `node`/`node10`. Use `Bundler`, `Node16` or `NodeNext` |
| TypeScript `TS1378` top-level await | Use `module: ESNext` (or `NodeNext`) and `target: ES2022`, and `"type": "module"` in `package.json` |
| `Cannot find package 'kysely'` after a folder install | Folder installs do not hoist the kit's dependencies. `npm install kysely` in your project (2.1) |
| `Cannot detect the SQL dialect (adapter ...); pass { dialect } to the hub` | A Kysely dialect whose adapter name has no `postgres`/`sqlite` in it. Pass `dialect: "postgres"` or `"sqlite"` to `new CommsHub({...})` (and to `SqlDeviceRegistry`, `ensureSchema`) |
| `JwtAuth needs a non-empty secret` | `JWT_SECRET` (or your variable) is not set (the samples fail earlier with `JWT_SECRET is not set`) |
| `Feature 'chat' is already installed on this hub` | Feature installed twice on one hub |
| `no such table: chats` (SQLite) or `relation "chats" does not exist` (PostgreSQL) | Tables not created. Run `await ensureSchema(db)` (2.6) |
| WebSocket closes at once with code **1008** | The token was rejected: wrong secret, expired `exp`, missing claim (default `uid`). The reason is logged at `info` level (`WS auth failed: ...`), which the default logger does not print: pass `logger: { info: console.log, warn: console.warn, error: console.error }` to the hub to see it |
| WebSocket closes with **1011** | Server error while setting up the connection; check the server log (`WS setup for <id> crashed`) |
| `ECONNREFUSED` on `ws://.../ws/...`, or the connection is dropped without a response | Wrong port, or your proxy does not forward `Upgrade`. The path must be exactly `/ws/<token>` (no extra segments; any other path makes the kit destroy the socket) |
| REST `401 Not authenticated` / `Invalid token` | Missing `Authorization: Bearer <token>` header, or bad token |
| REST `403 Not allowed` on `/chats/:userId` | The path user id is not the token's user (only your own list is allowed). In Express it can also be the kit route shadowing yours (2.9) |
| REST `404 Chat not found` | The chat does not exist or you are not a participant |
| REST `404` on a kit route | The feature was installed after the adapter was registered, or the feature is not installed (2.2) |
| REST `422` | Missing or invalid field: `candidate_id` (query) on `/chats/start`; `candidate_user_id` and `content` on `/chats/send`; `reason` on `/moderation/reports`; `device_id` / `platform` (ios, android, web) on `/devices`; `limit` outside 1 to 100 |
| REST `429` | Rate limit; see the `Retry-After` header. Limits: file 2, A.9 |
| `503 TURN is not configured` on `/call/turn-credentials` | `CallConfig.turnSecret` is not set |
| `EADDRINUSE` | Port taken. Use another `PORT`, or find the process: PowerShell `Get-NetTCPConnection -LocalPort 8080`, bash `lsof -i :8080` |
| `database is locked` (SQLite) | SQLite allows one writer. The demo sets `busy_timeout` 30 s. Do not use SQLite for real load; use PostgreSQL |
| `[commskit] Redis unavailable (...); running single-worker` | Redis could not be reached at `hub.connections.start()`, or `ioredis` is missing (`RedisBridge needs ioredis: npm install ioredis`; seen in my run). Fix it, or cross-process delivery stays off |
| Redis configured but nothing is shared between processes | `await hub.connections.start()` was never called (the adapters do not call it) |
| `S3Storage needs @aws-sdk/client-s3: npm install ...` | Install the AWS SDK peers (2.1) |
| Messages saved but not live, or users seem offline, with several processes | No Redis bridge. Run one process, or configure `RedisBridge` (file 2, B.5) |
| Uploaded image links give 404 | `LocalDiskStorage` does not serve files. Serve the folder (the demo serves `/media`) or use S3 |
| "File too large. Maximum allowed size is 10 MB." | Over `ChatConfig.maxUploadBytes` |
| No push notifications | Default `NoopPush` sends nothing. Configure `DevicePushRouter`; the device must have registered a token (`POST /devices`) |
| Call connects on Wi-Fi, not on mobile data | No TURN. Set up coturn and `TURN_SECRET` / `TURN_URIS` |
| `[commskit] Send to X failed: socket not open` right after a client disconnects | Normal: a frame raced with the socket closing (seen in my test runs) |
| Microphone permission never appears | Browsers allow the microphone only on `localhost` or HTTPS |

---

## 4. Deploying to a server

### 4.1 What hosting works

You need a **long-running Node process that accepts WebSocket connections** and keeps state in memory between requests.

- Works: a VPS (Ubuntu), a container platform with persistent processes (Render web service, Railway, Fly.io, ECS, Kubernetes, a plain Docker host).
- Does **not** work: serverless functions with short timeouts and no persistent sockets (Vercel functions, AWS Lambda, Netlify functions, Cloudflare Workers). They cannot hold `/ws/<token>` open or run the call timers. The kit uses Node APIs (`node:http` upgrade, `node:http2`, `ws`), so Workers-style runtimes are out.
- Static front-ends (web app) can sit on any static host; only the API process needs the above.

Recommended starting stack (a suggestion, not a requirement in the repo): one Ubuntu 22.04/24.04 VPS or one PaaS web service + managed PostgreSQL + (when scaling) managed Redis + S3 + a **separate small VM for coturn** (it needs a public IP and a UDP port range).

### 4.2 Production app skeleton

Your project's `src/server.ts` (not part of the kit): the mode C wiring from 2.5 plus a health route and no demo endpoints. Register the health route **before** `listen` (Fastify) or before the kit router (Express). These two snippets were run on SQLite (`200 {"ok":true}`):

```ts
// Fastify: next to app.register(commskitPlugin, ...)
import { sql } from "kysely";
import { db } from "./comms.js";
app.get("/healthz", async () => {
  await sql`select 1`.execute(db);   // throws (HTTP 500) when the database is unreachable
  return { ok: true };
});
```

```ts
// Express: before app.use(commskitRouter(hub))
app.get("/healthz", async (_req, res) => {
  try {
    await sql`select 1`.execute(db);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
```

Do not rely on `ensureSchema` at startup in production once you have migrations (it is harmless but not a migration tool), and use a Kysely `PostgresDialect` instead of SQLite:

```ts
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
export const db = new Kysely<any>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) }),
});
```

(PostgreSQL is **not verified** with the kit; the snippet is the standard Kysely setup and was not run.)

Scripts for your `package.json` (compile with `tsc`, run the output):

```json
{
  "scripts": { "build": "tsc", "start": "node dist/server.js" }
}
```

### 4.3 Environment file template

Save as `.env.example` in your project; copy to the server as `/etc/myapp/comms.env` (mode 600) and fill in. All values are dummies. Your code must read these (the kit itself reads only `APNS_*`, `FFMPEG_PATH`, `FFPROBE_PATH`, `HOSTNAME`; file 2, A.0).

```ini
# --- required ---
DATABASE_URL=postgresql://comms:CHANGE_ME@127.0.0.1:5432/comms
JWT_SECRET=CHANGE_ME_64_HEX_CHARS
PORT=8080

# --- several processes or servers ---
REDIS_URL=redis://:CHANGE_ME@127.0.0.1:6379/0

# --- media (S3 via the AWS SDK default credential chain) ---
S3_BUCKET=my-app-chat-media
AWS_REGION=ap-south-1
# AWS_ACCESS_KEY_ID=AKIADUMMYDUMMY0000        # not needed on AWS with an IAM role
# AWS_SECRET_ACCESS_KEY=CHANGE_ME

# --- calls ---
TURN_SECRET=CHANGE_ME_64_HEX_CHARS
TURN_URIS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp

# --- push ---
EXPO_ACCESS_TOKEN=CHANGE_ME
APNS_KEY_PATH=/etc/myapp/AuthKey_ABC123DEFG.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_BUNDLE_ID=com.example.myapp
# APNS_USE_SANDBOX=1                          # only for development builds

# --- optional ---
# FFMPEG_PATH=/usr/bin/ffmpeg
# FFPROBE_PATH=/usr/bin/ffprobe
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (works in PowerShell and bash).
Load the file with `node --env-file=/etc/myapp/comms.env dist/server.js` (Node 20.6 or newer; I checked that `--env-file` reads a file on Node 22.23.2; variables that are already set in the environment win over the file), or let your process manager do it (4.9).
Add `.env` to `.gitignore`. Do not use the demo variables (`COMMS_*`) in production.

### 4.4 PostgreSQL

```bash
sudo apt install postgresql
sudo -u postgres psql -c "CREATE USER comms WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE comms OWNER comms;"
```

URL for the app: `postgresql://comms:CHANGE_ME@127.0.0.1:5432/comms` (install `pg`). For a managed database add TLS settings as your provider documents (the `pg.Pool` option `ssl`; check the provider docs, not verified here).
Create tables with migrations (2.6). A first-time setup can run `ensureSchema(db)` once from a one-off script.
Keep processes x pool `max` below Postgres `max_connections`.
PostgreSQL is **not verified in this repo's tests**: do a full chat and call test against a staging PostgreSQL before launch. Known unknown: `BIGINT` columns come back from `pg` as strings by default.

### 4.5 Redis

Needed only for more than one Node process/instance (file 2, B.5).

```bash
sudo apt install redis-server           # then set 'requirepass' and 'bind 127.0.0.1' in /etc/redis/redis.conf
npm install ioredis
```

In code (already in the mode C sample): `connections: new ConnectionManager({ bridge })`, `rateLimiter: new RedisRateLimiter(bridge)`, and `await hub.connections.start()`.
Remember: if Redis is down at startup, the kit only logs a warning and runs without sharing. Alert on the log line `Redis unavailable`.
Not verified against a real Redis in this repo's tests (fake Redis only).

### 4.6 S3 bucket

- Create a **private** bucket, turn on "Block all public access" and default encryption (SSE).
- Use `new S3Storage({ bucket: "my-app-chat-media", region: "ap-south-1", prefix: "prod", private: true })` and pass it as `ChatFeature({ storage })`. The default is `private: false`, which produces public-style URLs that will not work on a private bucket (file 2, A.6).
- Give the app an IAM role (or user) with this minimal policy (derived from the S3 commands the code sends; not tested against real S3):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::my-app-chat-media/prod/*"
  }]
}
```

- Presigned URLs are stored at upload time and last at most 7 days; plan to refresh them with `storage.presign(url)` when you return messages (file 2, C.4).
- Add a lifecycle rule that matches your retention policy.
- `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner sharp`.

### 4.7 TURN server (coturn)

Needed for calls over mobile data and strict networks. Run it on its own VM with a public IP.

```bash
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf` (untested sample; replace the placeholders):

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=CHANGE_ME_SAME_AS_TURN_SECRET   # must equal CallConfig.turnSecret / TURN_SECRET
realm=turn.example.com
server-name=turn.example.com
external-ip=203.0.113.10                           # public IP (use PUBLIC/PRIVATE if behind NAT)
min-port=49152
max-port=65535
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
total-quota=200
no-cli
```

Firewall (ufw example):

```bash
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp && sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

In the API: `TURN_SECRET` = the same string as `static-auth-secret`; `TURN_URIS` = `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`.
The clients fetch temporary credentials from `POST /call/turn-credentials` (verified in the call-only run: it returned `{username, password, ttl, uris}`). The relay itself was not tested. Test with a client on mobile data, or with a "Trickle ICE" page in a browser using a relay-only test. Not verified in this repo.

### 4.8 TLS, HTTPS and WSS (nginx + certbot)

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

Then use the server block in file 2, section B.6 (WebSocket upgrade, long `proxy_read_timeout`; change the upstream port to match your `PORT`) and the redacted access log in file 2, A.11. Browsers and apps then use `https://api.example.com` and `wss://api.example.com/ws/<token>`.
Certbot renews automatically via a systemd timer or cron (check with `sudo certbot renew --dry-run`). Alternatively terminate TLS in Node (`https.createServer`, then `hub.attach(server)`); not tested here, and a reverse proxy is the usual choice.

### 4.9 Process manager

Run Node behind nginx. With no Redis use **exactly one process**; with Redis you may use more.

`/etc/systemd/system/myapp.service` (untested sample):

```ini
[Unit]
Description=My app with commskit-node
After=network.target postgresql.service

[Service]
User=myapp
Group=myapp
WorkingDirectory=/srv/myapp
EnvironmentFile=/etc/myapp/comms.env
ExecStart=/usr/bin/node /srv/myapp/dist/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now myapp
journalctl -u myapp -f
```

`EnvironmentFile` takes `KEY=value` lines without `export`; keep values that contain `#` quoted. Do not print the environment with `systemctl show` on a server where others have access: it would show secrets. Untested.

PM2 alternative (untested): `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: "myapp",
    script: "dist/server.js",
    exec_mode: "fork",          // one process. "cluster" with instances > 1 ONLY together with Redis
    instances: 1,
    node_args: "--env-file=/etc/myapp/comms.env",
    max_memory_restart: "1G",
    kill_timeout: 30000,
  }],
};
```

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

- `LimitNOFILE` matters: every open WebSocket is a file descriptor.
- Several processes (PM2 cluster, `node:cluster`, several containers) need Redis (4.12). Each process gets its own server id (`HOSTNAME-pid-random`, `src/core/connections.ts:92`).
- Restarting the process drops all sockets; clients reconnect. A call ringing in a restarted process loses its ring timer (file 2, B.5).
- Handle `SIGTERM` by calling `hub.shutdown()` (the Express and `node:http` samples in 2.3 do).

### 4.10 Docker (untested)

`Dockerfile` for **your** app, with the tarball from 2.1 option 2 in `vendor/` (adjust paths; your `package.json` has `"commskit-node": "file:vendor/commskit-node-0.1.0.tgz"`):

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# optional: ffmpeg for video thumbnails / durations
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

`docker-compose.yml` (untested; nginx/TLS and coturn are not included):

```yaml
services:
  app:
    build: .
    env_file: .env                 # see 4.3; set DATABASE_URL host to "db" and REDIS_URL host to "redis"
    depends_on: [db, redis]
    ports: ["8080:8080"]           # put nginx or your platform's router in front for TLS
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: comms
      POSTGRES_PASSWORD: CHANGE_ME
      POSTGRES_DB: comms
    volumes: [dbdata:/var/lib/postgresql/data]
  redis:
    image: redis:7
    command: ["redis-server", "--requirepass", "CHANGE_ME"]
volumes:
  dbdata:
```

If you use `LocalDiskStorage` in a container, mount a volume for its folder. Prefer S3. Everything in this section is untested: no Docker build was run for this document.

### 4.11 Logging and redaction

- The kit has one logger (`src/core/logger.ts`): `warn` and `error` go to the console with a `[commskit]` prefix, `info` is silent. Plug in your own with `new CommsHub({ logger })` (or `setLogger`), for example a pino child logger wrapped as `{ info, warn, error }`. The logger is process-wide.
- Messages worth alerting on (found in the code): `Redis unavailable`, `Handler for ... failed`, `Push to ... failed`, `WS setup for ... crashed`, `REST ... failed`, `Listener for ... failed`, `onReport hook failed`, `APNs request failed`.
- Redact `/ws/<token>` in every access log (file 2, A.11).
- Do not log message contents; the kit does not log them (it logs errors and exceptions).
- Use `onHandlerError` on the hub to forward handler exceptions to your error tracker.

### 4.12 Scaling to multiple processes or servers

1. `npm install ioredis`, create `new RedisBridge({ url })`, pass `new ConnectionManager({ bridge })` and `new RedisRateLimiter(bridge)` into `new CommsHub({...})` (the mode C sample does this when `REDIS_URL` is set).
2. `await hub.connections.start()` at startup; `await hub.shutdown()` on exit.
3. Raise the PM2 `instances`, or add containers/servers behind the load balancer. No sticky sessions needed.
4. Remember the in-process call timers (file 2, B.5).
5. Run `ensureSchema` / migrations once, not in every process (2.6).
6. Load-test before launch (not done in this repo; one Node process is single-threaded).

### 4.13 Backups and monitoring

| Topic | Suggestion |
|---|---|
| Database | Automated daily backups plus point-in-time recovery if your provider offers it; run a restore test. This is where chats, messages and calls live |
| Media | S3 versioning or cross-region replication if the files matter |
| Redis | Holds only presence, pub/sub and rate-limit buckets; no backup needed |
| Secrets | Keep a copy of `JWT_SECRET`, `TURN_SECRET` and the APNs `.p8` in your secret manager (the `.p8` can be downloaded from Apple only once) |
| Health | Uptime check on `/healthz` (your route, 4.2) |
| Logs | journald, PM2 logs or your platform logs; alert on the messages in 4.11 |
| Errors | `onHandlerError` to Sentry or similar; also listen for `unhandledRejection` in your process |
| Capacity | Watch open file descriptors, DB pool usage, memory (each socket and in-memory bucket costs RAM) and event-loop lag |
| TURN | coturn logs and bandwidth; quotas in `turnserver.conf` |
| Push | Check logs after testing with an uninstalled app: invalid tokens should be removed |

---

## 5. "What do I need" checklist

| Item | Local (minimum) | Production | Why | Where to get it |
|---|---|---|---|---|
| Node.js 20+ | Required | Required | Runs the code | nodejs.org, or your OS packages |
| Package install | folder install of `backend/backend-node` after `npm run build` | tarball (`npm pack`) committed or in a private registry, with the peers you need | The kit | section 2.1 |
| HTTP server | Fastify, Express or `node:http` | same, behind a reverse proxy | Serves HTTP and WebSocket | your project |
| Database | SQLite + `better-sqlite3@11` | PostgreSQL + `pg`, backups | Chats, messages, calls | Managed Postgres or your VPS |
| `JWT_SECRET` (or own `AuthAdapter`) | Demo secret (dev only) | Your real secret, in a secret manager | Validates user tokens | Your login system; `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Login endpoint that issues tokens | Demo `/dev/token/:id` | Your own | The kit does not log anyone in | Your app |
| `UserDirectory` | Demo `StaticUserDirectory` | Your own | Names and avatars | Your user table |
| Policies (`ChatPolicy`, `CallPolicy`) | Allow-all | Your rules (blocking, credits) | Who may talk or call | Your product logic (2.8) |
| Reverse proxy + TLS | Not needed (`localhost`) | nginx or platform router, certbot | `wss://`, browser mic needs HTTPS | Let's Encrypt |
| Redis | Not needed | Needed for more than 1 process/instance | Cross-process delivery and presence | Managed Redis or your VPS; `ioredis` |
| Media storage | `LocalDiskStorage` (you serve the folder; the demo serves `/media`) | `S3Storage({ private: true })` | Files and thumbnails | AWS S3 + IAM role |
| TURN server | Not needed on one LAN | coturn + `TURN_SECRET` + `TURN_URIS` | Calls over mobile data / NAT | Own VM, coturn |
| Device registration + Expo push | Optional | `SqlDeviceRegistry`, `ExpoPushSender`, `EXPO_ACCESS_TOKEN` | Notifications when the app is closed | expo.dev |
| APNs VoIP key | Optional (iOS CallKit) | `.p8`, key id, team id, bundle id | Ringing on a closed iPhone | Apple Developer account |
| Moderation hook (`onReport`) and admin auth | Prints | Notify a real queue; `adminDependency` | App-store rules on user-generated content | Your ops |
| Migrations | `ensureSchema` | Your migration tool | Safe schema changes | Kysely migrations or similar |
| Health check, logging, redaction, error tracking | Not needed | Required | Operations and privacy | Sections 4.2, 4.11 |
| Account deletion flow | n/a | `deleteUserEverywhere` | Privacy and store requirements | Your app |

---

## 6. Go-live checklist

Short version of the go-live steps.

- [ ] `examples/backend/demo-server-node/server.mjs` and `/dev/token/:id` are not deployed.
- [ ] `JWT_SECRET` is a fresh random value (at least 32 bytes); tokens have a short `exp`; you decided whether `aud` matters (the kit does not check it).
- [ ] No secrets in git or in client bundles (file 2, A.11).
- [ ] HTTPS and WSS work; proxy timeouts at least 120 s; `/ws/<token>` redacted from logs.
- [ ] PostgreSQL with backups and a tested restore; tables created by migrations; no table-name clash with `chats`, `messages`, `calls`; a full chat and call test passed on PostgreSQL (not verified by the kit).
- [ ] `S3Storage({ private: true })` with a private bucket and minimal IAM; the presigned-URL expiry is handled.
- [ ] Redis configured, `hub.connections.start()` called and monitored if more than one process; otherwise exactly one process.
- [ ] coturn reachable on 3478/5349 and the relay port range; `TURN_SECRET` matches; a call works on mobile data.
- [ ] Push works end to end: Expo token registered, a message push arrives, an incoming-call push arrives (iOS VoIP only if APNs is set up).
- [ ] Policies implemented (blocking, credits, consent) instead of allow-all; credit charging is atomic.
- [ ] `onReport` goes to a monitored place; admin review route protected; you review reports in time.
- [ ] Account deletion calls `deleteUserEverywhere`; a retention job clears call SDP/ICE data.
- [ ] Health check route, error tracking, log alerts and graceful shutdown (`hub.shutdown()` on SIGTERM) in place.
- [ ] Servers' clocks are synchronised (the kit uses the application clock, not the database clock).
- [ ] Load test with realistic socket counts (not done in this repo).
- [ ] Privacy policy and store paperwork completed for your app.

Not verified in this repo's tests: real Redis, real S3, PostgreSQL, coturn, APNs, Expo, nginx, systemd, PM2, Docker.
