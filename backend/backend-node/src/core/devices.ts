/**
 * Devices: the `comms_devices` table, `SqlDeviceRegistry` and the device REST routes
 * (port of commskit.core.devices). `SqlDeviceRegistry` implements `DeviceRegistry` (legacy routes) and
 * `DeviceStore` (used by the push senders).
 */
import type { Generated } from "kysely";
import type { DeviceRegistry } from "./adapters.js";
import { type Db, type Dialect, dbTimestamp, detectDialect } from "./db.js";
import { ddlTypes } from "./ddl.js";
import type { CommsHub, Feature } from "./hub.js";
import { logger } from "./logger.js";
import { HttpError, type RestContext, type RestRoute, ok } from "./rest.js";

export interface DevicesTable {
  id: Generated<number>;
  user_id: string;
  device_id: string;
  platform: string;
  expo_push_token: string | null;
  voip_token: string | null;
  app_version: string | null;
  os_version: string | null;
  model: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  last_seen_at: string | Date;
}

export function devicesDdl(dialect: Dialect): string[] {
  const t = ddlTypes(dialect);
  return [
    `CREATE TABLE IF NOT EXISTS comms_devices (
  id ${t.pk},
  user_id VARCHAR(50) NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  expo_push_token VARCHAR(255),
  voip_token VARCHAR(255),
  app_version VARCHAR(64),
  os_version VARCHAR(64),
  model VARCHAR(128),
  created_at ${t.ts} NOT NULL,
  updated_at ${t.ts} NOT NULL,
  last_seen_at ${t.ts} NOT NULL,
  UNIQUE (device_id)
)`,
    "CREATE INDEX IF NOT EXISTS ix_comms_devices_user_id ON comms_devices (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_devices_expo_push_token ON comms_devices (expo_push_token)",
    "CREATE INDEX IF NOT EXISTS ix_comms_devices_voip_token ON comms_devices (voip_token)",
  ];
}

export const PLATFORMS = ["ios", "android", "web"] as const;
export type TokenKind = "expo" | "voip";

/** Plain view of a device row. */
export interface DeviceInfo {
  user_id: string;
  device_id: string;
  platform: string;
  expo_push_token: string | null;
  voip_token: string | null;
  app_version: string | null;
  os_version: string | null;
  model: string | null;
}

/** What the push senders need from a registry. */
export interface DeviceStore {
  devicesFor(userId: string): Promise<DeviceInfo[]>;
  /** Forget a token the push service reported invalid. Returns rows changed. */
  removeToken(token: string, kind?: TokenKind): Promise<number>;
}

export interface DeviceFields {
  expo_push_token?: unknown;
  voip_token?: unknown;
  app_version?: unknown;
  os_version?: unknown;
  model?: unknown;
}

const clean = (value: unknown, limit: number): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, limit);
  return text || null;
};

const first = (payload: Record<string, any>, ...keys: string[]): any => {
  for (const k of keys) if (payload[k] !== undefined && payload[k] !== null && payload[k] !== "") return payload[k];
  return null;
};

function normalisePlatform(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (["ios", "iphone", "ipad", "ipados"].includes(text)) return "ios";
  if (text === "android") return "android";
  if (text === "web") return "web";
  if (text === "" || text === "unknown") return "unknown"; // legacy registrations that never said
  throw new Error("platform must be one of: ios, android, web");
}

const toInfo = (r: any): DeviceInfo => ({
  user_id: r.user_id,
  device_id: r.device_id,
  platform: r.platform,
  expo_push_token: r.expo_push_token ?? null,
  voip_token: r.voip_token ?? null,
  app_version: r.app_version ?? null,
  os_version: r.os_version ?? null,
  model: r.model ?? null,
});

/** Devices in `comms_devices` (one row per app install, keyed by `device_id`). */
export class SqlDeviceRegistry implements DeviceRegistry, DeviceStore {
  readonly dialect: Dialect;

  constructor(
    private db: Db,
    dialect?: Dialect,
  ) {
    this.dialect = dialect ?? detectDialect(db);
  }

  /**
   * Create or update the device. A device that changes hands moves to `userId` (and drops tokens it did not
   * send again). A token lives on one device only: other rows carrying it lose it. Throws Error on bad input.
   */
  async upsert(userId: string, deviceId: string, platform: string, fields: DeviceFields = {}): Promise<DeviceInfo> {
    const id = clean(deviceId, 255) ?? "";
    if (!id) throw new Error("device_id is required");
    const values: Record<string, string | null> = {
      user_id: String(userId),
      platform: normalisePlatform(platform),
      expo_push_token: clean(fields.expo_push_token, 255),
      voip_token: clean(fields.voip_token, 255),
      app_version: clean(fields.app_version, 64),
      os_version: clean(fields.os_version, 64),
      model: clean(fields.model, 128),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.upsertOnce(id, values);
      } catch (err) {
        // Two requests inserted the same device_id concurrently: the retry updates it.
        if (attempt >= 1 || !/unique|duplicate|constraint/i.test(String((err as Error)?.message))) throw err;
      }
    }
  }

  private async upsertOnce(deviceId: string, values: Record<string, string | null>): Promise<DeviceInfo> {
    const now = dbTimestamp(this.dialect);
    return this.db.transaction().execute(async (trx) => {
      for (const column of ["expo_push_token", "voip_token"] as const) {
        if (values[column]) {
          await trx.updateTable("comms_devices").set({ [column]: null, updated_at: now })
            .where(column, "=", values[column]!).where("device_id", "!=", deviceId).execute();
        }
      }
      const row = await trx.selectFrom("comms_devices").selectAll().where("device_id", "=", deviceId).executeTakeFirst();
      if (!row) {
        await trx.insertInto("comms_devices")
          .values({ device_id: deviceId, ...values, created_at: now, updated_at: now, last_seen_at: now }).execute();
        return toInfo({ device_id: deviceId, ...values });
      }
      const changedHands = row.user_id !== values.user_id;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        // Fields the client did not send keep their value, unless the device changed hands.
        if (v !== null || k === "user_id" || changedHands) patch[k] = v;
      }
      await trx.updateTable("comms_devices").set({ ...patch, updated_at: now, last_seen_at: now })
        .where("device_id", "=", deviceId).execute();
      return toInfo({ ...row, ...patch });
    });
  }

  async delete(userId: string, deviceId: string): Promise<boolean> {
    const r = await this.db.deleteFrom("comms_devices").where("device_id", "=", deviceId).where("user_id", "=", String(userId)).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }

  /** Forget every device of `userId` (account deletion). Returns rows deleted. */
  async deleteUser(userId: string): Promise<number> {
    const r = await this.db.deleteFrom("comms_devices").where("user_id", "=", String(userId)).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  async removeToken(token: string, kind: TokenKind = "expo"): Promise<number> {
    const column = kind === "voip" ? "voip_token" : "expo_push_token";
    const r = await this.db.updateTable("comms_devices").set({ [column]: null, updated_at: dbTimestamp(this.dialect) })
      .where(column, "=", token).executeTakeFirst();
    const n = Number(r.numUpdatedRows);
    if (n) logger.info(`Removed invalid ${kind} push token`);
    return n;
  }

  async devicesFor(userId: string): Promise<DeviceInfo[]> {
    const rows = await this.db.selectFrom("comms_devices").selectAll().where("user_id", "=", String(userId)).orderBy("id").execute();
    return rows.map(toInfo);
  }

  async get(deviceId: string): Promise<DeviceInfo | null> {
    const row = await this.db.selectFrom("comms_devices").selectAll().where("device_id", "=", deviceId).executeTakeFirst();
    return row ? toInfo(row) : null;
  }

  // ------------------------------------------- DeviceRegistry (legacy routes)

  /**
   * Legacy `POST /chats/expo/push/token` body. Accepted keys: `expo_push_token` | `token` | `push_token` |
   * `expoPushToken`, `device_id` | `deviceId`, `platform` | `device_type` | `os`, and the `/devices` fields.
   * Without a device id the token itself identifies the install (`expo:<token>`).
   */
  async register(userId: string, payload: Record<string, any>): Promise<Record<string, unknown>> {
    const token = first(payload, "expo_push_token", "token", "push_token", "expoPushToken");
    const deviceId = first(payload, "device_id", "deviceId");
    if (!deviceId && !token) throw new HttpError(422, "expo_push_token or device_id is required");
    const platform = first(payload, "platform", "device_type", "os") ?? "unknown";
    try {
      await this.upsert(userId, String(deviceId ?? `expo:${token}`), String(platform), {
        expo_push_token: token,
        voip_token: first(payload, "voip_token", "voipToken"),
        app_version: first(payload, "app_version", "appVersion"),
        os_version: first(payload, "os_version", "osVersion"),
        model: first(payload, "model", "device_name", "deviceName"),
      });
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }
    return { status: true, message: "Push token registered" };
  }

  /** Legacy `POST /chats/expo/push/token/remove`: by device id or token (own devices only). */
  async remove(userId: string, payload: Record<string, any>): Promise<Record<string, unknown>> {
    const deviceId = first(payload, "device_id", "deviceId");
    const token = first(payload, "expo_push_token", "token", "push_token", "expoPushToken");
    let removed = false;
    if (deviceId) removed = await this.delete(userId, String(deviceId));
    else if (token) {
      const r = await this.db.deleteFrom("comms_devices").where("expo_push_token", "=", String(token)).where("user_id", "=", String(userId)).executeTakeFirst();
      removed = Number(r.numDeletedRows) > 0;
    } else throw new HttpError(422, "expo_push_token or device_id is required");
    return { status: true, removed };
  }
}

// ------------------------------------------------------------------ REST

function bodyObject(ctx: RestContext): Record<string, any> {
  const b = ctx.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
  }
  return b as Record<string, any>;
}

export function buildDevicesRoutes(registry: SqlDeviceRegistry, legacyRoutes = true): RestRoute[] {
  const routes: RestRoute[] = [
    {
      method: "POST",
      path: "/devices",
      handler: async (ctx) => {
        const p = bodyObject(ctx);
        if (!p.device_id) throw new HttpError(422, "device_id is required");
        if (!(PLATFORMS as readonly string[]).includes(String(p.platform ?? "").toLowerCase())) {
          throw new HttpError(422, "platform must be one of: ios, android, web");
        }
        try {
          await registry.upsert(ctx.userId!, String(p.device_id), String(p.platform), p);
        } catch (err) {
          throw new HttpError(422, (err as Error).message);
        }
        return ok({ status: true });
      },
    },
    {
      method: "DELETE",
      path: "/devices/:deviceId",
      handler: async (ctx) => {
        await registry.delete(ctx.userId!, ctx.params.deviceId!); // idempotent: logging out twice is fine
        return ok({ status: true });
      },
    },
  ];
  if (legacyRoutes) {
    routes.push(
      { method: "POST", path: "/chats/expo/push/token", handler: async (ctx) => ok(await registry.register(ctx.userId!, bodyObject(ctx))) },
      { method: "POST", path: "/chats/expo/push/token/remove", handler: async (ctx) => ok(await registry.remove(ctx.userId!, bodyObject(ctx))) },
    );
  }
  return routes;
}

/**
 * Mounts the device routes on the hub (independent of chat / call). `legacyRoutes` also mounts
 * `/chats/expo/push/token[/remove]`; ChatFeature skips its own copy when this is installed BEFORE it.
 */
export class DevicesFeature implements Feature {
  readonly name = "devices";
  constructor(
    readonly registry: SqlDeviceRegistry,
    private opts: { legacyRoutes?: boolean } = {},
  ) {}

  install(hub: CommsHub): this {
    hub.registerFeature(this.name, this);
    hub.includeRoutes(buildDevicesRoutes(this.registry, this.opts.legacyRoutes ?? true));
    return this;
  }

  /** Account deletion: drop all of the user's devices and tokens. */
  async deleteUserData(userId: string): Promise<{ devices: number }> {
    return { devices: await this.registry.deleteUser(userId) };
  }
}
