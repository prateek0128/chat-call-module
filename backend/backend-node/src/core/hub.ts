/** CommsHub: WS handler registry, lifecycle hooks, event bus, REST routes (port of commskit.core.hub). */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import {
  type AuthAdapter,
  NoopPush,
  NullUserDirectory,
  type PushSender,
  type UserDirectory,
  type UserProfile,
  resolveUserId,
} from "./adapters.js";
import { PONG_TYPE } from "./compat.js";
import { USER_ROLE, ConnectionManager, type SocketLike } from "./connections.js";
import { type Db, type Dialect, detectDialect } from "./db.js";
import { EventBus } from "./events.js";
import { type Logger, logger, setLogger } from "./logger.js";
import { type Limiter, RateLimiter } from "./ratelimit.js";
import { HttpError, type RestContext, type RestResult, type RestRoute } from "./rest.js";
import { TaskSet, nowIso } from "./util.js";
import { WsEndpoint } from "./websocket.js";

/** Handler(userId, message, db). Errors propagate to the socket loop, which replies `Message processing failed: ...`. */
export type Handler = (userId: string, message: Record<string, any>, db: Db) => Promise<void> | void;
export type ConnectHook = (userId: string, ws: SocketLike) => Promise<void> | void;
export type DisconnectHook = (userId: string) => Promise<void> | void;
/** roleResolver(userId) -> "user" | any other role (sync or async). Non-user roles get no presence, delivery flush or user hooks. */
export type RoleResolver = (userId: string) => string | Promise<string>;
/** onHandlerError(userId, frame, err): frame is the parsed message, or the raw text for bad JSON. */
export type HandlerErrorHook = (userId: string, frame: unknown, err: unknown) => Promise<void> | void;

/** A feature installs itself on a hub: registers handlers, routes, hooks and tables' services. */
export interface Feature {
  readonly name: string;
  install(hub: CommsHub): unknown;
}

export interface CommsHubOptions {
  auth: AuthAdapter;
  /** Kysely instance (better-sqlite3 for tests/demo, pg for production). Create tables with `ensureSchema`. */
  db: Db;
  /** Override dialect detection. */
  dialect?: Dialect;
  users?: UserDirectory;
  push?: PushSender;
  connections?: ConnectionManager;
  rateLimiter?: Limiter;
  roleResolver?: RoleResolver;
  onHandlerError?: HandlerErrorHook;
  /** Seconds; at most one `user.came_online` per user per cooldown. */
  cameOnlineCooldown?: number;
  logger?: Logger;
}

export class CommsHub {
  readonly auth: AuthAdapter;
  readonly db: Db;
  readonly dialect: Dialect;
  users: UserDirectory;
  pushSender: PushSender;
  connections: ConnectionManager;
  rateLimiter: Limiter;
  roleResolver?: RoleResolver;
  onHandlerError?: HandlerErrorHook;
  readonly events = new EventBus();
  readonly features: Record<string, unknown> = {};

  private handlers = new Map<string, Handler>();
  private connectHooks: Array<[ConnectHook, boolean]> = [];
  private routes: RestRoute[] = [];
  private tasks = new TaskSet();
  private ws: WsEndpoint;

  constructor(opts: CommsHubOptions) {
    this.auth = opts.auth;
    this.db = opts.db;
    this.dialect = opts.dialect ?? detectDialect(opts.db);
    this.users = opts.users ?? new NullUserDirectory();
    this.pushSender = opts.push ?? new NoopPush();
    this.connections = opts.connections ?? new ConnectionManager();
    if (opts.cameOnlineCooldown !== undefined) this.connections.cameOnlineCooldown = Number(opts.cameOnlineCooldown);
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter();
    this.roleResolver = opts.roleResolver;
    this.onHandlerError = opts.onHandlerError;
    if (opts.logger) setLogger(opts.logger);
    this.connections.addOfflineHook((uid) => this.events.emit("user.disconnected", uid));
    this.on("ping", async (userId) => {
      await this.send(userId, { type: PONG_TYPE, timestamp: nowIso() });
    });
    this.on("user_status", (userId, message) =>
      this.connections.setStatus(userId, String(message.status ?? "online")),
    );
    this.ws = new WsEndpoint(this);
  }

  // ------------------------------------------------------------ registry

  /** Install a feature (`hub.install(new ChatFeature({...}))`). Returns the feature. */
  install<F extends Feature>(feature: F): F {
    feature.install(this);
    return feature;
  }

  registerFeature(name: string, feature: unknown): void {
    if (name in this.features) throw new Error(`Feature '${name}' is already installed on this hub`);
    this.features[name] = feature;
  }

  /** Register a WS handler for frames of `type`. Registering again replaces the previous handler. */
  on(type: string, handler: Handler): Handler {
    this.handlers.set(type, handler);
    return handler;
  }

  handles(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Run the handler for `message.type`. Unknown types are ignored (false). */
  async dispatch(userId: string, message: Record<string, any>): Promise<boolean> {
    const handler = this.handlers.get(message.type);
    if (!handler) return false;
    await handler(userId, message, this.db);
    return true;
  }

  /** `hook(userId, ws)` after a socket is registered (runs before frames). Users only unless `allRoles`. */
  onConnect(hook: ConnectHook, allRoles = false): ConnectHook {
    this.connectHooks.push([hook, allRoles]);
    return hook;
  }

  /** `hook(userId)` when the user's last socket on this worker closes (users only unless `allRoles`). */
  onDisconnect(hook: DisconnectHook, allRoles = false): DisconnectHook {
    this.connections.addOfflineHook(hook, allRoles);
    return hook;
  }

  /** `roleResolver(userId)`; "user" without a resolver or when it fails. */
  async roleOf(userId: string): Promise<string> {
    if (!this.roleResolver) return USER_ROLE;
    try {
      return String((await this.roleResolver(userId)) || USER_ROLE);
    } catch (err) {
      logger.error(`roleResolver failed for ${userId}`, err);
      return USER_ROLE;
    }
  }

  /** Call `onHandlerError`; never throws (hook failures are logged). */
  async reportHandlerError(userId: string, frame: unknown, err: unknown): Promise<void> {
    if (!this.onHandlerError) return;
    try {
      await this.onHandlerError(userId, frame, err);
    } catch (e) {
      logger.error("onHandlerError hook failed", e);
    }
  }

  // ---------------------------------------------------------------- rooms

  joinRoom(userId: string, room: string): boolean {
    return this.connections.joinRoom(userId, room);
  }
  leaveRoom(userId: string, room: string): void {
    this.connections.leaveRoom(userId, room);
  }
  /** Send `frame` as given to every member (every worker, with a room-capable bridge). */
  broadcastRoom(room: string, frame: unknown): Promise<number> {
    return this.connections.broadcastRoom(room, frame);
  }

  // ------------------------------------------------------------------ REST

  /** Features call this from `install` to contribute routes. */
  includeRoutes(routes: RestRoute[]): void {
    this.routes.push(...routes);
  }

  /** `Authorization: Bearer <token>` -> user id (401 otherwise). */
  async authenticate(headers: RestContext["headers"]): Promise<string> {
    const raw = headers["authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const m = value ? /^bearer\s+(.+)$/i.exec(value.trim()) : null;
    if (!m || !m[1]) throw new HttpError(401, "Not authenticated");
    try {
      return await resolveUserId(this.auth, m[1].trim());
    } catch {
      throw new HttpError(401, "Invalid token");
    }
  }

  /** All routes, ready for an adapter: auth is resolved and HttpError / crashes become `{status, body}`. */
  restRoutes(): RestRoute[] {
    return this.routes.map((route) => ({
      ...route,
      handler: async (ctx: RestContext): Promise<RestResult> => {
        try {
          const userId = route.auth === false ? null : await this.authenticate(ctx.headers);
          return await route.handler({ ...ctx, userId });
        } catch (err) {
          if (err instanceof HttpError) return { status: err.status, headers: err.headers, body: { detail: err.detail } };
          logger.error(`REST ${route.method} ${route.path} failed`, err);
          return { status: 500, body: { detail: "Internal Server Error" } };
        }
      },
    }));
  }

  // -------------------------------------------------------------------- WS

  /** True when `url` is a `/ws/<token>` request. */
  matchesWs(url: string | undefined): boolean {
    return this.ws.match(url) !== null;
  }

  /** Handle an HTTP upgrade for `/ws/:token` (accept first, then authenticate: 1008 on a bad token). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.ws.handleUpgrade(req, socket, head);
  }

  /** Listen for `/ws/:token` upgrades on an http.Server (other upgrade paths are left to other listeners). */
  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      if (this.matchesWs(req.url)) this.handleUpgrade(req, socket, head);
    });
  }

  get wsServer(): WebSocketServer {
    return this.ws.wss;
  }

  // ------------------------------------------------------------- services

  spawn(task: Promise<unknown> | (() => Promise<unknown>)): void {
    this.tasks.spawn(task);
  }

  /** Close sockets and wait briefly for background work. */
  async shutdown(): Promise<void> {
    this.ws.closeAll();
    await this.tasks.settle();
    await this.connections.stop();
  }

  async send(userId: string, payload: unknown): Promise<boolean> {
    return this.connections.send(userId, payload);
  }

  async runConnectHooks(userId: string, ws: SocketLike, role: string = USER_ROLE, cameOnline = false): Promise<void> {
    const isUser = role === USER_ROLE;
    for (const [hook, allRoles] of [...this.connectHooks]) {
      if (!(isUser || allRoles)) continue;
      try {
        await hook(userId, ws);
      } catch (err) {
        logger.error(`onConnect hook failed for ${userId}`, err);
      }
    }
    if (!isUser) return;
    await this.events.emit("user.connected", userId);
    if (cameOnline) await this.events.emit("user.came_online", userId);
  }

  async profiles(userIds: readonly string[]): Promise<Record<string, UserProfile>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return {};
    try {
      return await this.users.getProfiles(ids);
    } catch (err) {
      logger.error("UserDirectory.getProfiles failed", err);
      return {};
    }
  }

  async profile(userId: string): Promise<UserProfile | undefined> {
    return (await this.profiles([userId]))[userId];
  }

  async displayName(userId: string, fallback = "Someone"): Promise<string> {
    const p = await this.profile(userId);
    return p?.name ? p.name : fallback;
  }

  /** Never throws: push failures are logged. */
  async push(
    userId: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
    channel = "default",
    ttl: number | null = null,
  ): Promise<void> {
    try {
      await this.pushSender.send(userId, title, body, data, channel, ttl);
    } catch (err) {
      logger.error(`Push to ${userId} failed`, err);
    }
  }
}
