import { afterEach, describe, expect, it } from "vitest";
import { type ChatPolicy } from "../src/index.js";
import { PROFILES, closeAll, makeEnv, sleep } from "./helpers.js";

afterEach(closeAll);

export const MESSAGE_DTO_KEYS = [
  "id", "chat_id", "sender_id", "sender_type", "content", "message_type", "timestamp",
  "file_url", "file_name", "file_size", "file_type", "thumbnail_url", "duration",
  "is_read", "is_delivered", "call_id", "reply_to",
].sort();

describe("chat (chat-only app)", () => {
  it("has no call feature", async () => {
    const env = await makeEnv();
    expect(env.hub.handles("send_message")).toBe(true);
    expect(env.hub.handles("call_initiate")).toBe(false);
    expect((await env.post("/call/turn-credentials", "A")).status).toBe(404);
  });

  it("send and receive shapes, reply preview", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "B", content: "hi Bob", chat_id: 999 });
    const nw = await b.expect("new_message");
    const sent = await a.expect("message_sent");

    const msg = nw.message;
    expect(Object.keys(nw).sort()).toEqual(["message", "type"]);
    expect(Object.keys(msg).sort()).toEqual(MESSAGE_DTO_KEYS);
    expect(msg.sender_id).toBe("A");
    expect(msg.sender_type).toBe("other");
    expect(msg.content).toBe("hi Bob");
    expect(msg.message_type).toBe("text");
    expect(msg.is_read).toBe(false);
    expect(msg.is_delivered).toBe(true);
    expect(Number.isInteger(msg.chat_id)).toBe(true);
    expect(msg.timestamp).toBeTruthy();
    expect(msg.reply_to).toBeNull();
    expect(msg.call_id).toBeNull();

    const mine = sent.message;
    expect(Object.keys(mine).sort()).toEqual(MESSAGE_DTO_KEYS);
    expect(mine.id).toBe(msg.id);
    expect(mine.sender_type).toBe("user");
    expect(mine.is_delivered).toBe(true);

    b.send("send_message", { candidate_user_id: "A", content: "hey", reply_to_id: msg.id });
    const reply = (await a.expect("new_message")).message;
    expect(reply.reply_to).toEqual({ id: msg.id, sender_id: "A", content: "hi Bob", message_type: "text", file_name: null });
    expect(env.push.sent).toEqual([]); // both were online
  });

  it("validation errors", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    a.send("send_message", { candidate_user_id: "B" });
    expect((await a.expect("error")).error).toBe("Missing required fields: candidate_user_id, content");
    a.send("send_message", { candidate_user_id: "A", content: "me" });
    expect((await a.expect("error")).error).toBe("Cannot send a message to yourself.");
    a.send("get_messages", { chat_id: 12345 });
    expect((await a.expect("error")).error).toBe("Chat not found");
  });

  it("offline push payload and delivery receipt on connect", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    a.send("send_message", { candidate_user_id: "B", content: "x".repeat(200) });
    const sent = (await a.expect("message_sent")).message;
    expect(sent.is_delivered).toBe(false);
    const push = await env.push.waitFor((p) => p.user_id === "B");
    expect(push.title).toBe("Alice");
    expect(push.body).toBe("x".repeat(120));
    expect(push.channel).toBe("messages");
    expect(push.data).toEqual({ type: "chat", cid: "messaging:A", chat_id: sent.chat_id, sender_id: "A" });

    await env.ws("B");
    const receipt = await a.expect("delivery_status");
    expect(receipt.chat_id).toBe(sent.chat_id);
    expect(receipt.message_ids).toEqual([sent.id]);
    expect(receipt.status).toBe("delivered");
  });

  it("attachment push body", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    a.send("media_upload", { target_user_id: "B", file_name: "p.png", file_data: Buffer.from("png").toString("base64") });
    await a.expect("media_upload_success");
    const push = await env.push.waitFor((p) => p.user_id === "B");
    expect(push.body).toBe("\u{1F4CE} Attachment");
  });

  it("get_messages pagination (+ REST)", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    for (let i = 0; i < 15; i++) {
      a.send("send_message", { candidate_user_id: "B", content: `m${i}` });
      await a.expect("message_sent");
    }
    b.send("get_messages", { candidate_user_id: "A", limit: 10 });
    const page1 = await b.expect("res_messages");
    expect(page1.messages.map((m: any) => m.content)).toEqual(Array.from({ length: 10 }, (_, k) => `m${14 - k}`));
    expect(page1.offset).toBe(0);
    expect(page1.has_more).toBe(true);
    expect(page1.messages.every((m: any) => m.sender_type === "other")).toBe(true);
    const info = page1.info;
    expect(info.user_id).toBe("A");
    expect(info.username).toBe("Alice");
    expect(info.avatar).toBe("https://img/a.png");
    expect(info.status).toBe("online");
    expect(info.last_seen).toBe(page1.messages[0].timestamp);
    expect(info.chat_consent_given).toBe(true);
    expect(info.is_blocked).toBe(false);
    expect(info.blocked_by_other).toBe(false);

    const chatId = page1.messages[0].chat_id;
    b.send("get_messages", { chat_id: chatId, offset: 10, limit: 10 });
    const page2 = await b.expect("res_messages");
    expect(page2.messages.map((m: any) => m.content)).toEqual(["m4", "m3", "m2", "m1", "m0"]);
    expect(page2.offset).toBe(10);
    expect(page2.has_more).toBe(false);

    b.send("get_messages", { candidate_user_id: "C" }); // no chat yet
    const empty = await b.expect("res_messages");
    expect(empty.messages).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(empty.info.username).toBe("Carol");

    const rest = await env.get(`/chats/${chatId}/messages?limit=3&offset=1`, "A");
    expect(rest.status).toBe(200);
    expect(rest.json.map((m: any) => m.content)).toEqual(["m13", "m12", "m11"]);
    expect(Object.keys(rest.json[0]).sort()).toEqual(MESSAGE_DTO_KEYS);
    expect(rest.json[0].sender_type).toBe("user");
    expect((await env.get(`/chats/${chatId}/messages`, "C")).status).toBe(404);
    expect((await env.get(`/chats/${chatId}/messages?limit=0`, "A")).status).toBe(422);
  });

  it("mark_read events (WS, REST)", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "B", content: "read me" });
    const chatId = (await b.expect("new_message")).message.chat_id;

    expect((await env.get("/chats/B/unread-count", "B")).json).toEqual({ unread_count: 1 });
    b.send("mark_read", { chat_id: chatId, candidate_user_id: "A" });
    expect(await b.expect("chat_read")).toEqual({ type: "chat_read", chat_id: chatId });
    expect(await a.expect("messages_read")).toEqual({ type: "messages_read", chat_id: chatId, read_by: "B" });
    expect((await env.get("/chats/B/unread-count", "B")).json).toEqual({ unread_count: 0 });

    a.send("get_messages", { chat_id: chatId });
    expect((await a.expect("res_messages")).messages[0].is_read).toBe(true);

    b.send("send_message", { candidate_user_id: "A", content: "back" });
    await a.expect("new_message");
    const resp = await env.post(`/chats/${chatId}/read`, "A");
    expect(resp.json).toEqual({ message: "Messages marked as read" });
    await a.expect("chat_read", { chat_id: chatId });
    await b.expect("messages_read", { read_by: "A" });
  });

  it("typing status", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("typing", { target_user_id: "B", is_typing: true }); // no chat yet: dropped
    await a.sync();
    a.send("send_message", { candidate_user_id: "B", content: "hi" });
    const chatId = (await b.expect("new_message")).message.chat_id;

    a.send("typing", { target_user_id: "B", is_typing: true });
    const typing = await b.expect("typing_status");
    expect(typing.user_id).toBe("A");
    expect(typing.chat_id).toBe(chatId);
    expect(typing.is_typing).toBe(true);
    expect(typing.timestamp).toBeTruthy();
    a.send("typing", { target_user_id: "B", is_typing: false });
    expect((await b.expect("typing_status")).is_typing).toBe(false);
  });

  it("req_users, presence and REST list/online-status", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "B", content: "first" });
    await b.expect("new_message");
    b.send("user_status", { status: "away" });
    expect((await a.expect("user_status", { user_id: "B" })).status).toBe("away");
    b.send("user_status", { status: "online" });
    await a.expect("user_status", { user_id: "B", status: "online" });

    b.send("req_users");
    const users = (await b.expect("res_users")).users;
    expect(users).toHaveLength(1);
    const entry = users[0];
    expect(entry.user_id).toBe("A");
    expect(entry.username).toBe("Alice");
    expect(entry.status).toBe("online");
    expect(entry.unread_count).toBe(1);
    expect(entry.last_message.content).toBe("first");
    expect(entry.is_blocked).toBe(false);
    expect(entry.blocked_by_other).toBe(false);
    expect(entry.updated_at).toBe(entry.last_message.timestamp);

    await b.close();
    await a.expect("user_status", { user_id: "B", status: "offline" });

    const convs = (await env.get("/chats/A", "A")).json;
    expect(convs[0].other_user.username).toBe("Bob");
    expect(convs[0].unread_count).toBe(0);
    expect((await env.get("/chats/B", "A")).status).toBe(403);
    expect((await env.get("/chats/B/online-status", "A")).json).toEqual({ user_id: "B", is_online: false });
    expect((await env.get("/chats/C/online-status", "A")).status).toBe(403);
  });

  it("policy refusal", async () => {
    const blocking: ChatPolicy = {
      refusalMessage: "Cannot send message. User is blocked.",
      canMessage: async (_db, _s, recipient) => recipient !== "C",
      blockStatus: async (_db, _v, others) => Object.fromEntries(others.filter((o) => o === "C").map((o) => [o, [true, false] as [boolean, boolean]])),
      extraConversationInfo: async () => ({ chat_consent_given: false }),
    };
    const env = await makeEnv({ chatPolicy: blocking });
    const a = await env.ws("A");
    const c = await env.ws("C");
    a.send("send_message", { candidate_user_id: "C", content: "hello?" });
    expect(await a.expect("error")).toEqual({ type: "error", error: "Cannot send message. User is blocked." });
    a.send("typing", { target_user_id: "C", is_typing: true });
    await c.expectNone("typing_status");
    a.send("get_messages", { candidate_user_id: "C" });
    const info = (await a.expect("res_messages")).info;
    expect(info.is_blocked).toBe(true);
    expect(info.chat_consent_given).toBe(false);
  });

  it("media upload: detection, voice, unsupported", async () => {
    const env = await makeEnv();
    const data = Buffer.from("\x89PNG fake image bytes", "latin1").toString("base64");
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("media_upload", { target_user_id: "B", file_name: "photo.png", file_data: data });
    const ok = (await a.expect("media_upload_success")).message;
    expect(ok.content).toBeNull();
    expect(ok.message_type).toBe("image");
    expect(ok.file_name).toBe("photo.png");
    expect(ok.file_size).toBe(21);
    expect(ok.file_type).toBe("image/png");
    expect(ok.file_url.startsWith("/media/chat/")).toBe(true);
    expect(ok.file_url).toMatch(/^\/media\/chat\/\d+\/image\/[0-9a-f]{12}_photo\.png$/);

    const nw = (await b.expect("new_message")).message;
    expect(nw.content).toBe("[IMAGE] photo.png");
    expect(nw.sender_type).toBe("other");
    const sent = (await a.expect("message_sent")).message;
    expect(sent.content).toBeNull();
    expect(sent.is_delivered).toBe(true);

    a.send("media_upload", { target_user_id: "B", file_name: "voice.m4a", file_data: data, media_type: "voice" });
    expect((await b.expect("new_message")).message.message_type).toBe("voice");

    a.send("media_upload", { target_user_id: "B", file_name: "virus.exe", file_data: data });
    expect((await a.expect("error")).error).toBe("Unsupported file type: virus.exe");

    a.send("media_upload", { target_user_id: "B", file_name: "x.png", file_data: "@@not base64@@" });
    expect((await a.expect("error")).error).toBe("Invalid base64 file_data");
    a.send("media_upload", { target_user_id: "B", file_name: "x.png" });
    expect((await a.expect("error")).error).toBe("Missing required fields: target_user_id, file_name, file_data");
  });

  it("media too large", async () => {
    const env = await makeEnv({ chatConfig: { maxUploadBytes: 10 } });
    const a = await env.ws("A");
    a.send("media_upload", { target_user_id: "B", file_name: "a.png", file_data: Buffer.alloc(11, "x").toString("base64") });
    expect((await a.expect("error")).error).toMatch(/^File too large/);
  });

  it("REST start chat is idempotent per pair", async () => {
    const env = await makeEnv();
    const first = (await env.post("/chats/start?candidate_id=B", "A")).json;
    const again = (await env.post("/chats/start?candidate_id=A", "B")).json;
    expect(first.chat_id).toBe(again.chat_id);
    expect([first.user1_id, first.user2_id]).toEqual(["A", "B"]);
    expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/);
    expect((await env.post("/chats/start?candidate_id=A", "A")).status).toBe(400);
    const missing = await env.post("/chats/start", "A");
    expect(missing.status).toBe(422);
    expect(missing.json.detail[0].loc).toEqual(["query", "candidate_id"]);
  });

  it("per-user frames stay ordered", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    for (let i = 0; i < 5; i++) a.send("send_message", { candidate_user_id: "B", content: `o${i}` });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await a.expect("message_sent")).message.content);
    expect(ids).toEqual(["o0", "o1", "o2", "o3", "o4"]);
    await sleep(10);
    void PROFILES;
  });
});
