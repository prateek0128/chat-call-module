// Local demo server for the comms kit, Node edition. DEV ONLY - it hands out tokens to anyone.
// Behaves like examples/backend/demo-server-python/demo_server.py; see README.md. Run: node server.mjs [--port 8000] [--host 127.0.0.1]
import { createServer } from "node:http";
import { mkdirSync, createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { Kysely, SqliteDialect } from "kysely";

import { CommsHub, JwtAuth, LocalDiskStorage, RateLimit, StaticUserDirectory, restListener } from "commskit-node/core";
import { ChatFeature } from "commskit-node/chat";
import { CallFeature } from "commskit-node/call";
import { ModerationFeature } from "commskit-node/moderation";
import { linkChatAndCall, linkModeration } from "commskit-node/integration";
import { ApnsVoipSender, DevicePushRouter, DevicesFeature, ExpoPushSender, SqlDeviceRegistry } from "commskit-node/push";
import { ensureSchema } from "commskit-node";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.resolve(HERE, "..", "demo-server-python"); // the page files are shared with the Python demo
const DATA = path.resolve(process.env.COMMS_DEMO_DATA || path.join(HERE, ".demo_data"));
mkdirSync(path.join(DATA, "media"), { recursive: true });

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg("port") ?? process.env.PORT ?? 8000);
const HOST = arg("host") ?? "127.0.0.1";

const SECRET = process.env.COMMS_DEMO_SECRET || "local-demo-secret-change-me-0000";
const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const FEATURES = new Set(list(process.env.COMMS_FEATURES ?? "chat,call"));

const USERS = {
  U1: { name: "Alice", avatar: null },
  U2: { name: "Bob", avatar: null },
  U3: { name: "Carol", avatar: null },
};

const sqlite = new Database(path.join(DATA, "demo.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 30000");
const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
await ensureSchema(db);

const devices = new SqlDeviceRegistry(db);
const push = new DevicePushRouter({
  registry: devices,
  expo: new ExpoPushSender({ accessToken: process.env.EXPO_ACCESS_TOKEN || null }),
  voip: ApnsVoipSender.fromEnv(devices),
  androidCallStyle: process.env.ANDROID_CALL_STYLE || "data",
});

const hub = new CommsHub({ auth: new JwtAuth(SECRET), db, users: new StaticUserDirectory(USERS), push });
hub.install(new DevicesFeature(devices)); // before chat, so chat does not mount its own legacy token routes

let chat = null;
let call = null;
if (FEATURES.has("chat")) {
  chat = hub.install(
    new ChatFeature({
      storage: new LocalDiskStorage(path.join(DATA, "media"), "/media"),
      // Generous limits: the UI tests drive one shared server hard.
      config: { messageRate: new RateLimit(200, 10), uploadRate: new RateLimit(60, 60), typingRate: new RateLimit(60, 5) },
    }),
  );
}
if (FEATURES.has("call")) {
  call = hub.install(
    new CallFeature({ config: { turnSecret: process.env.TURN_SECRET || null, turnUris: list(process.env.TURN_URIS), initiateRate: null } }),
  );
}
if (chat && call) linkChatAndCall(chat, call);

const moderation = hub.install(
  new ModerationFeature({ onReport: (report) => console.log("[demo] report", report) }), // a real app would notify its moderators
);
linkModeration(moderation, { chat, call });

const rest = restListener(hub);

// Optional CORS for a separately hosted web client.
const CORS = list(process.env.COMMS_CORS_ORIGINS);
const applyCors = (req, res) => {
  const origin = req.headers.origin;
  if (!origin || !CORS.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    res.setHeader("Access-Control-Allow-Methods", "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("OK");
    return true;
  }
  return false;
};

// The demo page and its assets: an explicit allow-list, so nothing else in ../demo-server-python is served.
const PAGE_FILES = {
  "demo.html": "text/html; charset=utf-8",
  "demo.css": "text/css; charset=utf-8",
  "demo.js": "text/javascript; charset=utf-8",
  "demo-call.js": "text/javascript; charset=utf-8",
};
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
};
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const sendFile = (res, file, type, headers = {}) => {
  let st;
  try {
    st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    return json(res, 404, { detail: "Not Found" });
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, ...headers });
  createReadStream(file).pipe(res);
};

const server = createServer(async (req, res) => {
  try {
    if (CORS.length && applyCors(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      if (p === "/dev/users") {
        return json(res, 200, { features: [...FEATURES].sort(), users: Object.entries(USERS).map(([id, u]) => ({ id, name: u.name })) });
      }
      const tok = /^\/dev\/token\/([^/]+)$/.exec(p);
      if (tok) {
        const uid = decodeURIComponent(tok[1]);
        if (!Object.hasOwn(USERS, uid)) return json(res, 404, { detail: "unknown demo user" });
        const token = await new SignJWT({ uid }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(new TextEncoder().encode(SECRET));
        return json(res, 200, { token });
      }
      const name = p === "/" ? "demo.html" : p.slice(1);
      if (Object.hasOwn(PAGE_FILES, name)) return sendFile(res, path.join(PAGE_DIR, name), PAGE_FILES[name], { "cache-control": "no-cache" });
      if (p.startsWith("/media/")) {
        let rel;
        try { rel = decodeURIComponent(p.slice(7)); } catch { rel = ""; }
        const root = path.join(DATA, "media");
        const file = path.resolve(root, rel);
        if (!rel || !file.startsWith(root + path.sep)) return json(res, 404, { detail: "Not Found" });
        return sendFile(res, file, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
      }
    }
    if (!(await rest(req, res))) json(res, 404, { detail: "Not Found" });
  } catch (err) {
    console.error("[demo] request failed", err);
    if (!res.headersSent) json(res, 500, { detail: "Internal Server Error" });
    else res.end();
  }
});
hub.attach(server);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await hub.shutdown().catch(() => {});
  await push.aclose().catch(() => {});
  server.close();
  server.closeAllConnections?.();
  await db.destroy().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

server.listen(PORT, HOST, () => console.log(`[demo] comms kit demo (node) on http://${HOST}:${PORT}  features=${[...FEATURES].sort().join(",")}`));
