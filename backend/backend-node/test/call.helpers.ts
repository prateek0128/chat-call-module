/** Test harness for the call feature (chat-only helpers live in helpers.ts). */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import WebSocket from "ws";
import { type CallConfig, CallFeature, type CallPolicy } from "../src/call/index.js";
import { ChatFeature, CommsHub, JwtAuth, LocalDiskStorage, StaticUserDirectory, ensureSchema, restListener } from "../src/index.js";
import { linkChatAndCall } from "../src/integration/chatCall.js";
import { PROFILES, RecordingPush, type RestResponse, SECRET, WsClient, token } from "./helpers.js";

export interface CallEnv {
  hub: CommsHub;
  chat: ChatFeature | null;
  call: CallFeature;
  db: Kysely<any>;
  push: RecordingPush;
  ws(userId: string): Promise<WsClient>;
  rest(method: string, urlPath: string, userId?: string | null, body?: unknown): Promise<RestResponse>;
  post(urlPath: string, userId?: string | null, body?: unknown): Promise<RestResponse>;
  close(): Promise<void>;
}

export interface CallEnvOptions {
  chat?: boolean;
  link?: boolean;
  policy?: CallPolicy;
  config?: Partial<CallConfig>;
}

const open: Array<() => Promise<void>> = [];

export async function makeCallEnv(opts: CallEnvOptions = {}): Promise<CallEnv> {
  const withChat = opts.chat ?? false;
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureSchema(db);
  const mediaDir = mkdtempSync(path.join(tmpdir(), "commskit-media-"));
  const push = new RecordingPush();
  const hub = new CommsHub({ auth: new JwtAuth(SECRET), db, users: new StaticUserDirectory(PROFILES), push });
  const chat = withChat ? hub.install(new ChatFeature({ storage: new LocalDiskStorage(mediaDir) })) : null;
  const call = hub.install(new CallFeature({ policy: opts.policy, config: opts.config }));
  if (chat && (opts.link ?? true)) linkChatAndCall(chat, call);

  const rest = restListener(hub);
  const server = createServer(async (req, res) => {
    if (!(await rest(req, res))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    }
  });
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const clients: WsClient[] = [];

  const env: CallEnv = {
    hub,
    chat,
    call,
    db,
    push,
    async ws(userId) {
      const sock = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/${await token(userId)}`);
      const client = new WsClient(sock);
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        sock.once("open", () => resolve());
        sock.once("error", reject);
      });
      await client.handshake();
      return client;
    },
    async rest(method, urlPath, userId = null, body) {
      const h: Record<string, string> = {};
      if (userId) h.authorization = `Bearer ${await token(userId)}`;
      if (body !== undefined) h["content-type"] = "application/json";
      const res = await fetch(baseUrl + urlPath, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    },
    post: (p, u, b) => env.rest("POST", p, u, b),
    async close() {
      for (const c of clients) await c.close();
      await hub.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await db.destroy();
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
  open.push(() => env.close());
  return env;
}

export async function closeAllCall(): Promise<void> {
  for (const fn of open.splice(0)) await fn();
}
