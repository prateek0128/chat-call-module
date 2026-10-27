/** deleteUserEverywhere: order, error isolation, user.deleted event, real moderation + devices + chat data. */
import { afterEach, describe, expect, it } from "vitest";
import { ChatFeature, type CommsHub, type Feature } from "../src/index.js";
import { DevicesFeature, SqlDeviceRegistry } from "../src/core/devices.js";
import { deleteUserEverywhere } from "../src/integration/privacy.js";
import { ModerationFeature } from "../src/moderation/index.js";
import { closeAllFeatureEnvs, makeFeatureEnv } from "./moderation-env.js";

afterEach(closeAllFeatureEnvs);

class Recorder implements Feature {
  constructor(
    readonly name: string,
    private log: string[],
    private fail = false,
  ) {}
  install(hub: CommsHub) {
    hub.registerFeature(this.name, this);
    return this;
  }
  async deleteUserData(userId: string) {
    this.log.push(`${this.name}:${userId}`);
    if (this.fail) throw new Error(`${this.name} broke`);
    return { done: this.name };
  }
}

describe("deleteUserEverywhere", () => {
  it("runs chat, call, moderation, devices in that order (others after), then emits user.deleted", async () => {
    const log: string[] = [];
    const env = await makeFeatureEnv((hub) => {
      for (const n of ["devices", "zeta", "moderation", "alpha", "call", "chat"]) hub.install(new Recorder(n, log));
      hub.features.noDelete = {}; // features without deleteUserData are skipped
      hub.events.on("user.deleted", (u: string) => void log.push(`event:${u}`));
    });
    const results = await deleteUserEverywhere(env.hub, "U1");
    expect(log).toEqual(["chat:U1", "call:U1", "moderation:U1", "devices:U1", "alpha:U1", "zeta:U1", "event:U1"]);
    expect(Object.keys(results)).toEqual(["chat", "call", "moderation", "devices", "alpha", "zeta"]);
    expect(results.chat).toEqual({ done: "chat" });
  });

  it("a failing feature is reported and the rest still run; raiseErrors rethrows", async () => {
    const log: string[] = [];
    const env = await makeFeatureEnv((hub) => {
      hub.install(new Recorder("chat", log, true));
      hub.install(new Recorder("moderation", log));
      hub.events.on("user.deleted", (u: string) => void log.push(`event:${u}`));
    });
    const results = await deleteUserEverywhere(env.hub, "U1");
    expect(results.chat).toEqual({ error: "chat broke" });
    expect(results.moderation).toEqual({ done: "moderation" });
    expect(log).toEqual(["chat:U1", "moderation:U1", "event:U1"]);
    await expect(deleteUserEverywhere(env.hub, "U1", { raiseErrors: true })).rejects.toThrow("chat broke");
  });

  it("works with nothing installed", async () => {
    const env = await makeFeatureEnv(() => undefined);
    expect(await deleteUserEverywhere(env.hub, "U1")).toEqual({});
  });

  it("real features: chat messages, blocks, reports and devices of the user are gone", async () => {
    let registry!: SqlDeviceRegistry;
    const moderation = new ModerationFeature();
    const events: string[] = [];
    const env = await makeFeatureEnv((hub, db) => {
      registry = new SqlDeviceRegistry(db);
      hub.install(new DevicesFeature(registry));
      hub.install(new ChatFeature());
      hub.install(moderation);
      hub.events.on("user.deleted", (u: string) => void events.push(u));
    });
    const a = await env.ws("A");
    const b = await env.ws("B");
    a.send("send_message", { candidate_user_id: "B", content: "hello" });
    await a.expect("message_sent");
    await b.expect("new_message");
    await env.post("/devices", "A", { device_id: "dA", platform: "ios", expo_push_token: "t" });
    await env.post("/devices", "B", { device_id: "dB", platform: "android" });
    b.send("report_and_block", { candidate_user_id: "A", reason: "x" });
    await b.expect("report_received");

    const results: any = await deleteUserEverywhere(env.hub, "A", { raiseErrors: true });
    expect(results.chat.messages).toBe(1);
    expect(results.moderation).toEqual({ blocks: 1, reports_anonymized: 1 });
    expect(results.devices).toEqual({ devices: 1 });
    expect(events).toEqual(["A"]);
    expect(await env.db.selectFrom("messages").selectAll().execute()).toEqual([]);
    expect(await env.db.selectFrom("comms_blocks").selectAll().execute()).toEqual([]);
    expect(await registry.devicesFor("A")).toEqual([]);
    expect(await registry.devicesFor("B")).toHaveLength(1);
    const reports = await env.db.selectFrom("comms_reports").selectAll().execute();
    expect(reports.map((r: any) => [r.reporter_id, r.reported_id, r.reason])).toEqual([["B", null, "x"]]);
  });
});
