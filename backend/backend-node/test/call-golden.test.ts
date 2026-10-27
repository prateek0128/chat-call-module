/**
 * CROSS-LANGUAGE CHECK for calls: runs the same scripted exchange as test/golden/generate_call_golden.py against
 * the Node server and requires the (normalised) frames to equal the fixtures recorded from the Python backend.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimit } from "../src/index.js";
import { closeAllCall, makeCallEnv } from "./call.helpers.js";
import { type WsClient, sleep } from "./helpers.js";

afterEach(closeAllCall);

const DIR = path.resolve(__dirname, "golden/call");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOCK = /· \d+:\d\d(:\d\d)?$/;
const ID_KEYS = new Set(["id", "chat_id", "message_id", "message_ids"]);
const OFFER = { type: "offer", sdp: "v=0 offer" };
const ANSWER = { type: "answer", sdp: "v=0 answer" };

function normalise(value: any, key = ""): any {
  if (Array.isArray(value)) return value.map((v) => normalise(v, key));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, k)]));
  if (typeof value === "number" && Number.isInteger(value)) {
    if (ID_KEYS.has(key)) return "<id>";
    if (key === "duration_seconds") return "<dur>";
  }
  if (typeof value === "string") {
    if (ISO.test(value)) return "<ts>";
    if (UUID.test(value)) return "<uuid>";
    return value.replace(CLOCK, "· <clock>");
  }
  return value;
}

const fixture = (name: string) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"));

async function runScript() {
  const env = await makeCallEnv({ chat: true, config: { ringTimeout: 1.0, initiateRate: null as RateLimit | null } });
  const golden: Record<string, any> = {};
  const expectFrame = async (ws: WsClient, type: string, name?: string, match: Record<string, any> = {}) => {
    const frame = await ws.expect(type, match, 6000);
    if (name) golden[name] = normalise(frame);
    return frame;
  };
  const waitPush = async (pred: (p: any) => boolean, name: string) => {
    golden[name] = normalise(await env.push.waitFor(pred, 3000));
  };

  const a = await env.ws("A");
  let b = await env.ws("B");
  const c = await env.ws("C");

  // 1. happy path
  a.send("call_initiate", { receiver_id: "B", call_type: "audio", chat_id: 999 });
  let cid = (await expectFrame(a, "call_initiated", "happy_call_initiated")).call_id;
  await expectFrame(b, "incoming_call", "happy_incoming_call");
  await expectFrame(a, "call_ringing", "happy_call_ringing");
  a.send("sdp_offer", { call_id: cid, sdp: OFFER });
  await expectFrame(b, "sdp_offer", "happy_sdp_offer");
  b.send("ice_candidate", { call_id: cid, candidate: { candidate: "c-b" } });
  await expectFrame(a, "ice_candidate", "happy_ice_candidate");
  b.send("sdp_answer", { call_id: cid, sdp: ANSWER });
  await expectFrame(a, "sdp_answer", "happy_sdp_answer");
  b.send("answer_call", { call_id: cid });
  await expectFrame(a, "call_answered", "happy_call_answered_caller");
  await expectFrame(b, "call_answered", "happy_call_answered_answerer");
  a.send("end_call", { call_id: cid });
  await expectFrame(b, "call_ended", "happy_call_ended_receiver");
  await expectFrame(a, "call_ended", "happy_call_ended_caller");
  await expectFrame(a, "call_log", "happy_call_log");
  await expectFrame(b, "call_log");
  a.send("sdp_offer", { call_id: cid, sdp: OFFER });
  await expectFrame(a, "error", "error_no_active_call");

  // 2. video call declined
  a.send("call_initiate", { receiver_id: "B", call_type: "video" });
  cid = (await expectFrame(a, "call_initiated", "video_call_initiated")).call_id;
  await expectFrame(b, "incoming_call", "video_incoming_call");
  b.send("reject_call", { call_id: cid });
  await expectFrame(a, "call_rejected", "reject_call_rejected");
  await expectFrame(b, "call_rejected");
  await expectFrame(a, "call_log", "reject_call_log");
  await expectFrame(b, "call_log");

  // 3. caller cancels while ringing
  a.send("call_initiate", { receiver_id: "B" });
  cid = (await expectFrame(a, "call_initiated")).call_id;
  await expectFrame(b, "incoming_call");
  a.send("end_call", { call_id: cid });
  await expectFrame(a, "call_ended", "cancel_call_ended");
  await expectFrame(a, "call_log", "cancel_call_log");
  await expectFrame(b, "call_log");

  // 4. busy + already in a call + validation errors
  a.send("call_initiate", { receiver_id: "B" });
  cid = (await expectFrame(a, "call_initiated")).call_id;
  await expectFrame(b, "incoming_call");
  c.send("call_initiate", { receiver_id: "B", call_type: "video" });
  await expectFrame(c, "call_rejected", "busy_call_rejected");
  a.send("call_initiate", { receiver_id: "C" });
  await expectFrame(a, "error", "error_already_in_call");
  a.send("end_call", { call_id: cid });
  await expectFrame(a, "call_log");
  await expectFrame(b, "call_log");
  a.send("call_initiate", { receiver_id: "A" });
  await expectFrame(a, "error", "error_self_call");
  a.send("call_initiate");
  await expectFrame(a, "error", "error_missing_receiver");
  b.send("answer_call", { call_id: "nope" });
  await expectFrame(b, "error", "error_call_not_found");
  b.send("answer_call");
  await expectFrame(b, "error", "error_missing_call_id");
  a.send("sdp_offer", { call_id: "x" });
  await expectFrame(a, "error", "error_missing_sdp");

  // 5. ring timeout (1 s)
  a.send("call_initiate", { receiver_id: "B" });
  await expectFrame(a, "call_initiated");
  await expectFrame(b, "incoming_call");
  await expectFrame(a, "call_missed", "timeout_call_missed_caller");
  await expectFrame(b, "call_missed", "timeout_call_missed_receiver");
  await expectFrame(a, "call_log", "timeout_call_log");
  await expectFrame(b, "call_log");

  // 6. answering after a timeout / cancel
  a.send("call_initiate", { receiver_id: "B" });
  cid = (await expectFrame(a, "call_initiated")).call_id;
  await expectFrame(b, "incoming_call");
  a.send("end_call", { call_id: cid });
  await expectFrame(a, "call_log");
  await expectFrame(b, "call_log");
  b.send("answer_call", { call_id: cid });
  await expectFrame(b, "call_ended", "late_answer_call_ended");
  b.send("end_call", { call_id: cid });
  await expectFrame(b, "call_ended", "late_end_call_ended");

  // 7. receiver offline: incoming push, re-ring with stored offer on reconnect, REST decline
  await b.close();
  await sleep(300);
  a.send("call_initiate", { receiver_id: "B" });
  cid = (await expectFrame(a, "call_initiated", "offline_call_initiated")).call_id;
  await waitPush((p) => p.data.type === "incoming_call", "push_incoming_call");
  a.send("sdp_offer", { call_id: cid, sdp: OFFER });
  await a.sync();
  b = await env.ws("B");
  await expectFrame(b, "incoming_call", "rering_incoming_call");
  const resp = await env.post(`/call/${cid}/reject`, "B");
  golden.rest_reject = { status: resp.status, body: resp.json };
  await expectFrame(a, "call_rejected", "rest_reject_call_rejected");
  await expectFrame(a, "call_log");
  const miss = await env.post("/call/nope/reject", "B");
  golden.rest_reject_404 = { status: miss.status, body: miss.json };
  const turn = await env.post("/call/turn-credentials", "B");
  golden.rest_turn_503 = { status: turn.status, body: turn.json };

  // 8. offline receiver + caller cancels -> missed-call push
  await b.close();
  await sleep(300);
  a.send("call_initiate", { receiver_id: "B" });
  cid = (await expectFrame(a, "call_initiated")).call_id;
  a.send("end_call", { call_id: cid });
  await expectFrame(a, "call_ended");
  await waitPush((p) => p.data.type === "missed_call", "push_missed_call");
  b = await env.ws("B");

  // 9. the chat now holds the call entries
  b.send("get_messages", { candidate_user_id: "A", limit: 50 });
  golden.res_messages_calls = normalise(await b.expect("res_messages"));
  a.send("req_users");
  golden.res_users_calls = normalise(await a.expect("res_users"));
  return golden;
}

describe("call wire parity with the Python backend (golden fixtures)", () => {
  it("frames match the Python fixtures exactly (after normalisation)", async () => {
    const golden = await runScript();
    const names = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/^call-/, "").replace(/\.json$/, ""));
    expect(names.length).toBeGreaterThan(30);
    expect(Object.keys(golden).sort()).toEqual([...names].sort());
    for (const name of names) expect(golden[name], `frame ${name}`).toEqual(fixture(name));
  });
});
