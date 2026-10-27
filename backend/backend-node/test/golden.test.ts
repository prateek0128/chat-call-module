/**
 * CROSS-LANGUAGE CHECK: runs the same scripted exchange as test/golden/generate_golden.py against the Node
 * server and requires the (normalised) frames to equal the fixtures recorded from the Python backend.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WsClient, closeAll, makeEnv, sleep } from "./helpers.js";

afterEach(closeAll);

const DIR = path.resolve(__dirname, "golden");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const ID_KEYS = new Set(["id", "chat_id", "message_id", "message_ids"]);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function normalise(value: any, key = ""): any {
  if (Array.isArray(value)) return value.map((v) => normalise(v, key));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, k)]));
  if (typeof value === "number" && Number.isInteger(value) && ID_KEYS.has(key)) return "<id>";
  if (typeof value === "string") {
    if (ISO.test(value)) return "<ts>";
    return value.replace(/\/media\/chat\/\d+\/(\w+)\/[0-9a-f]{12}_/, "/media/chat/<id>/$1/<rand>_");
  }
  return value;
}

/** keys + JSON types, recursively (for the readable "shape" assertion). */
function shape(v: any): any {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v === null) return "null";
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

const fixture = (name: string) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"));

async function runScript() {
  const env = await makeEnv();
  const golden: Record<string, any> = {};
  const expectFrame = async (ws: WsClient, type: string, name?: string, match: Record<string, any> = {}) => {
    const frame = await ws.expect(type, match);
    if (name) golden[name] = normalise(frame);
    return frame;
  };

  let a = await env.ws("A");
  let b = await env.ws("B");
  a.send("send_message", { candidate_user_id: "B", content: "hello Bob" });
  const first = (await expectFrame(b, "new_message", "new_message")).message;
  await expectFrame(a, "message_sent", "message_sent");

  b.send("send_message", { candidate_user_id: "A", content: "hi Alice", reply_to_id: first.id });
  await expectFrame(a, "new_message", "new_message_reply");
  await expectFrame(b, "message_sent", "message_sent_reply");

  a.send("media_upload", { target_user_id: "B", file_name: "photo.png", file_data: PNG.toString("base64") });
  const media = (await expectFrame(a, "media_upload_success", "media_upload_success")).message;
  await expectFrame(b, "new_message", "new_message_media");
  await expectFrame(a, "message_sent", "message_sent_media");

  a.send("typing", { target_user_id: "B", is_typing: true });
  await expectFrame(b, "typing_status", "typing_status");

  b.send("mark_read", { candidate_user_id: "A" });
  await expectFrame(b, "chat_read", "chat_read");
  await expectFrame(a, "messages_read", "messages_read");

  b.send("req_users");
  await expectFrame(b, "res_users", "res_users");
  b.send("get_messages", { candidate_user_id: "A", limit: 10 });
  await expectFrame(b, "res_messages", "res_messages");

  b.send("user_status", { status: "away" });
  await expectFrame(a, "user_status", "user_status", { user_id: "B", status: "away" });

  a.send("delete_message", { message_id: media.id, for_everyone: true });
  await expectFrame(b, "message_deleted", "message_deleted");
  a.send("get_messages", { candidate_user_id: "B", limit: 10 });
  await expectFrame(a, "res_messages", "res_messages_after_unsend");
  await a.close();
  await b.close();

  a = await env.ws("A");
  a.send("send_message", { candidate_user_id: "B", content: "while you were away" });
  await expectFrame(a, "message_sent", "message_sent_offline");
  b = await env.ws("B");
  await expectFrame(a, "delivery_status", "delivery_status");

  await b.close();
  await a.close();
  await sleep(150);

  golden.rest_start = normalise((await env.post("/chats/start?candidate_id=B", "A")).json);
  golden.rest_list = normalise((await env.get("/chats/A", "A")).json);
  golden.rest_messages = normalise((await env.get(`/chats/${media.chat_id}/messages?limit=2`, "A")).json);
  golden.rest_unread = (await env.get("/chats/A/unread-count", "A")).json;
  golden.rest_online = (await env.get("/chats/B/online-status", "A")).json;
  const bad = await env.get("/chats/B", "A");
  golden.rest_forbidden = { status: bad.status, body: bad.json };
  golden.rest_422_status = (await env.post("/chats/start", "A")).status;
  return golden;
}

describe("wire parity with the Python backend (golden fixtures)", () => {
  it("frames match the Python fixtures exactly (after normalisation) and shapes agree", async () => {
    const golden = await runScript();
    const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    expect(names.length).toBeGreaterThan(20);
    expect(Object.keys(golden).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(shape(golden[name]), `shape of ${name}`).toEqual(shape(fixture(name)));
      expect(golden[name], `frame ${name}`).toEqual(fixture(name));
    }
  });

  it("key frames carry the expected keys (spot check)", () => {
    for (const n of ["new_message", "message_sent", "res_users", "res_messages"]) expect(fixture(n)).toBeTruthy();
    expect(Object.keys(fixture("new_message").message)).toContain("reply_to");
    expect(Object.keys(fixture("res_users").users[0])).toContain("blocked_by_other");
    expect(Object.keys(fixture("res_messages").info)).toContain("chat_consent_given");
  });
});
