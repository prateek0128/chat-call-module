/** Devices: POST /devices, DELETE /devices/:id, legacy /chats/expo/push/token routes, registry behaviour. */
import { afterEach, describe, expect, it } from "vitest";
import { ChatFeature } from "../src/index.js";
import { DevicesFeature, SqlDeviceRegistry } from "../src/core/devices.js";
import { closeAllFeatureEnvs, makeFeatureEnv } from "./moderation-env.js";

afterEach(closeAllFeatureEnvs);

const IOS = {
  device_id: "dev-ios-1", platform: "ios", expo_push_token: "ExponentPushToken[ios1]", voip_token: "voip-ios-1",
  app_version: "1.0.0", os_version: "17.4", model: "iPhone15,2",
};

async function setup(opts: { chat?: boolean; chatDevices?: boolean; devicesFirst?: boolean; legacyRoutes?: boolean } = {}) {
  let registry!: SqlDeviceRegistry;
  const env = await makeFeatureEnv((hub, db) => {
    registry = new SqlDeviceRegistry(db);
    const devices = new DevicesFeature(registry, { legacyRoutes: opts.legacyRoutes });
    const chat = new ChatFeature({ devices: opts.chatDevices ? registry : undefined });
    if (opts.devicesFirst !== false) hub.install(devices);
    if (opts.chat) hub.install(chat);
    if (opts.devicesFirst === false) hub.install(devices);
  });
  return Object.assign(env, { registry });
}

describe("devices REST", () => {
  for (const chat of [false, true]) {
    it(`register, upsert and delete (chat=${chat})`, async () => {
      const env = await setup({ chat });
      const r = await env.post("/devices", "A", IOS);
      expect([r.status, r.json]).toEqual([200, { status: true }]);
      let [dev] = await env.registry.devicesFor("A");
      expect([dev!.platform, dev!.expo_push_token, dev!.voip_token, dev!.model]).toEqual(["ios", "ExponentPushToken[ios1]", "voip-ios-1", "iPhone15,2"]);

      // Upsert by device_id: fields sent are updated, fields omitted are kept.
      expect((await env.post("/devices", "A", { device_id: "dev-ios-1", platform: "ios", app_version: "1.1.0" })).status).toBe(200);
      [dev] = await env.registry.devicesFor("A");
      expect([dev!.app_version, dev!.voip_token]).toEqual(["1.1.0", "voip-ios-1"]);

      // Someone else's DELETE does nothing; the owner's removes it (and is idempotent).
      expect((await env.rest("DELETE", "/devices/dev-ios-1", "B")).json).toEqual({ status: true });
      expect(await env.registry.devicesFor("A")).toHaveLength(1);
      expect((await env.rest("DELETE", "/devices/dev-ios-1", "A")).json).toEqual({ status: true });
      expect(await env.registry.devicesFor("A")).toEqual([]);
      expect((await env.rest("DELETE", "/devices/dev-ios-1", "A")).status).toBe(200);
    });
  }

  it("validation and auth", async () => {
    const env = await setup();
    expect((await env.post("/devices", null, IOS)).status).toBe(401);
    expect((await env.post("/devices", "A", { platform: "ios" })).status).toBe(422);
    expect((await env.post("/devices", "A", { ...IOS, platform: "symbian" })).status).toBe(422);
    expect((await env.post("/devices", "A")).status).toBe(422); // no body
  });

  it("a device changes hands and tokens are unique", async () => {
    const env = await setup();
    await env.post("/devices", "A", IOS);
    // B logs in on the same phone without sending a VoIP token: A's tokens must not follow.
    await env.post("/devices", "B", { device_id: "dev-ios-1", platform: "ios", expo_push_token: "ExponentPushToken[ios1]" });
    expect(await env.registry.devicesFor("A")).toEqual([]);
    const [dev] = await env.registry.devicesFor("B");
    expect([dev!.voip_token, dev!.expo_push_token]).toEqual([null, "ExponentPushToken[ios1]"]);

    // Same Expo token reported by a new install id: the old row loses it.
    await env.post("/devices", "B", { device_id: "dev-ios-2", platform: "ios", expo_push_token: "ExponentPushToken[ios1]" });
    const tokens = Object.fromEntries((await env.registry.devicesFor("B")).map((d) => [d.device_id, d.expo_push_token]));
    expect(tokens).toEqual({ "dev-ios-1": null, "dev-ios-2": "ExponentPushToken[ios1]" });
  });

  it("removeToken by kind", async () => {
    const env = await setup();
    await env.post("/devices", "A", IOS);
    expect(await env.registry.removeToken("voip-ios-1", "voip")).toBe(1);
    let [dev] = await env.registry.devicesFor("A");
    expect([dev!.voip_token, dev!.expo_push_token]).toEqual([null, "ExponentPushToken[ios1]"]);
    expect(await env.registry.removeToken("ExponentPushToken[ios1]")).toBe(1);
    [dev] = await env.registry.devicesFor("A");
    expect(dev!.expo_push_token).toBeNull();
    expect(await env.registry.removeToken("nothing")).toBe(0);
  });

  it("deleteUserData drops the user's devices only", async () => {
    const env = await setup();
    await env.post("/devices", "A", IOS);
    await env.post("/devices", "A", { device_id: "d2", platform: "android" });
    await env.post("/devices", "B", { device_id: "d3", platform: "web" });
    const feature = env.hub.features.devices as DevicesFeature;
    expect(await feature.deleteUserData("A")).toEqual({ devices: 2 });
    expect(await env.registry.devicesFor("A")).toEqual([]);
    expect(await env.registry.devicesFor("B")).toHaveLength(1);
  });
});

describe("legacy routes", () => {
  for (const chat of [false, true]) {
    it(`map onto the registry (chat=${chat})`, async () => {
      const env = await setup({ chat });
      const r = await env.post("/chats/expo/push/token", "A", { expo_push_token: "ExponentPushToken[legacy]", device_type: "Android" });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe(true);
      let [dev] = await env.registry.devicesFor("A");
      expect([dev!.device_id, dev!.platform]).toEqual(["expo:ExponentPushToken[legacy]", "android"]);

      const rm = await env.post("/chats/expo/push/token/remove", "A", { expo_push_token: "ExponentPushToken[legacy]" });
      expect([rm.status, rm.json]).toEqual([200, { status: true, removed: true }]);
      expect(await env.registry.devicesFor("A")).toEqual([]);
      expect((await env.post("/chats/expo/push/token/remove", "A", {})).status).toBe(422);
      expect((await env.post("/chats/expo/push/token", "A", {})).status).toBe(422);

      // Key aliases; a device id without a platform is stored as "unknown".
      await env.post("/chats/expo/push/token", "A", { token: "ExponentPushToken[x]", deviceId: "d1" });
      [dev] = await env.registry.devicesFor("A");
      expect([dev!.device_id, dev!.platform, dev!.expo_push_token]).toEqual(["d1", "unknown", "ExponentPushToken[x]"]);
      await env.post("/chats/expo/push/token/remove", "A", { device_id: "d1" });
      expect(await env.registry.devicesFor("A")).toEqual([]);
    });
  }

  it("legacyRoutes: false leaves them out", async () => {
    const env = await setup({ legacyRoutes: false });
    expect((await env.post("/chats/expo/push/token", "A", { expo_push_token: "t" })).status).toBe(404);
    expect((await env.post("/devices", "A", IOS)).status).toBe(200);
  });

  it("ChatFeature({devices}) alone mounts its own legacy routes; with DevicesFeature installed first it skips them", async () => {
    let registry!: SqlDeviceRegistry;
    const solo = await makeFeatureEnv((hub, db) => {
      registry = new SqlDeviceRegistry(db);
      hub.install(new ChatFeature({ devices: registry }));
    });
    expect((await solo.post("/chats/expo/push/token", "A", { expo_push_token: "ExponentPushToken[c]" })).status).toBe(200);
    expect((await registry.devicesFor("A"))[0]!.expo_push_token).toBe("ExponentPushToken[c]");
    expect((await solo.post("/devices", "A", IOS)).status).toBe(404); // /devices is DevicesFeature's

    const both = await setup({ chat: true, chatDevices: true });
    const routes = both.hub.restRoutes().filter((r) => r.path === "/chats/expo/push/token");
    expect(routes).toHaveLength(1);
  });

  it("known limitation: DevicesFeature installed AFTER ChatFeature({devices}) mounts the legacy routes twice (first wins)", async () => {
    const env = await setup({ chat: true, chatDevices: true, devicesFirst: false });
    expect(env.hub.restRoutes().filter((r) => r.path === "/chats/expo/push/token")).toHaveLength(2);
    expect((await env.post("/chats/expo/push/token", "A", { expo_push_token: "t1" })).status).toBe(200);
  });
});
