/**
 * Sockets per user, presence, rooms and fan-out (port of commskit.core.connections).
 *
 * In-memory by default (single worker). A `PresenceBridge` (Redis) makes it multi-worker.
 * Only "user" role connections take part in presence and `user.came_online`; other roles (see the
 * hub's `roleResolver`) get frames and rooms only.
 */
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import { LRU, TaskSet, formatIso, utcnow } from "./util.js";

export const USER_ROLE = "user";

/** The minimal socket surface the kit needs (a `ws` WebSocket satisfies it). */
export interface SocketLike {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export type OfflineHook = (userId: string) => Promise<void> | void;
export type PartnersLookup = (userId: string) => Promise<Iterable<string>>;
export type Deliver = (userId: string, envelope: any) => Promise<void>;

/**
 * Cross-worker presence + delivery. `RedisBridge` implements this.
 * Optional members: setRoomDeliver(fn), publishRoom(room, payload, origin),
 * claimCameOnline(userId, ttlSeconds) -> boolean, releaseCameOnline(userId).
 */
export interface PresenceBridge {
  heartbeatSeconds: number;
  start(deliver: Deliver, serverId: string): Promise<void>;
  stop(): Promise<void>;
  setOnline(userId: string, serverId: string): Promise<void>;
  setOffline(userId: string, serverId: string): Promise<void>;
  setAway(userId: string, away: boolean): Promise<void>;
  getUserServers(userId: string): Promise<string[]>;
  isOnline(userId: string): Promise<boolean>;
  getOnlineUsers(userIds: string[]): Promise<Set<string>>;
  publish(userId: string, payload: unknown, origin: string): Promise<void>;
  setRoomDeliver?(fn: (room: string, envelope: any) => Promise<void>): void;
  publishRoom?(room: string, payload: unknown, origin: string): Promise<void>;
  claimCameOnline?(userId: string, ttlSeconds: number): Promise<boolean>;
  releaseCameOnline?(userId: string): Promise<void>;
}

export interface UserConnection {
  userId: string;
  status: string; // "online" (foreground) or anything else (= away)
  lastSeen: Date;
}

const OPEN = 1;

function sendText(ws: SocketLike, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== OPEN) return reject(new Error("socket not open"));
    try {
      ws.send(text, (err) => (err ? reject(err) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}

export class ConnectionManager {
  bridge: PresenceBridge | null;
  serverId: string;
  /** A user may hold several sockets (devices / screens); all get every frame. */
  userSockets = new Map<string, Set<SocketLike>>();
  activeConnections = new Map<string, UserConnection>();
  roles = new Map<string, string>();
  rooms = new Map<string, Set<string>>();
  private userRooms = new Map<string, Set<string>>();
  /** user.came_online: 0 = only dedupe concurrent connects; > 0 = at most once per cooldown (seconds). */
  cameOnlineCooldown: number;
  cameOnlineDedupeSeconds: number;
  private cameOnlineAt = new LRU<string, number>(100_000);
  private offlineHooks: Array<[OfflineHook, boolean]> = [];
  private partnersLookup: PartnersLookup | null = null;
  private tasks = new TaskSet();

  constructor(
    opts: {
      bridge?: PresenceBridge | null;
      serverId?: string;
      cameOnlineCooldown?: number;
      cameOnlineDedupeSeconds?: number;
    } = {},
  ) {
    this.bridge = opts.bridge ?? null;
    this.serverId = opts.serverId ?? `${process.env.HOSTNAME ?? "server"}-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.cameOnlineCooldown = opts.cameOnlineCooldown ?? 0;
    this.cameOnlineDedupeSeconds = opts.cameOnlineDedupeSeconds ?? 10;
  }

  // ----------------------------------------------------------- lifecycle

  /** Start the bridge consumer (call at app start). */
  async start(): Promise<void> {
    if (this.bridge) {
      this.bridge.setRoomDeliver?.((room, env) => this.deliverRoomFromBridge(room, env));
      await this.bridge.start((uid, env) => this.deliverFromBridge(uid, env), this.serverId);
    }
  }

  async stop(): Promise<void> {
    await this.tasks.settle();
    if (this.bridge) await this.bridge.stop();
  }

  /** `hook(userId)` runs when the user's last socket on this worker closes (users only unless `allRoles`). */
  addOfflineHook(hook: OfflineHook, allRoles = false): void {
    this.offlineHooks.push([hook, allRoles]);
  }

  /** Who should receive this user's `user_status` (chat installs this). */
  setPartnersLookup(lookup: PartnersLookup | null): void {
    this.partnersLookup = lookup;
  }

  roleOf(userId: string): string {
    return this.roles.get(userId) ?? USER_ROLE;
  }

  // ---------------------------------------------------------- connections

  /**
   * Register an already-accepted socket. Returns true when this connect is the user's
   * offline -> online transition across all workers; always false for non-user roles.
   */
  async register(userId: string, ws: SocketLike, role: string = USER_ROLE): Promise<boolean> {
    const firstSocket = !this.userSockets.get(userId)?.size;
    let set = this.userSockets.get(userId);
    if (!set) this.userSockets.set(userId, (set = new Set()));
    set.add(ws);
    this.roles.set(userId, role);
    this.activeConnections.set(userId, { userId, status: "online", lastSeen: utcnow() });
    let cameOnline = false;
    if (firstSocket && role === USER_ROLE) cameOnline = await this.claimCameOnline(userId);
    if (this.bridge) {
      await this.bridge.setOnline(userId, this.serverId);
      await this.bridge.setAway(userId, false);
    }
    if (firstSocket) await this.broadcastUserStatus(userId, "online");
    return cameOnline;
  }

  private async claimCameOnline(userId: string): Promise<boolean> {
    if (this.bridge) {
      let others: string[] = [];
      try {
        others = (await this.bridge.getUserServers(userId)).filter((s) => s !== this.serverId);
      } catch {
        others = [];
      }
      if (others.length) return false; // already online on another worker
      if (this.bridge.claimCameOnline) {
        const ttl = this.cameOnlineCooldown || this.cameOnlineDedupeSeconds;
        try {
          return Boolean(await this.bridge.claimCameOnline(userId, ttl));
        } catch (err) {
          logger.error(`claimCameOnline(${userId}) failed`, err);
        }
      }
    }
    if (this.cameOnlineCooldown > 0) {
      const now = performance.now() / 1000;
      const last = this.cameOnlineAt.get(userId);
      if (last !== undefined && now - last < this.cameOnlineCooldown) return false;
      this.cameOnlineAt.put(userId, now);
    }
    return true;
  }

  async heartbeat(userId: string): Promise<void> {
    if (this.bridge && this.userSockets.get(userId)?.size) await this.bridge.setOnline(userId, this.serverId);
  }

  /** Remove one socket (or all). The user stays online while any socket remains. Idempotent. */
  disconnect(userId: string, ws?: SocketLike): void {
    const sockets = this.userSockets.get(userId);
    if (sockets && ws) {
      sockets.delete(ws);
      if (sockets.size) return;
    }
    this.userSockets.delete(userId);
    const role = this.roles.get(userId) ?? USER_ROLE;
    this.roles.delete(userId);
    for (const room of this.userRooms.get(userId) ?? []) {
      const members = this.rooms.get(room);
      if (members) {
        members.delete(userId);
        if (!members.size) this.rooms.delete(room);
      }
    }
    this.userRooms.delete(userId);
    if (!this.activeConnections.delete(userId)) return;
    this.tasks.spawn(() => this.wentOffline(userId, role));
    for (const [hook, allRoles] of this.offlineHooks) {
      if (role === USER_ROLE || allRoles) this.tasks.spawn(async () => hook(userId));
    }
  }

  private async wentOffline(userId: string, role: string): Promise<void> {
    // Reconnected here before this ran: don't wipe presence or announce offline.
    if (this.userSockets.get(userId)?.size) return;
    if (this.bridge) await this.bridge.setOffline(userId, this.serverId);
    if (await this.isConnected(userId)) return; // still connected on another worker
    if (role !== USER_ROLE) return;
    if (this.bridge?.releaseCameOnline && !this.cameOnlineCooldown) {
      try {
        await this.bridge.releaseCameOnline(userId);
      } catch (err) {
        logger.error(`releaseCameOnline(${userId}) failed`, err);
      }
    }
    await this.broadcastStatus(userId, "offline");
  }

  /** Client-reported foreground ("online") / background (anything else). */
  async setStatus(userId: string, status: string): Promise<void> {
    const now = utcnow();
    const conn = this.activeConnections.get(userId);
    if (conn) {
      conn.status = status;
      conn.lastSeen = now;
    }
    if (this.bridge) await this.bridge.setAway(userId, status !== "online");
    await this.broadcastUserStatus(userId, status, now);
  }

  // ------------------------------------------------------------- presence

  /** Local only: foreground socket on this worker. */
  isUserOnline(userId: string): boolean {
    return this.activeConnections.get(userId)?.status === "online";
  }

  /** Cluster-wide: connected somewhere with the app in the foreground. */
  async isOnline(userId: string): Promise<boolean> {
    if (this.isUserOnline(userId)) return true;
    return this.bridge ? this.bridge.isOnline(userId) : false;
  }

  /** Cluster-wide: any open socket (foreground or background). */
  async isConnected(userId: string): Promise<boolean> {
    if (this.userSockets.get(userId)?.size) return true;
    return this.bridge ? (await this.bridge.getUserServers(userId)).length > 0 : false;
  }

  async getOnlineUsers(userIds: string[]): Promise<Set<string>> {
    const local = new Set(userIds.filter((u) => this.isUserOnline(u)));
    if (!this.bridge) return local;
    const remote = await this.bridge.getOnlineUsers(userIds.filter((u) => !local.has(u)));
    return new Set([...local, ...remote]);
  }

  // ------------------------------------------------------------- delivery

  private async sendLocal(userId: string, text: string): Promise<boolean> {
    let delivered = false;
    const dead: SocketLike[] = [];
    for (const ws of [...(this.userSockets.get(userId) ?? [])]) {
      try {
        await sendText(ws, text);
        delivered = true;
      } catch (err) {
        logger.warn(`Send to ${userId} failed: ${(err as Error).message}`);
        dead.push(ws);
      }
    }
    for (const ws of dead) this.disconnect(userId, ws);
    return delivered;
  }

  /** Deliver to every socket of the user on any worker. True if at least one got it. */
  async send(userId: string, payload: unknown): Promise<boolean> {
    let delivered = await this.sendLocal(userId, JSON.stringify(payload));
    if (this.bridge) {
      const remote = (await this.bridge.getUserServers(userId)).filter((s) => s !== this.serverId);
      if (remote.length) {
        await this.bridge.publish(userId, payload, this.serverId);
        delivered = true;
      }
    }
    return delivered;
  }

  async sendToSocket(ws: SocketLike, payload: unknown): Promise<void> {
    await sendText(ws, JSON.stringify(payload));
  }

  /** Every socket on this worker (e.g. host community events). */
  async broadcast(payload: unknown): Promise<void> {
    const text = JSON.stringify(payload);
    for (const userId of [...this.userSockets.keys()]) await this.sendLocal(userId, text);
  }

  private async deliverFromBridge(userId: string, envelope: any): Promise<void> {
    if (envelope && "origin" in envelope && "data" in envelope) {
      if (envelope.origin === this.serverId) return; // we published it and already delivered locally
      envelope = envelope.data;
    }
    await this.sendLocal(userId, JSON.stringify(envelope));
  }

  // ---------------------------------------------------------------- rooms

  /** Add the user's sockets on this worker to `room` (left automatically on disconnect). False when none. */
  joinRoom(userId: string, room: string): boolean {
    if (!this.userSockets.get(userId)?.size) return false;
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(userId);
    if (!this.userRooms.has(userId)) this.userRooms.set(userId, new Set());
    this.userRooms.get(userId)!.add(room);
    return true;
  }

  leaveRoom(userId: string, room: string): void {
    const members = this.rooms.get(room);
    if (members) {
      members.delete(userId);
      if (!members.size) this.rooms.delete(room);
    }
    const rooms = this.userRooms.get(userId);
    if (rooms) {
      rooms.delete(room);
      if (!rooms.size) this.userRooms.delete(userId);
    }
  }

  /** Members on this worker. */
  roomMembers(room: string): Set<string> {
    return new Set(this.rooms.get(room) ?? []);
  }

  private async sendRoomLocal(room: string, payload: unknown): Promise<number> {
    const text = JSON.stringify(payload);
    let reached = 0;
    for (const userId of [...(this.rooms.get(room) ?? [])]) if (await this.sendLocal(userId, text)) reached += 1;
    return reached;
  }

  /** Send `payload` unchanged to every member on every worker. Returns how many local members got it. */
  async broadcastRoom(room: string, payload: unknown): Promise<number> {
    const reached = await this.sendRoomLocal(room, payload);
    if (this.bridge?.publishRoom) await this.bridge.publishRoom(room, payload, this.serverId);
    return reached;
  }

  private async deliverRoomFromBridge(room: string, envelope: any): Promise<void> {
    if (envelope && "origin" in envelope && "data" in envelope) {
      if (envelope.origin === this.serverId) return;
      envelope = envelope.data;
    }
    await this.sendRoomLocal(room, envelope);
  }

  // ------------------------------------------------------------- presence

  /** Presence goes only to the user's conversation partners (never for non-user roles). */
  async broadcastUserStatus(userId: string, status: string, timestamp?: Date): Promise<void> {
    if (this.roleOf(userId) !== USER_ROLE) return;
    await this.broadcastStatus(userId, status, timestamp);
  }

  private async broadcastStatus(userId: string, status: string, timestamp?: Date): Promise<void> {
    if (!this.partnersLookup) return;
    const payload = { type: "user_status", user_id: userId, status, timestamp: formatIso(timestamp ?? utcnow()) };
    let partners: string[];
    try {
      partners = [...(await this.partnersLookup(userId))];
    } catch (err) {
      logger.error(`Partner lookup for ${userId} failed`, err);
      return;
    }
    for (const partnerId of partners) await this.send(partnerId, payload);
  }
}
