/**
 * Test harness for phase-2B features: like helpers.ts `makeEnv`, but the caller installs features BEFORE the REST listener
 * is built (makeEnv snapshots the routes right after installing chat). Reuses WsClient / token / RecordingPush.
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { CommsHub, JwtAuth, type CommsHubOptions, StaticUserDirectory, ensureSchema, restListener } from "../src/index.js";
import { PROFILES, RecordingPush, SECRET, WsClient, token } from "./helpers.js";

export interface FeatureEnv {
  hub: CommsHub;
  db: Kysely<any>;
  push: RecordingPush;
  baseUrl: string;
  ws(userId: string): Promise<WsClient>;
  rest(method: string, urlPath: string, userId?: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  get(urlPath: string, userId?: string | null, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  post(urlPath: string, userId?: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

const open: Array<() => Promise<void>> = [];

export async function makeFeatureEnv(setup: (hub: CommsHub, db: Kysely<any>) => void | Promise<void>, hubOptions: Partial<CommsHubOptions> = {}): Promise<FeatureEnv> {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureSchema(db);
  const push = new RecordingPush();
  const hub = new CommsHub({ auth: new JwtAuth(SECRET), db, users: new StaticUserDirectory(PROFILES), push, ...hubOptions });
  await setup(hub, db);
  const rest = restListener(hub);
  const server: Server = createServer(async (req, res) => {
    if (!(await rest(req, res))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    }
  });
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients: WsClient[] = [];
  const env: FeatureEnv = {
    hub, db, push, baseUrl,
    async ws(userId) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${await token(userId)}`);
      const c = new WsClient(ws);
      clients.push(c);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      await c.handshake();
      return c;
    },
    async rest(method, urlPath, userId = null, body, headers = {}) {
      const h: Record<string, string> = { ...headers };
      if (userId) h.authorization = `Bearer ${await token(userId)}`;
      if (body !== undefined) h["content-type"] = "application/json";
      const res = await fetch(baseUrl + urlPath, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    get: (p, u, h) => env.rest("GET", p, u, undefined, h),
    post: (p, u, b, h) => env.rest("POST", p, u, b, h),
    async close() {
      for (const c of clients) await c.close();
      await hub.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await db.destroy();
    },
  };
  open.push(() => env.close());
  return env;
}

export async function closeAllFeatureEnvs(): Promise<void> {
  for (const fn of open.splice(0)) await fn();
}
