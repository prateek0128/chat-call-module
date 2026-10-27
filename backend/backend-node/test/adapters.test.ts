import { createServer } from "node:http";
import Database from "better-sqlite3";
import express from "express";
import Fastify from "fastify";
import { Kysely, SqliteDialect } from "kysely";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { ChatFeature, CommsHub, JwtAuth, StaticUserDirectory, ensureSchema } from "../src/index.js";
import { attach, commskitRouter } from "../src/express/index.js";
import { commskitPlugin } from "../src/fastify/index.js";
import { PROFILES, SECRET, WsClient, token } from "./helpers.js";

async function newHub() {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureSchema(db);
  const hub = new CommsHub({ auth: new JwtAuth(SECRET), db, users: new StaticUserDirectory(PROFILES) });
  hub.install(new ChatFeature());
  return hub;
}

async function exercise(base: string) {
  const wsUrl = base.replace("http", "ws");
  const a = new WsClient(new WebSocket(`${wsUrl}/ws/${await token("A")}`));
  const b = new WsClient(new WebSocket(`${wsUrl}/ws/${await token("B")}`));
  await Promise.all([new Promise((r) => a.ws.once("open", r)), new Promise((r) => b.ws.once("open", r))]);
  await a.handshake(); 
  await b.handshake();
  a.send("send_message", { candidate_user_id: "B", content: "via adapter" });
  expect((await b.expect("new_message")).message.content).toBe("via adapter");

  const auth = { authorization: `Bearer ${await token("A")}`, "content-type": "application/json" };
  const start = await fetch(`${base}/chats/start?candidate_id=B`, { method: "POST", headers: auth });
  expect(start.status).toBe(200);
  const chatId = ((await start.json()) as any).chat_id;
  const sent = await fetch(`${base}/chats/send`, { method: "POST", headers: auth, body: JSON.stringify({ candidate_user_id: "B", content: "rest" }) });
  expect(sent.status).toBe(200);
  expect((await fetch(`${base}/chats/${chatId}/messages`, { headers: auth })).status).toBe(200);
  expect((await fetch(`${base}/chats/${chatId}/messages`)).status).toBe(401);
  const limited = await fetch(`${base}/chats/${chatId}/messages?limit=0`, { headers: auth });
  expect(limited.status).toBe(422);
  await a.close();
  await b.close();
}

describe("framework adapters", () => {
  it("fastify plugin", async () => {
    const hub = await newHub();
    const app = Fastify();
    await app.register(commskitPlugin, { hub });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    try {
      await exercise(`http://127.0.0.1:${port}`);
    } finally {
      await app.close();
    }
  });

  it("express router + attach", async () => {
    const hub = await newHub();
    const app = express();
    app.use(commskitRouter(hub));
    const server = createServer(app);
    attach(server, hub);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      await exercise(`http://127.0.0.1:${port}`);
    } finally {
      await hub.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
