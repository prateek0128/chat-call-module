// Consumer-style check of the BUILT package: imports every public entry by its package name (run `npm run build` first),
// then runs chat, a call and a block through a real HTTP + WebSocket server on an ephemeral port.
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { Kysely, SqliteDialect } from "kysely";
import WebSocket from "ws";

import { CommsHub, JwtAuth, StaticUserDirectory, restListener } from "commskit-node/core";
import { ChatFeature } from "commskit-node/chat";
import { CallFeature } from "commskit-node/call";
import { ModerationFeature } from "commskit-node/moderation";
import { linkChatAndCall, linkModeration } from "commskit-node/integration";
import { ExpoPushSender, DevicePushRouter, SqlDeviceRegistry } from "commskit-node/push";
import { RedisBridge } from "commskit-node/redis";
import { S3Storage } from "commskit-node/s3";
import { ensureSchema, ChatFeature as RootChatFeature } from "commskit-node";

const SECRET = "smoke-test-secret-not-a-real-secret-0001";
const fail = (msg) => {
  console.error("FAIL", msg);
  process.exit(1);
};
const check = (cond, msg) => (cond ? console.log("PASS", msg) : fail(msg));

check(RootChatFeature === ChatFeature, "root entry and /chat entry share the same ChatFeature class");
check([ExpoPushSender, DevicePushRouter, SqlDeviceRegistry, RedisBridge, S3Storage].every((c) => typeof c === "function"), "push, redis and s3 entries load");

const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
await ensureSchema(db);
const hub = new CommsHub({
  auth: new JwtAuth(SECRET),
  db,
  users: new StaticUserDirectory({ A: { name: "Alice", avatar: null }, B: { name: "Bob", avatar: null } }),
});
const chat = hub.install(new ChatFeature());
const call = hub.install(new CallFeature());
const moderation = hub.install(new ModerationFeature());
linkChatAndCall(chat, call);
linkModeration(moderation, { chat, call });

const rest = restListener(hub);
const server = createServer(async (req, res) => {
  if (!(await rest(req, res))) {
    res.writeHead(404);
    res.end();
  }
});
hub.attach(server);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const tokenFor = (uid) => new SignJWT({ uid }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(SECRET));

async function connect(uid) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${await tokenFor(uid)}`);
  const frames = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    frames.push(f);
    for (const w of [...waiters]) if (w.type === f.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return {
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    wait: (type, ms = 5000) => {
      const seen = frames.find((f) => f.type === type);
      if (seen) { frames.splice(frames.indexOf(seen), 1); return Promise.resolve(seen); }
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      });
    },
    close: () => ws.close(),
  };
}

try {
  const a = await connect("A");
  const b = await connect("B");

  a.send("send_message", { candidate_user_id: "B", content: "hello from the built package" });
  const got = await b.wait("new_message");
  check(got.message.content === "hello from the built package" && got.message.sender_id === "A", "chat: B receives A's message");
  check((await a.wait("message_sent")).message.id === got.message.id, "chat: A gets message_sent with the same id");

  a.send("call_initiate", { receiver_id: "B", call_type: "audio" });
  const incoming = await b.wait("incoming_call");
  check(incoming.caller_id === "A", "call: B gets incoming_call from A");
  b.send("answer_call", { call_id: incoming.call_id });
  check((await a.wait("call_answered")).status === "answered", "call: A gets call_answered");
  a.send("end_call", { call_id: incoming.call_id });
  check((await b.wait("call_ended")).end_reason === "hangup", "call: B gets call_ended (hangup)");
  check(/^Voice call/.test((await b.wait("call_log")).content), "call + chat: call_log text appears for B");

  b.send("report_and_block", { candidate_user_id: "A", reason: "smoke test", category: "spam" });
  check((await a.wait("blocked_by_user")).type === "blocked_by_user", "moderation: A is told they were blocked");
  a.send("send_message", { candidate_user_id: "B", content: "this must be refused" });
  check((await a.wait("error")).type === "error", "moderation: a blocked user's message is refused");

  a.close();
  b.close();
} catch (err) {
  fail(String(err));
}
await hub.shutdown();
await new Promise((r) => server.close(r));
console.log("dist smoke test: all checks passed");
process.exit(0);
