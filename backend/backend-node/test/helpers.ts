/** Test harness: real http server on an ephemeral port, real `ws` clients, better-sqlite3 in memory. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { Kysely, SqliteDialect } from "kysely";
import WebSocket from "ws";
import {
  ChatFeature, CommsHub, JwtAuth, LocalDiskStorage, type ChatConfig, type ChatPolicy, type CommsHubOptions,
  type MediaStorage, type PushSender, StaticUserDirectory, type UserProfile, ensureSchema, restListener, setLogger,
  silentLogger,
} from "../src/index.js";

setLogger(silentLogger);

export const SECRET = "test-only-secret-signed-by-the-tests-0001";
export const PROFILES: Record<string, UserProfile> = {
  A: { name: "Alice", avatar: "https://img/a.png" },
  B: { name: "Bob", avatar: "https://img/b.png" },
  C: { name: "Carol", avatar: null },
};

export async function token(userId: string): Promise<string> {
  return new SignJWT({ uid: userId }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(SECRET));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RecordingPush implements PushSender {
  sent: Array<{ user_id: string; title: string; body: string; data: Record<string, any>; channel: string; ttl: number | null | undefined }> = [];
  async send(user_id: string, title: string, body: string, data: Record<string, unknown>, channel = "default", ttl?: number | null) {
    this.sent.push({ user_id, title, body, data: { ...data }, channel, ttl });
  }
  async waitFor(pred: (p: RecordingPush["sent"][number]) => boolean, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = this.sent.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`No matching push; sent=${JSON.stringify(this.sent)}`);
  }
}

export type Frame = Record<string, any>;

export class WsClient {
  private queue: Frame[] = [];
  private waiters: Array<() => void> = [];
  closeCode: number | null = null;
  closed = false;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.queue.push(JSON.parse(data.toString()));
      this.wake();
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      this.closed = true;
      this.wake();
    });
    ws.on("error", () => undefined);
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  send(type: string, payload: Frame = {}) {
    this.ws.send(JSON.stringify({ type, ...payload }));
  }
  sendRaw(text: string) {
    this.ws.send(text);
  }

  /** Next frame (any type). */
  async recv(timeout = 5000): Promise<Frame> {
    const end = Date.now() + timeout;
    while (!this.queue.length) {
      const left = end - Date.now();
      if (left <= 0) throw new Error("recv timeout");
      await this.wait(left);
    }
    return this.queue.shift()!;
  }

  /** Next frame of `type` (matching `match`), skipping unrelated frames. */
  async expect(type: string, match: Frame = {}, timeout = 5000): Promise<Frame> {
    const end = Date.now() + timeout;
    const skipped: Frame[] = [];
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) throw new Error(`No ${type} ${JSON.stringify(match)}; skipped=${JSON.stringify(skipped)}`);
      let frame: Frame;
      try {
        frame = await this.recv(left);
      } catch {
        throw new Error(`No ${type} ${JSON.stringify(match)}; skipped=${JSON.stringify(skipped)}`);
      }
      if (frame.type === type && Object.entries(match).every(([k, v]) => JSON.stringify(frame[k]) === JSON.stringify(v))) return frame;
      skipped.push(frame);
    }
  }

  /** No frame of `type` arrives within `wait` ms. */
  async expectNone(type: string, wait = 400): Promise<void> {
    const end = Date.now() + wait;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return;
      try {
        const frame = await this.recv(left);
        if (frame.type === type) throw new Error(`Unexpected ${type}: ${JSON.stringify(frame)}`);
      } catch (e) {
        if ((e as Error).message === "recv timeout") return;
        throw e;
      }
    }
  }

  /** Round-trip a ping so earlier frames from this socket are fully processed. */
  async sync(): Promise<void> {
    this.send("ping");
    await this.expect("PONG");
  }

  /** Wait for PONG without discarding other frames (used right after connecting). */
  async handshake(): Promise<void> {
    this.send("ping");
    const end = Date.now() + 5000;
    for (;;) {
      const i = this.queue.findIndex((f) => f.type === "PONG");
      if (i >= 0) {
        this.queue.splice(i, 1);
        return;
      }
      if (Date.now() > end) throw new Error("handshake timeout");
      await this.wait(end - Date.now());
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.ws.close();
    for (let i = 0; i < 100 && !this.closed; i++) await sleep(10);
  }

  async waitClosed(timeout = 5000): Promise<number | null> {
    const end = Date.now() + timeout;
    while (!this.closed && Date.now() < end) await this.wait(end - Date.now());
    return this.closeCode;
  }
}

export interface RestResponse {
  status: number;
  json: any;
  headers: Headers;
}

export interface Env {
  hub: CommsHub;
  chat: ChatFeature;
  db: Kysely<any>;
  push: RecordingPush;
  server: Server;
  baseUrl: string;
  wsUrl: string;
  mediaDir: string;
  ws(userId: string): Promise<WsClient>;
  rawWs(path: string): Promise<WsClient>;
  rest(method: string, urlPath: string, userId?: string | null, body?: unknown, headers?: Record<string, string>): Promise<RestResponse>;
  get(urlPath: string, userId?: string | null): Promise<RestResponse>;
  post(urlPath: string, userId?: string | null, body?: unknown): Promise<RestResponse>;
  close(): Promise<void>;
}

export interface EnvOptions {
  chat?: boolean;
  chatPolicy?: ChatPolicy;
  chatConfig?: Partial<ChatConfig>;
  hubOptions?: Partial<CommsHubOptions>;
  storage?: MediaStorage;
}

const open: Array<() => Promise<void>> = [];

export async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureSchema(db);
  const mediaDir = mkdtempSync(path.join(tmpdir(), "commskit-media-"));
  const push = new RecordingPush();
  const hub = new CommsHub({
    auth: new JwtAuth(SECRET),
    db,
    users: new StaticUserDirectory(PROFILES),
    push,
    ...(opts.hubOptions ?? {}),
  });
  const chat = new ChatFeature({
    policy: opts.chatPolicy,
    storage: opts.storage ?? new LocalDiskStorage(mediaDir),
    config: opts.chatConfig,
  });
  if (opts.chat !== false) hub.install(chat);

  const rest = restListener(hub);
  const server = createServer(async (req, res) => {
    if (!(await rest(req, res))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    }
  });
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const clients: WsClient[] = [];

  const connect = async (p: string): Promise<WsClient> => {
    const ws = new WebSocket(`${wsUrl}${p}`);
    const client = new WsClient(ws);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  };

  const env: Env = {
    hub, chat, db, push, server, baseUrl, wsUrl, mediaDir,
    async ws(userId) {
      const c = await connect(`/ws/${await token(userId)}`);
      await c.handshake();
      return c;
    },
    rawWs: connect,
    async rest(method, urlPath, userId = null, body, headers = {}) {
      const h: Record<string, string> = { ...headers };
      if (userId) h.authorization = `Bearer ${await token(userId)}`;
      if (body !== undefined) h["content-type"] = "application/json";
      const res = await fetch(baseUrl + urlPath, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    },
    get: (p, u) => env.rest("GET", p, u),
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

/** Call from `afterEach` to tear down every env created in the test. */
export async function closeAll(): Promise<void> {
  for (const fn of open.splice(0)) await fn();
}
