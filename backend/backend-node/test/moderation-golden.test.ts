/**
 * CROSS-LANGUAGE CHECK for moderation: runs the same scripted exchange as test/golden/generate_moderation_golden.py against the
 * Node server and requires the (normalised) frames to equal the fixtures recorded from the Python backend.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFeature } from "../src/index.js";
import { ModerationFeature } from "../src/moderation/index.js";
import { type WsClient } from "./helpers.js";
import { closeAllFeatureEnvs, makeFeatureEnv } from "./moderation-env.js";

afterEach(closeAllFeatureEnvs);

const DIR = path.resolve(__dirname, "golden", "moderation");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const ID_KEYS = new Set(["id", "report_id"]);

function normalise(value: any, key = ""): any {
  if (Array.isArray(value)) return value.map((v) => normalise(v, key));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, k)]));
  if (typeof value === "number" && Number.isInteger(value) && ID_KEYS.has(key)) return "<id>";
  if (typeof value === "string" && ISO.test(value)) return "<ts>";
  return value;
}

const fixture = (name: string) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"));

describe("moderation golden frames (recorded from the Python backend)", () => {
  it("frames and REST bodies equal Python's", async () => {
    const env = await makeFeatureEnv((hub) => {
      hub.install(new ChatFeature());
      hub.install(new ModerationFeature());
    });
    const golden: Record<string, any> = {};
    const expectFrame = async (ws: WsClient, type: string, name?: string) => {
      const frame = await ws.expect(type);
      if (name) golden[name] = normalise(frame);
      return frame;
    };
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("block", { candidate_user_id: "B" });
    await expectFrame(a, "user_blocked", "user_blocked");
    await expectFrame(b, "blocked_by_user", "blocked_by_user");
    a.send("unblock", { candidate_user_id: "B" });
    await expectFrame(a, "user_unblocked", "user_unblocked");
    await expectFrame(b, "unblocked_by_user", "unblocked_by_user");
    a.send("report_and_block", { candidate_user_id: "B", reason: "rude", category: "Harassment", message_id: 7 });
    await expectFrame(a, "user_blocked");
    await expectFrame(a, "report_received", "report_received");
    a.send("block", { candidate_user_id: "A" });
    await expectFrame(a, "error", "error_self_block");
    a.send("report_and_block", { candidate_user_id: "B", message_id: "abc" });
    await expectFrame(a, "error", "error_bad_message_id");

    golden.rest_blocks = normalise((await env.get("/moderation/blocks", "A")).json);
    golden.rest_block_status = (await env.post("/moderation/blocks", "A", { user_id: "B" })).json;
    const self = await env.post("/moderation/blocks", "A", { user_id: "A" });
    golden.rest_block_self = { status: self.status, body: self.json };
    const noReason = await env.post("/moderation/reports", "A", { user_id: "B" });
    golden.rest_report_no_reason = { status: noReason.status, body: noReason.json };
    golden.rest_report = normalise((await env.post("/moderation/reports", "A", { user_id: "B", reason: "x" })).json);

    const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(golden).sort()).toEqual([...names].sort());
    for (const name of names) expect(golden[name], `frame ${name}`).toEqual(fixture(name));
  });
});
