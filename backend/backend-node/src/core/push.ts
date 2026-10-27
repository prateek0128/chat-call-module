/**
 * Push senders: Expo, APNs VoIP (PushKit) and a per-device router (PROTOCOL.md section 8).
 * Port of commskit.core.push. Uses the global `fetch` (Expo) and `node:http2` + `jose` (APNs); both are injectable
 * so tests never touch the network.
 *
 *   const push = new DevicePushRouter({ registry, expo: new ExpoPushSender({ accessToken }), voip: ApnsVoipSender.fromEnv(), androidCallStyle: "data" });
 *   new CommsHub({ ..., push });
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import type { PushSender } from "./adapters.js";
import type { DeviceInfo, DeviceStore } from "./devices.js";
import { logger } from "./logger.js";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const APNS_PRODUCTION_HOST = "https://api.push.apple.com";
export const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";
const INCOMING_CALL = "incoming_call";

// ------------------------------------------------------------------ callkit

const NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

/** CallKit UUID for a call id: UUIDv5(NAMESPACE_URL, `commskit:call:<callId>`). Shared with the mobile kit. */
export function callkitUuid(callId: string): string {
  const h = createHash("sha1").update(NAMESPACE_URL).update(`commskit:call:${callId}`, "utf8").digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ---------------------------------------------------------------------- Expo

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ExpoTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string; expoPushToken?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export type ExpoMessage = Record<string, any>;

export interface ExpoPushSenderOptions {
  registry?: DeviceStore | null;
  accessToken?: string | null;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  url?: string;
  batchSize?: number;
  /** Seconds. */
  timeout?: number;
  sound?: string | null;
  receiptsUrl?: string;
  receiptBatchSize?: number;
  maxPendingTickets?: number;
  /** Seconds. */
  receiptTtl?: number;
}

export interface BuildMessageOptions {
  channel?: string | null;
  ttl?: number | null;
  priority?: "default" | "normal" | "high";
  /** `false` (default) = the sender's default sound. */
  sound?: string | null | false;
  dataOnly?: boolean;
}

/**
 * Expo push client; also a `PushSender` on its own (needs `registry`). `DeviceNotRegistered` tickets remove that
 * token; accepted ticket ids are remembered (up to `maxPendingTickets`, `receiptTtl`) and `pollReceipts()`
 * checks them later (`startReceiptPoller(900)` runs it in the background).
 */
export class ExpoPushSender implements PushSender {
  registry: DeviceStore | null;
  accessToken: string | null;
  url: string;
  batchSize: number;
  timeout: number;
  sound: string | null;
  receiptsUrl: string;
  receiptBatchSize: number;
  maxPendingTickets: number;
  receiptTtl: number;
  private fetchImpl?: FetchLike;
  private tickets = new Map<string, [string, number]>(); // ticket id -> [token, sent at (ms)]
  private poller: NodeJS.Timeout | null = null;

  constructor(opts: ExpoPushSenderOptions = {}) {
    const batchSize = opts.batchSize ?? 100;
    const receiptBatchSize = opts.receiptBatchSize ?? 1000;
    if (!(batchSize >= 1 && batchSize <= 100)) throw new Error("Expo accepts at most 100 messages per request");
    if (!(receiptBatchSize >= 1 && receiptBatchSize <= 1000)) throw new Error("Expo accepts at most 1000 receipt ids per request");
    this.registry = opts.registry ?? null;
    this.accessToken = opts.accessToken ?? null;
    this.fetchImpl = opts.fetch;
    this.url = opts.url ?? EXPO_PUSH_URL;
    this.batchSize = batchSize;
    this.timeout = opts.timeout ?? 10;
    this.sound = opts.sound === undefined ? "default" : opts.sound;
    this.receiptsUrl = opts.receiptsUrl ?? EXPO_RECEIPTS_URL;
    this.receiptBatchSize = receiptBatchSize;
    this.maxPendingTickets = opts.maxPendingTickets ?? 50_000;
    this.receiptTtl = opts.receiptTtl ?? 24 * 3600;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  private async post(url: string, payload: unknown): Promise<{ status: number; body: any }> {
    const f: FetchLike = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
    const text = await res.text();
    let body: any = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return { status: res.status, body };
  }

  /** Nothing to release by default (global fetch); stops the receipt poller. */
  async aclose(): Promise<void> {
    this.stopReceiptPoller();
  }

  /** One Expo message. `dataOnly` omits title/body/sound: Android hands it to the app instead of displaying it. */
  buildMessage(token: string, title: string | null, body: string | null, data: Record<string, unknown>, opts: BuildMessageOptions = {}): ExpoMessage {
    const { channel = "default", ttl = null, priority = "high", sound = false, dataOnly = false } = opts;
    const message: ExpoMessage = { to: token, data: { ...data }, priority };
    if (!dataOnly) {
      message.title = title;
      message.body = body;
      const chosen = sound === false ? this.sound : sound;
      if (chosen) message.sound = chosen;
    } else {
      message._contentAvailable = true;
    }
    if (channel) message.channelId = channel;
    if (ttl !== null && ttl !== undefined) message.ttl = Math.trunc(ttl);
    return message;
  }

  /** POST in batches of `batchSize`. One ticket per message, in order; a failed batch yields error tickets. */
  async sendMessages(messages: readonly ExpoMessage[]): Promise<ExpoTicket[]> {
    const tickets: ExpoTicket[] = [];
    for (let start = 0; start < messages.length; start += this.batchSize) {
      const batch = messages.slice(start, start + this.batchSize).map((m) => ({ ...m }));
      let batchTickets: ExpoTicket[];
      try {
        const { status, body } = await this.post(this.url, batch);
        if (status >= 400 || body?.errors) logger.warn(`Expo push batch failed (${status})`, body?.errors ?? body);
        const data = body && typeof body === "object" ? body.data : null;
        if (Array.isArray(data) && data.length === batch.length) {
          batchTickets = data.map((t) => (t && typeof t === "object" ? t : {}));
        } else {
          batchTickets = batch.map(() => ({ status: "error", message: `HTTP ${status}` }));
        }
      } catch (err) {
        logger.error("Expo push request failed", err);
        batchTickets = batch.map(() => ({ status: "error", message: String((err as Error)?.message ?? err) }));
      }
      await this.handleTickets(batch, batchTickets);
      this.rememberTickets(batch, batchTickets);
      tickets.push(...batchTickets);
    }
    return tickets;
  }

  private async dropToken(token: unknown): Promise<void> {
    if (!token || !this.registry) return;
    try {
      await this.registry.removeToken(String(token), "expo");
    } catch (err) {
      logger.error("Removing an unregistered Expo token failed", err);
    }
  }

  private async handleTickets(batch: readonly ExpoMessage[], tickets: readonly ExpoTicket[]): Promise<void> {
    for (let i = 0; i < batch.length; i++) {
      const ticket = tickets[i]!;
      if (ticket.status !== "error") continue;
      const details = ticket.details ?? {};
      if (details.error === "DeviceNotRegistered") await this.dropToken(details.expoPushToken || batch[i]!.to);
      else logger.warn("Expo push error", ticket.message ?? details);
    }
  }

  private rememberTickets(batch: readonly ExpoMessage[], tickets: readonly ExpoTicket[]): void {
    const now = Date.now();
    for (let i = 0; i < batch.length; i++) {
      const t = tickets[i]!;
      if (t.status === "ok" && t.id && batch[i]!.to) {
        this.tickets.delete(String(t.id));
        this.tickets.set(String(t.id), [String(batch[i]!.to), now]);
      }
    }
    while (this.tickets.size > this.maxPendingTickets) this.tickets.delete(this.tickets.keys().next().value as string);
  }

  /** `{ticketId: expoPushToken}` still waiting for a receipt. */
  get pendingTickets(): Record<string, string> {
    return Object.fromEntries([...this.tickets].map(([id, [token]]) => [id, token]));
  }

  /**
   * Fetch receipts for the remembered tickets (`getReceipts`, at most `receiptBatchSize` ids per request).
   * `DeviceNotRegistered` removes the token. Tickets with a receipt are forgotten; others stay pending until
   * `receiptTtl`. Returns `{checked, ok, errors, unregistered, pending}`.
   */
  async pollReceipts(): Promise<{ checked: number; ok: number; errors: number; unregistered: number; pending: number }> {
    const now = Date.now();
    for (const [id, [, at]] of [...this.tickets]) if (now - at > this.receiptTtl * 1000) this.tickets.delete(id);
    const ids = [...this.tickets.keys()];
    const summary = { checked: ids.length, ok: 0, errors: 0, unregistered: 0, pending: 0 };
    if (!ids.length) return summary;
    const receipts: Record<string, any> = {};
    for (let start = 0; start < ids.length; start += this.receiptBatchSize) {
      const chunk = ids.slice(start, start + this.receiptBatchSize);
      try {
        const { status, body } = await this.post(this.receiptsUrl, { ids: chunk });
        const data = body && typeof body === "object" ? body.data : null;
        if (status >= 400 || !data || typeof data !== "object" || Array.isArray(data)) {
          logger.warn(`Expo getReceipts failed (${status})`, body?.errors ?? body);
          continue;
        }
        Object.assign(receipts, data);
      } catch (err) {
        logger.error("Expo getReceipts request failed", err);
      }
    }
    for (const id of ids) {
      const receipt = receipts[id];
      if (!receipt || typeof receipt !== "object") {
        summary.pending += 1;
        continue;
      }
      let token: unknown = this.tickets.get(id)?.[0] ?? "";
      this.tickets.delete(id);
      if (receipt.status === "ok") {
        summary.ok += 1;
        continue;
      }
      summary.errors += 1;
      const details = receipt.details ?? {};
      if (details.error === "DeviceNotRegistered") {
        summary.unregistered += 1;
        token = details.expoPushToken || token;
        await this.dropToken(token);
      } else logger.warn("Expo receipt error", receipt.message ?? details);
    }
    return summary;
  }

  /** Poll receipts every `intervalSeconds` in the background. `stopReceiptPoller()` / `aclose()` stop it. */
  startReceiptPoller(intervalSeconds = 900): NodeJS.Timeout {
    if (this.poller) return this.poller;
    this.poller = setInterval(() => {
      this.pollReceipts().catch((err) => logger.error("Expo receipt polling failed", err));
    }, intervalSeconds * 1000);
    this.poller.unref();
    return this.poller;
  }

  stopReceiptPoller(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** `PushSender`: visible notification to every Expo token of `userId`. */
  async send(userId: string, title: string, body: string, data: Record<string, unknown>, channel = "default", ttl: number | null = null): Promise<void> {
    if (!this.registry) throw new Error("ExpoPushSender.send needs a registry (or use DevicePushRouter)");
    const tokens = (await this.registry.devicesFor(userId)).map((d) => d.expo_push_token).filter((t): t is string => !!t);
    if (tokens.length) await this.sendMessages(tokens.map((t) => this.buildMessage(t, title, body, data, { channel, ttl })));
  }
}

// ------------------------------------------------------------- APNs (VoIP)

export interface ApnsResponse {
  status: number;
  body: string;
}

/** One HTTP/2 connection to APNs (injectable for tests). */
export interface ApnsSession {
  request(path: string, headers: Record<string, string>, body: string): Promise<ApnsResponse>;
  close(): void | Promise<void>;
}
export type ApnsSessionFactory = (origin: string) => ApnsSession;

/** Default: a lazily connected, reconnecting `node:http2` session. */
export function defaultApnsSessionFactory(timeoutSeconds = 10): ApnsSessionFactory {
  return (origin) => {
    let session: http2.ClientHttp2Session | null = null;
    const connect = (): http2.ClientHttp2Session => {
      if (session && !session.closed && !session.destroyed) return session;
      const s = http2.connect(origin);
      s.on("error", () => {
        if (session === s) session = null;
      });
      s.on("close", () => {
        if (session === s) session = null;
      });
      s.unref();
      session = s;
      return s;
    };
    return {
      request(path, headers, body) {
        return new Promise<ApnsResponse>((resolve, reject) => {
          let settled = false;
          const done = (fn: () => void) => {
            if (!settled) {
              settled = true;
              fn();
            }
          };
          try {
            const req = connect().request({ ":method": "POST", ":path": path, ...headers });
            let status = 0;
            const chunks: Buffer[] = [];
            req.setTimeout(timeoutSeconds * 1000, () => {
              req.close(http2.constants.NGHTTP2_CANCEL);
              done(() => reject(new Error("APNs request timed out")));
            });
            req.on("response", (h) => {
              status = Number(h[":status"] ?? 0);
            });
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => done(() => resolve({ status, body: Buffer.concat(chunks).toString("utf8") })));
            req.on("error", (e) => done(() => reject(e)));
            req.end(body);
          } catch (err) {
            done(() => reject(err));
          }
        });
      },
      close() {
        session?.close();
        session = null;
      },
    };
  };
}

export interface ApnsVoipSenderOptions {
  /** PEM text of the .p8 key. */
  key?: string;
  keyPath?: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  useSandbox?: boolean;
  registry?: DeviceStore | null;
  /** Seconds a push may wait at APNs (apns-expiration = now + this). */
  expiration?: number;
  /** Seconds before the provider JWT is re-signed (< 3600, as Apple requires). */
  tokenRefresh?: number;
  sessionFactory?: ApnsSessionFactory;
  /** Seconds. */
  timeout?: number;
}

/**
 * iOS PushKit (VoIP) pushes over HTTP/2 with token-based (.p8) auth. Headers: `apns-push-type: voip`,
 * `apns-topic: <bundle>.voip`, `apns-priority: 10`, `apns-expiration: now + expiration`. The provider JWT (ES256,
 * kid = key id, iss = team id) is cached and refreshed every `tokenRefresh` seconds. 410 / BadDeviceToken /
 * Unregistered remove the token; ExpiredProviderToken re-signs once and retries.
 */
export class ApnsVoipSender {
  static readonly INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly topic: string;
  readonly host: string;
  registry: DeviceStore | null;
  expiration: number;
  tokenRefresh: number;
  /** Epoch seconds the cached JWT was signed (tests age it). */
  jwtIssuedAt = 0;
  private pem: string;
  private jwt: string | null = null;
  private session: ApnsSession | null = null;
  private sessionFactory: ApnsSessionFactory;

  constructor(opts: ApnsVoipSenderOptions) {
    if (!(opts.key || opts.keyPath)) throw new Error("ApnsVoipSender needs key (PEM text of the .p8) or keyPath");
    if (!(opts.keyId && opts.teamId && opts.bundleId)) throw new Error("ApnsVoipSender needs keyId, teamId and bundleId");
    const refresh = opts.tokenRefresh ?? 50 * 60;
    if (!(refresh > 0 && refresh < 3600)) throw new Error("tokenRefresh must be under 60 minutes");
    this.pem = opts.key ?? readFileSync(opts.keyPath!, "utf8");
    this.keyId = opts.keyId;
    this.teamId = opts.teamId;
    this.bundleId = opts.bundleId;
    this.topic = opts.bundleId.endsWith(".voip") ? opts.bundleId : `${opts.bundleId}.voip`;
    this.host = opts.useSandbox ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
    this.registry = opts.registry ?? null;
    this.expiration = opts.expiration ?? 45;
    this.tokenRefresh = refresh;
    this.sessionFactory = opts.sessionFactory ?? defaultApnsSessionFactory(opts.timeout ?? 10);
  }

  /** From APNS_KEY / APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_USE_SANDBOX. Null when not configured. */
  static fromEnv(registry: DeviceStore | null = null, overrides: Partial<ApnsVoipSenderOptions> = {}, env: NodeJS.ProcessEnv = process.env): ApnsVoipSender | null {
    const key = env.APNS_KEY;
    const keyPath = env.APNS_KEY_PATH;
    const keyId = env.APNS_KEY_ID;
    const teamId = env.APNS_TEAM_ID;
    const bundleId = env.APNS_BUNDLE_ID;
    if (!((key || keyPath) && keyId && teamId && bundleId)) return null;
    const sandbox = ["1", "true", "yes"].includes((env.APNS_USE_SANDBOX ?? "").trim().toLowerCase());
    return new ApnsVoipSender({
      key: key ? key.replace(/\\n/g, "\n") : undefined,
      keyPath,
      keyId,
      teamId,
      bundleId,
      useSandbox: sandbox,
      registry,
      ...overrides,
    });
  }

  private getSession(): ApnsSession {
    if (!this.session) this.session = this.sessionFactory(this.host);
    return this.session;
  }

  async aclose(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  /** Cached ES256 provider JWT; re-signed after `tokenRefresh` seconds. */
  async providerToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.jwt === null || now - this.jwtIssuedAt >= this.tokenRefresh) {
      const issued = Math.floor(now);
      const key = await importPKCS8(this.pem, "ES256");
      this.jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: this.keyId, typ: "JWT" })
        .setIssuer(this.teamId)
        .setIssuedAt(issued)
        .sign(key);
      this.jwtIssuedAt = issued;
    }
    return this.jwt;
  }

  async headers(): Promise<Record<string, string>> {
    return {
      authorization: `bearer ${await this.providerToken()}`,
      "apns-push-type": "voip",
      "apns-topic": this.topic,
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + Math.trunc(this.expiration)),
      "content-type": "application/json",
    };
  }

  /** POST /3/device/<token>. True when APNs accepted it. */
  async sendVoip(token: string, payload: Record<string, unknown>): Promise<boolean> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: ApnsResponse;
      try {
        res = await this.getSession().request(`/3/device/${token}`, await this.headers(), body);
      } catch (err) {
        logger.error("APNs request failed", err);
        return false;
      }
      if (res.status === 200) return true;
      let reason = "";
      try {
        reason = String(JSON.parse(res.body || "{}")?.reason ?? "");
      } catch {
        /* not JSON */
      }
      if (res.status === 403 && reason === "ExpiredProviderToken" && attempt === 0) {
        this.jwt = null; // clock skew or a long-lived process: re-sign once and retry
        continue;
      }
      if (res.status === 410 || ApnsVoipSender.INVALID_TOKEN_REASONS.has(reason)) {
        if (this.registry) {
          try {
            await this.registry.removeToken(token, "voip");
          } catch (err) {
            logger.error("Removing an invalid VoIP token failed", err);
          }
        }
      } else logger.warn(`APNs VoIP push failed: ${res.status} ${reason}`);
      return false;
    }
    return false;
  }
}

// ------------------------------------------------------------------ router

export interface DevicePushRouterOptions {
  registry: DeviceStore;
  expo?: ExpoPushSender;
  voip?: ApnsVoipSender | null;
  androidCallStyle?: "notification" | "data";
}

/**
 * `PushSender` that picks the transport per device (PROTOCOL.md section 8).
 * - `data.type === "incoming_call"`: iOS device with a voip token and a `voip` sender -> APNs VoIP with
 *   `uuid = callkitUuid(call_id)` (if APNs refuses and the device has an Expo token: visible Expo instead);
 *   Android + `androidCallStyle "data"` -> Expo data-only; anything else with an Expo token -> visible Expo, priority high.
 * - everything else (chat, missed call, host pushes) -> visible Expo notification.
 */
export class DevicePushRouter implements PushSender {
  readonly registry: DeviceStore;
  readonly expo: ExpoPushSender;
  readonly voip: ApnsVoipSender | null;
  readonly androidCallStyle: "notification" | "data";

  constructor(opts: DevicePushRouterOptions) {
    const style = opts.androidCallStyle ?? "notification";
    if (style !== "notification" && style !== "data") throw new Error("androidCallStyle must be 'notification' or 'data'");
    this.registry = opts.registry;
    this.expo = opts.expo ?? new ExpoPushSender({ registry: opts.registry });
    this.voip = opts.voip ?? null;
    this.androidCallStyle = style;
    if (!this.expo.registry) this.expo.registry = opts.registry;
    if (this.voip && !this.voip.registry) this.voip.registry = opts.registry;
  }

  async aclose(): Promise<void> {
    await this.expo.aclose();
    if (this.voip) await this.voip.aclose();
  }

  async send(userId: string, title: string, body: string, data: Record<string, unknown>, channel = "default", ttl: number | null = null): Promise<void> {
    const devices = await this.registry.devicesFor(userId);
    if (!devices.length) return;
    const isCall = data.type === INCOMING_CALL;
    const expoMessages: ExpoMessage[] = [];
    const voipJobs: Array<[DeviceInfo, Record<string, unknown>]> = [];
    const visible = (d: DeviceInfo): ExpoMessage =>
      this.expo.buildMessage(d.expo_push_token!, title, body, data, { channel, ttl, priority: "high" });

    for (const device of devices) {
      if (!isCall) {
        if (device.expo_push_token) expoMessages.push(visible(device));
        continue;
      }
      if (device.platform === "ios" && device.voip_token && this.voip) {
        const payload = { ...data };
        if (data.call_id) payload.uuid = callkitUuid(String(data.call_id));
        voipJobs.push([device, payload]);
      } else if (!device.expo_push_token) {
        continue;
      } else if (device.platform === "android" && this.androidCallStyle === "data") {
        expoMessages.push(this.expo.buildMessage(device.expo_push_token, null, null, data, { channel, ttl, priority: "high", dataOnly: true }));
      } else {
        expoMessages.push(visible(device));
      }
    }

    if (voipJobs.length) {
      const results = await Promise.allSettled(voipJobs.map(([d, p]) => this.voip!.sendVoip(d.voip_token!, p)));
      voipJobs.forEach(([device], i) => {
        const r = results[i]!;
        if (!(r.status === "fulfilled" && r.value === true) && device.expo_push_token) expoMessages.push(visible(device));
      });
    }
    if (expoMessages.length) await this.expo.sendMessages(expoMessages);
  }
}
