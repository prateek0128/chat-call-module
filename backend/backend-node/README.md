# commskit-node

Node.js / TypeScript server for the commskit wire protocol. It is a sibling of the Python backend
(`../backend-python`, package `commskit`) and speaks exactly the same protocol
([`../../docs/archive/PROTOCOL.md`](../../docs/archive/PROTOCOL.md)), so the existing clients (`mobile/`, `web/`,
`examples/backend/demo-server-python` page) work against it unchanged. A database created by either backend works with the other
(same table and column names).

**Status: feature-complete.** Core, chat, call signalling, moderation (block / report / admin review),
devices + push (Expo, Apple VoIP), the Redis bridge and S3 storage are implemented. 172 tests pass (1 more is
skipped: it needs a real `redis-server`). Redis, S3, Expo and APNs are tested with fakes, not real services.
Guides: [`../../docs/backend/backend-node/`](../../docs/backend/backend-node/).

Stack: TypeScript (strict), Node >= 20, ESM, `ws`, `kysely` (better-sqlite3 for tests/demo, `pg` for production),
`jose` (HS256 JWT, claim `uid`), tsup, vitest.

## Install

```bash
npm install commskit-node kysely ws jose
npm install better-sqlite3      # or: pg
npm install fastify             # or: express   (optional peer dependencies)
```

## Fastify (chat only)

```ts
import Fastify from "fastify";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ChatFeature, CommsHub, JwtAuth, ensureSchema } from "commskit-node";
import { commskitPlugin } from "commskit-node/fastify";

const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database("comms.db") }) });
await ensureSchema(db); // creates chats, messages, calls, comms_* tables (idempotent)

const hub = new CommsHub({ auth: new JwtAuth(process.env.JWT_SECRET!), db });
hub.install(new ChatFeature());               // allow-all policy, LocalDiskStorage("comms_media")

const app = Fastify();
await app.register(commskitPlugin, { hub });  // REST routes + /ws/:token upgrade
await app.listen({ port: 8080 });
```

## Express (chat only)

```ts
import { createServer } from "node:http";
import express from "express";
import { commskitRouter, attach } from "commskit-node/express";

const app = express();
app.use(commskitRouter(hub));                 // /chats/...
const server = createServer(app);
attach(server, hub);                          // /ws/:token
server.listen(8080);
```

No framework: `createServer((req, res) => restListener(hub)(req, res))` plus `hub.attach(server)`.

## Python name mapping

| Python (`commskit`) | Node (`commskit-node`) |
|---|---|
| `CommsHub(auth=, session_factory=, users=, push=, ...)` | `new CommsHub({ auth, db, users, push, connections, rateLimiter, roleResolver, onHandlerError, cameOnlineCooldown })` |
| `ChatFeature(...).install(hub)` | `hub.install(new ChatFeature({ policy, storage, devices, config }))` |
| `ChatConfig`, `ChatPolicy`, `AllowAllChatPolicy` | `ChatConfig` (partial object), `ChatPolicy`, `AllowAllChatPolicy` |
| `JwtAuth`, `StaticUserDirectory`, `NullUserDirectory`, `NoopPush`, `LocalDiskStorage` | same names |
| `ConnectionManager`, `PresenceBridge`, `RateLimiter`, `RateLimit` | same names |
| `hub.on(type, handler)`, `hub.on_connect`, `hub.on_disconnect` | `hub.on`, `hub.onConnect(hook, allRoles?)`, `hub.onDisconnect` |
| `hub.events.on("chat.message_sent", fn)` | same event names |
| `chat.send_message_as`, `chat.send_system_message`, `chat.delete_user_data` | `chat.sendMessageAs`, `chat.sendSystemMessage`, `chat.deleteUserData` |
| `hub.ws_router()` / `hub.rest_router()` | `hub.attach(server)` / `hub.handleUpgrade(...)` and `hub.restRoutes()` |
| `CommsBase.metadata.create_all` | `ensureSchema(db)` |

Handlers receive `(userId, message, db)`; `db` is the hub's Kysely instance (the per-frame "session"; use
`db.transaction()` where you need atomicity).

## Develop

```bash
npm install
npm run typecheck && npm test && npm run build
python test/golden/generate_golden.py   # re-record the golden frames from the Python backend (optional)
```

`test/golden.test.ts` replays a scripted exchange against this server and requires frames identical (after
id/timestamp normalisation) to the fixtures recorded from the Python backend.
