/** Chat + call linked through integration/chatCall. Port of backend/backend-python/tests/test_chat_call.py. */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { CallFeature } from "../src/call/index.js";
import { type ChatFeature, CommsHub, JwtAuth, StaticUserDirectory, ensureSchema } from "../src/index.js";
import { linkChatAndCall } from "../src/integration/chatCall.js";
import { closeAllCall, makeCallEnv } from "./call.helpers.js";
import { PROFILES, SECRET } from "./helpers.js";

afterEach(closeAllCall);

describe("chat + call", () => {
  it("linked app registers both", async () => {
    const env = await makeCallEnv({ chat: true });
    expect(env.call.chatBridge).not.toBeNull();
    expect(env.hub.handles("send_message")).toBe(true);
    expect(env.hub.handles("call_initiate")).toBe(true);
  });

  it("happy path writes a call_log; the [Call Initiated] entry is rewritten", async () => {
    const env = await makeCallEnv({ chat: true });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("call_initiate", { receiver_id: "B", chat_id: 424242 }); // client chat_id is not trusted
    const initiated = await a.expect("call_initiated");
    const incoming = await b.expect("incoming_call");
    const chatId = initiated.chat_id;
    expect(Number.isInteger(chatId)).toBe(true);
    expect(chatId).not.toBe(424242);
    expect(incoming.chat_id).toBe(chatId);
    const callId = initiated.call_id;

    // Placeholder entry exists while ringing.
    b.send("get_messages", { chat_id: chatId });
    const entry = (await b.expect("res_messages")).messages[0];
    expect(entry).toMatchObject({ content: "[Call Initiated]", message_type: "audio_call", call_id: callId, sender_id: "A" });

    b.send("answer_call", { call_id: callId });
    await a.expect("call_answered");
    b.send("end_call", { call_id: callId });
    const ended = await a.expect("call_ended");
    expect(ended).toMatchObject({ ended_by: "B", chat_id: chatId });

    const secs = String(ended.duration_seconds).padStart(2, "0");
    for (const ws of [a, b]) {
      expect(await ws.expect("call_log")).toEqual({
        type: "call_log",
        call_id: callId,
        chat_id: chatId,
        message_id: entry.id,
        content: `Voice call · 00:${secs}`,
        status: "ended",
        duration_seconds: ended.duration_seconds,
      });
    }

    a.send("get_messages", { chat_id: chatId });
    const rewritten = (await a.expect("res_messages")).messages[0];
    expect(rewritten.id).toBe(entry.id);
    expect(rewritten.content.startsWith("Voice call · ")).toBe(true);

    // Call partners now see each other in the conversation list.
    a.send("req_users");
    expect((await a.expect("res_users")).users[0].chat_id).toBe(chatId);
  });

  for (const [who, callType, status, text] of [
    ["B", "audio", "rejected", "Declined voice call"],
    ["A", "audio", "missed", "Missed voice call"],
    ["B", "video", "rejected", "Declined video call"],
    ["A", "video", "missed", "Missed video call"],
  ] as const) {
    it(`${who} ends a ringing ${callType} call -> ${text}`, async () => {
      const env = await makeCallEnv({ chat: true });
      const a = await env.ws("A");
      const b = await env.ws("B");
      a.send("call_initiate", { receiver_id: "B", call_type: callType });
      const callId = (await a.expect("call_initiated")).call_id;
      await b.expect("incoming_call");
      (who === "B" ? b : a).send("reject_call", { call_id: callId });
      const log = await a.expect("call_log");
      expect(log).toMatchObject({ status, content: text });
      expect((await b.expect("call_log")).content).toBe(text);

      a.send("get_messages", { chat_id: log.chat_id });
      const msg = (await a.expect("res_messages")).messages[0];
      expect(msg).toMatchObject({ message_type: `${callType}_call`, content: text });
    });
  }

  it("missed-call log on ring timeout", async () => {
    const env = await makeCallEnv({ chat: true, config: { ringTimeout: 0.4 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("call_initiate", { receiver_id: "B" });
    const callId = (await a.expect("call_initiated")).call_id;
    await a.expect("call_missed", {}, 3000);
    const log = await a.expect("call_log");
    expect(log).toMatchObject({ call_id: callId, content: "Missed voice call", status: "missed" });
    await b.expect("call_log", { call_id: callId });
  });

  it("answered video call logs Video call with duration", async () => {
    const env = await makeCallEnv({ chat: true });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("call_initiate", { receiver_id: "B", call_type: "video" });
    const init = await a.expect("call_initiated");
    expect(init.call_type).toBe("video");
    await b.expect("incoming_call");
    b.send("answer_call", { call_id: init.call_id });
    await a.expect("call_answered");
    a.send("end_call", { call_id: init.call_id });
    const log = await b.expect("call_log");
    expect(log.content).toMatch(/^Video call · 00:0\d$/);
    expect(log.status).toBe("ended");
  });

  it("endCallsBetween writes the call_log too", async () => {
    const env = await makeCallEnv({ chat: true });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("call_initiate", { receiver_id: "B" });
    await a.expect("call_initiated");
    await b.expect("incoming_call");
    await env.call.endCallsBetween("A", "B", "blocked", "A");
    expect((await b.expect("call_log")).content).toBe("Missed voice call");
  });

  it("the call row stores the chat id; link needs the same hub and happens once", async () => {
    const env = await makeCallEnv({ chat: true });
    const a = await env.ws("A");
    await env.ws("B");
    a.send("call_initiate", { receiver_id: "B" });
    const init = await a.expect("call_initiated");
    const row = await env.db.selectFrom("calls").selectAll().executeTakeFirst();
    expect(row!.chat_id).toBe(init.chat_id);

    expect(() => linkChatAndCall(env.chat as ChatFeature, env.call)).toThrow(/already linked/);
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureSchema(db);
    const other = new CommsHub({ auth: new JwtAuth(SECRET), db, users: new StaticUserDirectory(PROFILES) });
    const call2 = other.install(new CallFeature());
    expect(() => linkChatAndCall(env.chat as ChatFeature, call2)).toThrow(/same CommsHub/);
    await other.shutdown();
    await db.destroy();
  });
});
