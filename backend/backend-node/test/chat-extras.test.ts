import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ChatActionError, type ChatPolicy, LocalDiskStorage, RateLimit } from "../src/index.js";
import { PROFILES, type WsClient, closeAll, makeEnv, sleep } from "./helpers.js";

afterEach(closeAll);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function sendText(sender: WsClient, receiver: WsClient | null, to: string, text: string) {
  sender.send("send_message", { candidate_user_id: to, content: text });
  const msg = (await sender.expect("message_sent")).message;
  if (receiver) await receiver.expect("new_message");
  return msg;
}

describe("limits", () => {
  it("message rate limit (WS + REST, per user)", async () => {
    const env = await makeEnv({ chatConfig: { messageRate: new RateLimit(3, 60) } });
    const a = await env.ws("A");
    for (let i = 0; i < 3; i++) await sendText(a, null, "B", `m${i}`);
    a.send("send_message", { candidate_user_id: "B", content: "too many" });
    const err = await a.expect("error");
    expect(err.code).toBe("rate_limited");
    expect(Number.isInteger(err.retry_after) && err.retry_after >= 1).toBe(true);
    await a.expectNone("message_sent");

    const resp = await env.post("/chats/send", "A", { candidate_user_id: "B", content: "rest" });
    expect(resp.status).toBe(429);
    expect(resp.json.code).toBe("rate_limited");
    expect(resp.json.detail.code).toBe("rate_limited");
    expect(Number(resp.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Another user has their own bucket.
    const ok = await env.post("/chats/send", "B", { candidate_user_id: "A", content: "hi" });
    expect(ok.status).toBe(200);
    expect(ok.json.sender_type).toBe("user");
  });

  it("text length limit", async () => {
    const env = await makeEnv({ chatConfig: { maxTextLength: 10 } });
    const a = await env.ws("A");
    a.send("send_message", { candidate_user_id: "B", content: "x".repeat(11) });
    const err = await a.expect("error");
    expect(err.code).toBe("too_long");
    expect(err.max).toBe(10);
    await sendText(a, null, "B", "x".repeat(10));
    const resp = await env.post("/chats/send", "A", { candidate_user_id: "B", content: "y".repeat(11) });
    expect(resp.status).toBe(422);
    expect(resp.json.code).toBe("too_long");
    expect(resp.json.max).toBe(10);
  });

  it("typing over the limit is dropped silently; stop frames always pass", async () => {
    const env = await makeEnv({ chatConfig: { typingRate: new RateLimit(2, 60) } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    await sendText(a, b, "B", "hi");
    for (let i = 0; i < 4; i++) a.send("typing", { target_user_id: "B", is_typing: true });
    await a.sync();
    await b.expect("typing_status", { is_typing: true });
    await b.expect("typing_status", { is_typing: true });
    a.send("typing", { target_user_id: "B", is_typing: false });
    await b.expect("typing_status", { is_typing: false });
    await a.expectNone("error");
  });

  it("upload rate limit", async () => {
    const env = await makeEnv({ chatConfig: { uploadRate: new RateLimit(1, 60) } });
    const data = PNG.toString("base64");
    const a = await env.ws("A");
    a.send("media_upload", { target_user_id: "B", file_name: "a.png", file_data: data });
    await a.expect("media_upload_success");
    a.send("media_upload", { target_user_id: "B", file_name: "b.png", file_data: data });
    expect((await a.expect("error")).code).toBe("rate_limited");
  });

  it("clients cannot send reserved message types", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    a.send("send_message", { candidate_user_id: "B", content: "sneaky", message_type: "system" });
    const msg = (await a.expect("message_sent")).message;
    expect(msg.message_type).toBe("text");
    expect(msg.sender_type).toBe("user");
  });
});

describe("delete / unsend / clear", () => {
  it("delete for me hides only for the requester", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const m1 = await sendText(a, b, "B", "one");
    const m2 = await sendText(a, b, "B", "two");
    b.send("delete_message", { message_id: m2.id });
    expect(await b.expect("message_deleted")).toEqual({ type: "message_deleted", chat_id: m2.chat_id, message_id: m2.id, for_everyone: false });
    await a.expectNone("message_deleted");

    b.send("get_messages", { candidate_user_id: "A" });
    expect((await b.expect("res_messages")).messages.map((m: any) => m.content)).toEqual(["one"]);
    a.send("get_messages", { candidate_user_id: "B" });
    expect((await a.expect("res_messages")).messages.map((m: any) => m.content)).toEqual(["two", "one"]);

    b.send("req_users");
    const conv = (await b.expect("res_users")).users[0];
    expect(conv.last_message.content).toBe("one");
    expect(conv.unread_count).toBe(1);
    expect((await env.get("/chats/B/unread-count", "B")).json).toEqual({ unread_count: 1 });
    const rest = (await env.get(`/chats/${m1.chat_id}/messages`, "B")).json;
    expect(rest.map((m: any) => m.id)).toEqual([m1.id]);

    const c = await env.ws("C"); // not a participant -> not_found
    c.send("delete_message", { message_id: m1.id });
    expect((await c.expect("error")).code).toBe("not_found");
    b.send("delete_message", { message_id: 999999 });
    expect((await b.expect("error")).code).toBe("not_found");
  });

  it("unsend rewrites the row and deletes stored media", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("media_upload", { target_user_id: "B", file_name: "pic.png", file_data: PNG.toString("base64") });
    const media = (await a.expect("media_upload_success")).message;
    await b.expect("new_message");
    const file = (env.chat.storage as LocalDiskStorage).pathFor(media.file_url)!;
    expect(file && existsSync(file)).toBeTruthy();

    b.send("delete_message", { message_id: media.id, for_everyone: true }); // not the sender
    expect((await b.expect("error")).code).toBe("not_allowed");

    a.send("delete_message", { message_id: media.id, for_everyone: true });
    const event = { type: "message_deleted", chat_id: media.chat_id, message_id: media.id, for_everyone: true };
    expect(await a.expect("message_deleted")).toEqual(event);
    expect(await b.expect("message_deleted")).toEqual(event);

    b.send("get_messages", { candidate_user_id: "A" });
    const row = (await b.expect("res_messages")).messages[0];
    expect(row.id).toBe(media.id);
    expect(row.message_type).toBe("deleted");
    expect(row.content).toBeNull();
    expect(row.file_url).toBeNull();
    expect(row.file_name).toBeNull();
    expect(row.file_size).toBeNull();
    for (let i = 0; i < 150 && existsSync(file); i++) await sleep(20);
    expect(existsSync(file)).toBe(false);

    // Deleted messages don't count as unread; unsending twice just repeats the event.
    expect((await env.get("/chats/B/unread-count", "B")).json).toEqual({ unread_count: 0 });
    a.send("delete_message", { message_id: media.id, for_everyone: true });
    await a.expect("message_deleted", { message_id: media.id });
  });

  it("unsend window", async () => {
    const env = await makeEnv({ chatConfig: { unsendWindowSeconds: 60 } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    const old = await sendText(a, b, "B", "old");
    await env.db.updateTable("messages").set({ created_at: "2000-01-01 00:00:00.000000" }).where("id", "=", old.id).execute();
    a.send("delete_message", { message_id: old.id, for_everyone: true });
    expect((await a.expect("error")).code).toBe("window_expired");
    a.send("delete_message", { message_id: old.id }); // delete for me still works
    await a.expect("message_deleted", { for_everyone: false });

    const disabled = await makeEnv({ chatConfig: { unsendWindowSeconds: -1 } });
    const a2 = await disabled.ws("A");
    const msg = await sendText(a2, null, "B", "x");
    a2.send("delete_message", { message_id: msg.id, for_everyone: true });
    expect((await a2.expect("error")).code).toBe("not_allowed");
  });

  it("clear chat hides for the requester only", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    await sendText(a, b, "B", "one");
    const m2 = await sendText(b, a, "A", "two");
    a.send("clear_chat", { candidate_user_id: "B" });
    const cleared = await a.expect("chat_cleared");
    expect(cleared.chat_id).toBe(m2.chat_id);
    expect(cleared.cleared_at).toBeTruthy();
    await b.expectNone("chat_cleared");

    a.send("get_messages", { chat_id: m2.chat_id });
    expect((await a.expect("res_messages")).messages).toEqual([]);
    a.send("req_users");
    const conv = (await a.expect("res_users")).users[0];
    expect(conv.last_message).toBeNull();
    expect(conv.unread_count).toBe(0);
    expect(conv.chat_id).toBe(m2.chat_id);
    expect((await env.get("/chats/A/unread-count", "A")).json).toEqual({ unread_count: 0 });
    expect((await env.get(`/chats/${m2.chat_id}/messages`, "A")).json).toEqual([]);
    expect((await env.get("/chats/A", "A")).json[0].last_message).toBeNull();

    b.send("get_messages", { chat_id: m2.chat_id }); // the other person keeps theirs
    expect((await b.expect("res_messages")).messages.map((m: any) => m.content)).toEqual(["two", "one"]);

    await sendText(b, a, "A", "three"); // new messages show up again
    a.send("get_messages", { chat_id: m2.chat_id });
    expect((await a.expect("res_messages")).messages.map((m: any) => m.content)).toEqual(["three"]);

    a.send("clear_chat", { chat_id: 987654 });
    expect((await a.expect("error")).code).toBe("not_found");
  });
});

describe("read by peer, system and server sends", () => {
  it("mark_read by candidate_user_id (WS + REST)", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    const msg = await sendText(a, b, "B", "read me");
    b.send("mark_read", { chat_id: null, candidate_user_id: "A" });
    expect(await b.expect("chat_read")).toEqual({ type: "chat_read", chat_id: msg.chat_id });
    await a.expect("messages_read", { read_by: "B" });

    await sendText(b, a, "A", "back");
    const resp = await env.post("/chats/read", "A", { candidate_user_id: "B" });
    expect(resp.status).toBe(200);
    await b.expect("messages_read", { read_by: "A" });
    expect((await env.post("/chats/read", "A", { candidate_user_id: "C" })).status).toBe(404);

    a.send("mark_read", { candidate_user_id: "C" });
    expect((await a.expect("error")).error).toBe("Chat not found");
  });

  it("system messages", async () => {
    const env = await makeEnv();
    const events: any[] = [];
    env.hub.events.on("chat.system_message_sent", (dto) => void events.push(dto));
    const b = await env.ws("B");
    const dto = await env.chat.sendSystemMessage("B", "You matched with Alice", { aboutUserId: "A", data: { kind: "match" } });
    const live = (await b.expect("new_message")).message;
    expect(live.message_type).toBe("system");
    expect(live.sender_type).toBe("system");
    expect(live.content).toBe("You matched with Alice");
    expect(live.data).toEqual({ kind: "match" });
    expect(dto.id).toBe(live.id);
    expect(dto.is_delivered).toBe(true);
    expect(events[0].id).toBe(live.id);

    b.send("get_messages", { candidate_user_id: "A" });
    expect((await b.expect("res_messages")).messages[0].sender_type).toBe("system");

    // The about-user doesn't see it and gets no delivery receipt for it.
    const a = await env.ws("A");
    a.send("get_messages", { candidate_user_id: "B" });
    expect((await a.expect("res_messages")).messages).toEqual([]);
    a.send("req_users");
    expect((await a.expect("res_users")).users[0].last_message).toBeNull();
    await a.close();

    // Offline recipient -> push with the about-user's name and the extra data.
    await env.chat.sendSystemMessage("C", "Alice viewed your profile", { aboutUserId: "A" });
    const push = await env.push.waitFor((p) => p.user_id === "C");
    expect(push.title).toBe(PROFILES.A!.name);
    expect(push.data.system).toBe(true);
    expect(push.data.type).toBe("chat");
    expect(push.data.sender_id).toBe("A");
    const a2 = await env.ws("A");
    await a2.expectNone("delivery_status");

    await expect(env.chat.sendSystemMessage("B", "no partner")).rejects.toThrow(/aboutUserId/);
  });

  it("systemSenderId config", async () => {
    const env = await makeEnv({ chatConfig: { systemSenderId: "__system__", systemPushTitle: "App" } });
    const b = await env.ws("B");
    await env.chat.sendSystemMessage("B", "Welcome!");
    const msg = (await b.expect("new_message")).message;
    expect(msg.sender_id).toBe("__system__");
    expect(msg.sender_type).toBe("system");
  });

  it("sendMessageAs and REST send", async () => {
    const env = await makeEnv({ chatConfig: { messageRate: new RateLimit(1, 60) } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    const dto = await env.chat.sendMessageAs("A", "B", "from the server");
    expect(dto.sender_type).toBe("user");
    expect(dto.content).toBe("from the server");
    expect((await b.expect("new_message")).message.content).toBe("from the server");
    await a.expect("message_sent");
    // Trusted helper: no rate limit.
    await env.chat.sendMessageAs("A", "B", "again");
    await b.expect("new_message");

    const resp = await env.post("/chats/send", "B", { candidate_user_id: "A", content: "rest hi", reply_to_id: dto.id });
    expect(resp.status).toBe(200);
    expect(resp.json.content).toBe("rest hi");
    expect(resp.json.reply_to.id).toBe(dto.id);
    expect((await a.expect("new_message")).message.id).toBe(resp.json.id);
    await b.expect("message_sent");

    expect((await env.post("/chats/send", "A", { candidate_user_id: "B" })).status).toBe(422);
    await expect(env.chat.sendMessageAs("A", "A", "self")).rejects.toMatchObject({ status: 400 });
    await expect(env.chat.sendMessageAs("A", "A", "self")).rejects.toBeInstanceOf(ChatActionError);
  });

  it("REST send respects the policy", async () => {
    const deny: ChatPolicy = {
      refusalMessage: "Nope.",
      canMessage: async () => false,
      blockStatus: async () => ({}),
      extraConversationInfo: async () => ({}),
    };
    const env = await makeEnv({ chatPolicy: deny });
    const resp = await env.post("/chats/send", "A", { candidate_user_id: "B", content: "x" });
    expect(resp.status).toBe(403);
    expect(resp.json.error).toBe("Nope.");
    await env.chat.sendMessageAs("A", "B", "ok"); // skips the policy unless asked
    await expect(env.chat.sendMessageAs("A", "B", "no", { enforcePolicy: true })).rejects.toMatchObject({ error: "Nope." });
  });

  it("deleteUserData removes chats, messages, hides, clears and media", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("media_upload", { target_user_id: "B", file_name: "pic.png", file_data: PNG.toString("base64") });
    const media = (await a.expect("media_upload_success")).message;
    const m = await sendText(a, b, "B", "text");
    await b.expect("new_message");
    b.send("delete_message", { message_id: m.id });
    await b.expect("message_deleted");
    a.send("clear_chat", { candidate_user_id: "B" });
    await a.expect("chat_cleared");
    const file = (env.chat.storage as LocalDiskStorage).pathFor(media.file_url)!;
    expect(existsSync(file)).toBe(true);

    const counts = await env.chat.deleteUserData("A");
    expect(counts).toEqual({ chats: 1, messages: 2, media: 1 });
    expect(existsSync(file)).toBe(false);
    for (const t of ["chats", "messages", "comms_message_hidden", "comms_chat_cleared"]) {
      const row = await env.db.selectFrom(t).select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
      expect(Number((row as any).n)).toBe(0);
    }
    expect(await env.chat.deleteUserData("nobody")).toEqual({ chats: 0, messages: 0, media: 0 });
  });
});
