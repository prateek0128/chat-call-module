/** Moderation (PROTOCOL.md sections 7 and 9): block / unblock / report over WS and REST, policy wrapping, linking, admin review. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFeature, type ChatPolicy, HttpError, type CommsHub, type Feature } from "../src/index.js";
import { linkModeration } from "../src/integration/moderation.js";
import {
  ModerationCallPolicy, ModerationChatPolicy, ModerationFeature, type ModerationFeatureOptions, type ReportInfo,
} from "../src/moderation/index.js";
import { sleep } from "./helpers.js";
import { type FeatureEnv, closeAllFeatureEnvs, makeFeatureEnv } from "./moderation-env.js";

afterEach(closeAllFeatureEnvs);

const BLOCKED_CHAT = "Cannot send message. User is blocked.";
const PNG_B64 = Buffer.from("89504e470d0a1a0a" + "30".repeat(32), "hex").toString("base64");

/** Records endCallsBetween calls; registered as the "call" feature with a policy slot. */
class FakeCall implements Feature {
  readonly name = "call";
  policy: any;
  hub!: CommsHub;
  ended: Array<[string, string, string, string | null | undefined]> = [];
  lifecycle = {
    endCallsBetween: async (a: string, b: string, reason: string, by?: string | null) => {
      this.ended.push([a, b, reason, by]);
    },
  };
  constructor(policy: any = null) {
    this.policy = policy;
  }
  install(hub: CommsHub) {
    this.hub = hub;
    hub.registerFeature(this.name, this);
    return this;
  }
}

interface Setup {
  chat?: boolean;
  call?: boolean | FakeCall;
  link?: boolean;
  chatPolicy?: ChatPolicy;
  moderation?: ModerationFeatureOptions;
}

async function makeEnv(o: Setup = {}): Promise<FeatureEnv & { moderation: ModerationFeature; chat: ChatFeature | null; call: FakeCall | null }> {
  const moderation = new ModerationFeature(o.moderation);
  let chat: ChatFeature | null = null;
  let call: FakeCall | null = null;
  const env = await makeFeatureEnv((hub) => {
    if (o.chat !== false) chat = hub.install(new ChatFeature({ policy: o.chatPolicy }));
    if (o.call) call = hub.install(o.call === true ? new FakeCall() : o.call);
    hub.install(moderation);
    if (o.link !== false) linkModeration(moderation, { chat, call });
  });
  return Object.assign(env, { moderation, chat, call });
}

async function block(a: any, b: any, blocker = "A", target = "B") {
  a.send("block", { candidate_user_id: target });
  const frame = await a.expect("user_blocked");
  expect(frame.candidate_user_id).toBe(target);
  expect(frame.message).toBeTruthy();
  const by = await b.expect("blocked_by_user");
  expect(by.candidate_user_id).toBe(blocker);
}

describe("moderation with chat", () => {
  it("block stops chat both ways and unblock restores", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "B", content: "before" });
    const chatId = (await a.expect("message_sent")).message.chat_id;
    await b.expect("new_message");

    await block(a, b);
    for (const [ws, target] of [[a, "B"], [b, "A"]] as const) {
      ws.send("send_message", { candidate_user_id: target, content: "hi" });
      expect((await ws.expect("error")).error).toBe(BLOCKED_CHAT);
      ws.send("media_upload", { target_user_id: target, file_name: "x.png", file_data: PNG_B64 });
      expect((await ws.expect("error")).error).toBe(BLOCKED_CHAT);
    }
    b.send("typing", { target_user_id: "A", is_typing: true });
    await b.sync();
    await a.expectNone("typing_status");
    await a.expectNone("new_message", 100);

    a.send("req_users");
    let user = (await a.expect("res_users")).users[0];
    expect([user.is_blocked, user.blocked_by_other]).toEqual([true, false]);
    b.send("get_messages", { chat_id: chatId });
    const info = (await b.expect("res_messages")).info;
    expect([info.is_blocked, info.blocked_by_other]).toEqual([false, true]);

    a.send("unblock", { candidate_user_id: "B" });
    expect((await a.expect("user_unblocked")).candidate_user_id).toBe("B");
    expect((await b.expect("unblocked_by_user")).candidate_user_id).toBe("A");
    b.send("send_message", { candidate_user_id: "A", content: "back" });
    expect((await a.expect("new_message")).message.content).toBe("back");
    b.send("typing", { target_user_id: "A", is_typing: true });
    expect((await a.expect("typing_status")).is_typing).toBe(true);
    a.send("req_users");
    user = (await a.expect("res_users")).users[0];
    expect([user.is_blocked, user.blocked_by_other]).toEqual([false, false]);
  });

  it("report_and_block: hook, events, normalisation, block:false", async () => {
    const reports: ReportInfo[] = [];
    const env = await makeEnv({ moderation: { onReport: async (r) => void reports.push(r) } });
    const seen: ReportInfo[] = [];
    env.hub.events.on("moderation.reported", (i: ReportInfo) => void seen.push(i));
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("report_and_block", { candidate_user_id: "B", reason: "rude", category: "Harassment", message_id: 7 });
    const blocked = await a.expect("user_blocked");
    const received = await a.expect("report_received");
    expect(blocked.candidate_user_id).toBe("B");
    expect(received.candidate_user_id).toBe("B");
    expect(Number.isInteger(received.report_id)).toBe(true);
    await b.expect("blocked_by_user");
    for (let i = 0; i < 100 && !reports.length; i++) await sleep(20);
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect([r.id, r.reporter_id, r.reported_id, r.reason, r.category, r.message_id, r.status, r.blocked]).toEqual([
      received.report_id, "A", "B", "rude", "harassment", 7, "open", true,
    ]);
    expect(seen).toEqual([r]);

    a.send("report_and_block", { candidate_user_id: "C", block: false });
    expect((await a.expect("report_received")).candidate_user_id).toBe("C");
    a.send("send_message", { candidate_user_id: "C", content: "still fine" });
    await a.expect("message_sent");
  });

  it("ws errors carry context moderation", async () => {
    const env = await makeEnv();
    const a = await env.ws("A");
    for (const [type, payload] of [
      ["block", {}], ["unblock", { candidate_user_id: "" }], ["report_and_block", { candidate_user_id: "A" }],
      ["report_and_block", { candidate_user_id: "B", message_id: "abc" }],
    ] as const) {
      a.send(type, payload);
      const err = await a.expect("error");
      expect(err.context).toBe("moderation");
      expect(err.error).toBeTruthy();
    }
  });

  it("failing onReport hook does not break the report", async () => {
    const env = await makeEnv({ moderation: { onReport: async () => { throw new Error("boom"); } } });
    const a = await env.ws("A");
    a.send("report_and_block", { candidate_user_id: "B", reason: "x" });
    await a.expect("report_received");
  });

  it("notifyBlockedUser false", async () => {
    const env = await makeEnv({ moderation: { notifyBlockedUser: false } });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("block", { candidate_user_id: "B" });
    await a.expect("user_blocked");
    a.send("unblock", { candidate_user_id: "B" });
    await a.expect("user_unblocked");
    await b.sync();
    await b.expectNone("blocked_by_user", 150);
    await b.expectNone("unblocked_by_user", 150);
  });

  it("blocking twice still emits moderation.blocked; unblock only when removed", async () => {
    const env = await makeEnv();
    const events: string[] = [];
    env.hub.events.on("moderation.blocked", (x: string, y: string) => void events.push(`blocked ${x}>${y}`));
    env.hub.events.on("moderation.unblocked", (x: string, y: string) => void events.push(`unblocked ${x}>${y}`));
    const a = await env.ws("A");
    a.send("block", { candidate_user_id: "B" });
    await a.expect("user_blocked");
    a.send("block", { candidate_user_id: "B" });
    await a.expect("user_blocked");
    a.send("unblock", { candidate_user_id: "B" });
    await a.expect("user_unblocked");
    a.send("unblock", { candidate_user_id: "B" });
    await a.expect("user_unblocked");
    expect(events).toEqual(["blocked A>B", "blocked A>B", "unblocked A>B"]);
    expect((await env.db.selectFrom("comms_blocks").selectAll().execute()).length).toBe(0);
  });
});

describe("moderation REST", () => {
  it("blocks and reports", async () => {
    const env = await makeEnv();
    expect((await env.get("/moderation/blocks")).status).toBe(401);
    const a = await env.ws("A");
    const b = await env.ws("B");
    expect((await env.post("/moderation/blocks", "A", { user_id: "B" })).json).toEqual({ status: true });
    await a.expect("user_blocked");
    await b.expect("blocked_by_user");
    await env.post("/moderation/blocks", "A", { user_id: "C" });
    const listed = (await env.get("/moderation/blocks", "A")).json;
    expect(listed.map((x: any) => x.user_id).sort()).toEqual(["B", "C"]);
    const bob = listed.find((x: any) => x.user_id === "B");
    expect([bob.username, bob.avatar]).toEqual(["Bob", "https://img/b.png"]);
    expect(bob.blocked_at).toBeTruthy();

    expect((await env.rest("DELETE", "/moderation/blocks/B", "A")).json).toEqual({ status: true });
    await b.expect("unblocked_by_user");
    expect((await env.get("/moderation/blocks", "A")).json.map((x: any) => x.user_id)).toEqual(["C"]);

    expect((await env.post("/moderation/blocks", "A", { user_id: "A" })).status).toBe(422);
    expect((await env.post("/moderation/blocks", "A", {})).status).toBe(422);
    expect((await env.post("/moderation/reports", "A", { user_id: "B" })).status).toBe(422);

    const r = await env.post("/moderation/reports", "A", { user_id: "B", reason: "spam!", category: "spam" });
    expect(r.status).toBe(200);
    expect((await a.expect("report_received")).report_id).toBe(r.json.report_id);
    expect((await env.get("/moderation/blocks", "A")).json.map((x: any) => x.user_id)).not.toContain("B"); // block defaults off
    expect((await env.post("/moderation/reports", "A", { user_id: "B", reason: "x", block: true })).status).toBe(200);
    expect((await env.get("/moderation/blocks", "A")).json.map((x: any) => x.user_id)).toContain("B");
  });
});

describe("moderation admin review", () => {
  const admin = async (ctx: any) => {
    if (ctx.headers["x-admin"] !== "secret") throw new HttpError(403, "admins only");
    return "mod-1";
  };
  const ADMIN = { "x-admin": "secret" };

  it("routes are not mounted without adminDependency", async () => {
    const env = await makeEnv();
    expect((await env.get("/moderation/admin/reports", null, ADMIN)).status).toBe(404);
  });

  it("list, resolve and context", async () => {
    const env = await makeEnv({ moderation: { adminDependency: admin } });
    const resolved: any[] = [];
    env.hub.events.on("moderation.report_resolved", (r: any) => void resolved.push(r));
    const a = await env.ws("A");
    const b = await env.ws("B");
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const [sender, receiver, to] = i % 2 === 0 ? [a, b, "B"] : [b, a, "A"];
      sender.send("send_message", { candidate_user_id: to, content: `m${i}` });
      ids.push((await sender.expect("message_sent")).message.id);
      await receiver.expect("new_message");
    }
    a.send("report_and_block", { candidate_user_id: "B", reason: "rude", category: "harassment", message_id: ids[3], block: false });
    const reportId = (await a.expect("report_received")).report_id;
    b.send("report_and_block", { candidate_user_id: "A", reason: "spam", block: false });
    const otherId = (await b.expect("report_received")).report_id;

    expect((await env.get("/moderation/admin/reports")).status).toBe(403);
    const listed = (await env.get("/moderation/admin/reports?status=open", null, ADMIN)).json;
    expect(listed.map((r: any) => r.report_id)).toEqual([otherId, reportId]);
    expect(listed[1]).toMatchObject({ reporter_id: "A", reported_id: "B", reason: "rude", category: "harassment", message_id: ids[3], status: "open", resolved_at: null, resolved_by: null, note: null });
    expect((await env.get("/moderation/admin/reports?status=bogus", null, ADMIN)).status).toBe(422);
    expect((await env.get("/moderation/admin/reports?limit=0", null, ADMIN)).status).toBe(422);
    expect((await env.get("/moderation/admin/reports?limit=1&offset=1", null, ADMIN)).json.map((r: any) => r.report_id)).toEqual([reportId]);

    const ctx = (await env.get(`/moderation/admin/reports/${reportId}/context?before=2&after=1`, null, ADMIN)).json;
    expect(ctx.report.report_id).toBe(reportId);
    // newest first: 1 after, the message itself, 2 before
    expect(ctx.messages.map((m: any) => m.content)).toEqual(["m4", "m3", "m2", "m1"]);
    expect(ctx.messages.map((m: any) => m.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
    const latest = (await env.get(`/moderation/admin/reports/${otherId}/context?before=2&after=0`, null, ADMIN)).json;
    expect(latest.messages).toHaveLength(3); // no message_id: latest before + after + 1
    expect((await env.get("/moderation/admin/reports/99999/context", null, ADMIN)).status).toBe(404);
    expect((await env.get("/moderation/admin/reports/abc/context", null, ADMIN)).status).toBe(422);

    expect((await env.post(`/moderation/admin/reports/${reportId}`, null, { status: "resolved", note: " handled " })).status).toBe(403);
    expect((await env.post(`/moderation/admin/reports/${reportId}`, null, { status: "nope" }, ADMIN)).status).toBe(422);
    const done = (await env.post(`/moderation/admin/reports/${reportId}`, null, { status: "resolved", note: " handled " }, ADMIN)).json;
    expect(done).toMatchObject({ report_id: reportId, status: "resolved", resolved_by: "mod-1", note: "handled" });
    expect(done.resolved_at).toBeTruthy();
    expect(resolved).toHaveLength(1);
    expect((await env.get("/moderation/admin/reports?status=open", null, ADMIN)).json.map((r: any) => r.report_id)).toEqual([otherId]);
    const reopened = (await env.post(`/moderation/admin/reports/${reportId}`, null, { status: "open" }, ADMIN)).json;
    expect([reopened.status, reopened.resolved_at, reopened.resolved_by, reopened.note]).toEqual(["open", null, null, "handled"]);
    expect((await env.post("/moderation/admin/reports/99999", null, { status: "dismissed" }, ADMIN)).status).toBe(404);
  });

  it("context without chat is empty", async () => {
    const env = await makeEnv({ chat: false, moderation: { adminDependency: admin } });
    const a = await env.ws("A");
    a.send("report_and_block", { candidate_user_id: "B", reason: "x" });
    const id = (await a.expect("report_received")).report_id;
    const ctx = (await env.get(`/moderation/admin/reports/${id}/context`, null, ADMIN)).json;
    expect(ctx.messages).toEqual([]);
  });
});

describe("policies and linking", () => {
  const hostChat: ChatPolicy = {
    refusalMessage: "Consent required.",
    async canMessage(_db, _s, recipient) {
      return recipient !== "C";
    },
    async blockStatus(_db, _v, others) {
      return Object.fromEntries(others.filter((o) => o === "C").map((o) => [o, [false, true] as [boolean, boolean]]));
    },
    async extraConversationInfo(_db, _v, other) {
      return { chat_consent_given: other !== "C" };
    },
  };

  it("wraps host chat policy: host refusal message passes through, block text only for blocks", async () => {
    const env = await makeEnv({ chatPolicy: hostChat });
    expect(env.chat!.policy).toBeInstanceOf(ModerationChatPolicy);
    expect((env.chat!.policy as ModerationChatPolicy).inner).toBe(hostChat);
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "C", content: "hi" });
    expect((await a.expect("error")).error).toBe("Consent required.");
    a.send("get_messages", { candidate_user_id: "C" });
    const info = (await a.expect("res_messages")).info;
    expect([info.chat_consent_given, info.blocked_by_other]).toEqual([false, true]);
    await block(a, b);
    a.send("send_message", { candidate_user_id: "B", content: "hi" });
    expect((await a.expect("error")).error).toBe(BLOCKED_CHAT);
  });

  it("call policy: blocked pair denied before the host policy runs; others pass through", async () => {
    let calls = 0;
    const inner = {
      async authorize(_db: any, _c: string, receiver: string) {
        calls += 1;
        return receiver === "C" ? { allowed: false, error: { error: "No credits", status: 402 } } : { allowed: true };
      },
    };
    const call = new FakeCall(inner);
    const env = await makeEnv({ chat: false, call });
    expect(call.policy).toBeInstanceOf(ModerationCallPolicy);
    const { db } = env;
    expect(await call.policy.authorize(db, "A", "C", {})).toEqual({ allowed: false, error: { error: "No credits", status: 402 } });
    expect(calls).toBe(1);
    expect(await call.policy.authorize(db, "A", "B", {})).toEqual({ allowed: true });
    await env.moderation.actions.block(db, "A", "B");
    for (const [x, y] of [["A", "B"], ["B", "A"]]) {
      expect(await call.policy.authorize(db, x, y, {})).toEqual({ allowed: false, error: { error: "Cannot call. User is blocked.", reason: "blocked" } });
    }
    expect(calls).toBe(2); // blocked pair never reaches the host policy
    await env.moderation.actions.unblock(db, "A", "B");
    expect((await call.policy.authorize(db, "A", "B", {})).allowed).toBe(true);
  });

  it("call-only: callPolicy without inner allows by default; block ends calls with reason blocked", async () => {
    const env = await makeEnv({ chat: false, call: true });
    const call = env.call!;
    expect(await call.policy.authorize(env.db, "A", "B", {})).toEqual({ allowed: true });
    const a = await env.ws("A");
    const b = await env.ws("B");
    b.send("report_and_block", { candidate_user_id: "A", reason: "spam call" });
    await b.expect("report_received");
    expect(call.ended).toEqual([["B", "A", "blocked", "B"]]);
    await a.expect("blocked_by_user");
  });

  it("chat + call: link wraps both once; second link throws; pre-wrapped policies are not wrapped again", async () => {
    const env = await makeEnv({ call: true });
    expect(() => linkModeration(env.moderation, { chat: env.chat!, call: env.call! })).toThrow(/already linked/);
    expect((env.chat!.policy as ModerationChatPolicy).inner).not.toBeInstanceOf(ModerationChatPolicy);

    const moderation = new ModerationFeature();
    const wrapped = moderation.chatPolicy(null);
    const env2 = await makeFeatureEnv((hub) => {
      const chat = hub.install(new ChatFeature({ policy: wrapped }));
      hub.install(moderation);
      linkModeration(moderation, { chat });
      expect(chat.policy).toBe(wrapped);
    });
    expect(env2.hub.features.moderation).toBe(moderation);
  });

  it("unlinked moderation does not touch the features", async () => {
    const env = await makeEnv({ link: false, call: true });
    const a = await env.ws("A");
    const b = await env.ws("B");
    await block(a, b);
    a.send("send_message", { candidate_user_id: "B", content: "host policy decides" });
    await a.expect("message_sent");
    expect(env.call!.ended).toEqual([]);
  });

  it("linking features of another hub is rejected", async () => {
    const env = await makeEnv({ chat: false });
    const other = await makeEnv({ call: true });
    expect(() => linkModeration(env.moderation, { call: other.call! })).toThrow(/same CommsHub/);
  });

  it("moderation alone (no chat, no call)", async () => {
    const env = await makeEnv({ chat: false });
    const a = await env.ws("A");
    const b = await env.ws("B");
    await block(a, b);
    expect((await env.get("/moderation/blocks", "A")).json[0].user_id).toBe("B");
    expect(await env.moderation.isBlockedBetween("B", "A")).toBe(true);
    expect(await env.moderation.blockStatus("A", ["B", "C"])).toEqual({ B: [true, false] });
    expect(await env.moderation.blockStatus("B", ["A"])).toEqual({ A: [false, true] });
  });
});

describe("moderation data deletion", () => {
  it("blocks are deleted, reports kept with ids nulled", async () => {
    const env = await makeEnv({ chat: false });
    const m = env.moderation;
    await m.actions.block(env.db, "A", "B");
    await m.actions.block(env.db, "C", "A");
    await m.actions.block(env.db, "B", "C");
    await m.actions.report(env.db, "A", "B", { reason: "x", block: false });
    await m.actions.report(env.db, "B", "A", { reason: "y", block: false });
    await m.actions.report(env.db, "B", "C", { reason: "z", block: false });
    expect(await m.deleteUserData("A")).toEqual({ blocks: 2, reports_anonymized: 2 });
    const blocks = await env.db.selectFrom("comms_blocks").selectAll().execute();
    expect(blocks.map((b: any) => [b.blocker_id, b.blocked_id])).toEqual([["B", "C"]]);
    const reports = await m.listReports(null);
    expect(reports).toHaveLength(3);
    expect(reports.map((r) => [r.reporter_id, r.reported_id, r.reason]).sort((p, q) => String(p[2]).localeCompare(String(q[2])))).toEqual([
      [null, "B", "x"], ["B", null, "y"], ["B", "C", "z"],
    ]);
  });
});

describe("import boundaries (phase 2B)", () => {
  const SRC = path.resolve(__dirname, "../src");
  const imports = (file: string): string[] =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)].map((m) => {
      const rel = path.relative(SRC, path.resolve(path.dirname(file), m[1]!)).split(path.sep);
      return rel.length > 1 ? rel[0]! : "(root)";
    });

  it("moderation imports only core", () => {
    for (const f of readdirSync(path.join(SRC, "moderation")).filter((x) => x.endsWith(".ts"))) {
      for (const dep of imports(path.join(SRC, "moderation", f))) expect(["core", "moderation"], f).toContain(dep);
    }
  });

  it("integration/moderation has no static import of chat or call (chat is loaded lazily)", () => {
    const file = path.join(SRC, "integration", "moderation.ts");
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/^\s*import[^;]*from\s*["']\.\.\/(chat|call)\//m);
    expect(text).not.toMatch(/^\s*export[^;]*from\s*["']\.\.\/(chat|call)\//m);
    expect(imports(file).filter((d) => !["core", "moderation", "chat"].includes(d))).toEqual([]);
  });

  it("integration/privacy imports only core", () => {
    for (const dep of imports(path.join(SRC, "integration", "privacy.ts"))) expect(dep).toBe("core");
  });
});
