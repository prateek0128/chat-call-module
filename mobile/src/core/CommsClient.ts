/**
 * CommsClient — owns the app's single WebSocket (PROTOCOL §1). Framework-free:
 * no React, no react-native imports. AppState and the WebSocket constructor are
 * injected (CommsProvider passes RN's AppState).
 *
 * - URL `${wsUrl}/ws/${token}`, token from `config.getToken()` on every connect
 * - reconnect with backoff min(1000 * 2^n, 30000) while the app is in the foreground
 * - reconnects immediately when the app becomes active
 * - reports `user_status` online / away on AppState changes
 * - `on(type)` / `off` / `send` / `onStatus`; `send` returns whether the frame was
 *   sent (or queued, with the queue policy)
 */

import { CommsConfig, Logger, noopLogger, socketUrl } from "./config";
import type { ClientEventMap, ServerEventMap, WireMessage } from "./types";

// --- injected environment -------------------------------------------------

export type AppStateLikeStatus = string;

export interface AppStateLike {
  currentState: AppStateLikeStatus | null | undefined;
  addEventListener(type: "change", listener: (state: any) => void): { remove(): void };
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;
const WS_CONNECTING = 0;

// --- public types -----------------------------------------------------------

export type ConnectionStatus =
  /** Not started, or stopped with `disconnect()`. */
  | "idle"
  /** Waiting for getToken() / socket handshake. */
  | "connecting"
  | "open"
  /** Socket dropped; a reconnect is scheduled (or waits for the app to be active). */
  | "reconnecting"
  /** getToken() returned nothing: logged out. Call `connect()` after login. */
  | "unauthenticated";

export interface StatusInfo {
  status: ConnectionStatus;
  /** Reconnect attempt counter (0 after a successful open). */
  attempt: number;
  /** Close code of the last socket close (1008 = invalid token). */
  lastCloseCode?: number;
}

/**
 * What to do with `send()` while the socket is not open.
 * - "drop" (default): return false, frame is lost (callers update UI accordingly)
 * - "queue": keep up to `maxQueue` frames and flush them in order on open; returns true
 * - function: decide per frame (true = queue)
 */
export type OfflineSendPolicy = "drop" | "queue" | ((message: WireMessage) => boolean);

export interface CommsClientOptions {
  config: CommsConfig;
  appState?: AppStateLike;
  /** Defaults to the global `WebSocket` constructor. */
  createWebSocket?: WebSocketFactory;
  offlineSendPolicy?: OfflineSendPolicy;
  maxQueue?: number;
  /** Send `ping` every N ms while open (0 = off, default). The server also heartbeats. */
  pingIntervalMs?: number;
  /** Backoff cap (default 30000). */
  maxReconnectDelayMs?: number;
}

export type MessageHandler<T = WireMessage> = (message: T) => void;
type AnyHandler = (message: any) => void;

export const backoffDelay = (attempt: number, max = 30000): number =>
  Math.min(1000 * Math.pow(2, attempt), max);

const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as any).WebSocket;
  if (!Ctor) throw new Error("[comms] no global WebSocket; pass createWebSocket");
  return new Ctor(url) as WebSocketLike;
};

export class CommsClient {
  readonly config: CommsConfig;
  private readonly log: Logger;
  private readonly appState?: AppStateLike;
  private readonly createWebSocket: WebSocketFactory;
  private readonly policy: OfflineSendPolicy;
  private readonly maxQueue: number;
  private readonly pingIntervalMs: number;
  private readonly maxDelay: number;

  private ws: WebSocketLike | null = null;
  private handlers = new Map<string, Set<AnyHandler>>();
  private statusListeners = new Set<(info: StatusInfo) => void>();
  private queue: WireMessage[] = [];
  private attempt = 0;
  private reconnectTimer: any = null;
  private pingTimer: any = null;
  private appStateSub: { remove(): void } | null = null;
  private started = false;
  private connectSeq = 0;
  private _status: StatusInfo = { status: "idle", attempt: 0 };
  private _userId: string | null = null;
  private lastAppState: string | null | undefined;

  constructor(options: CommsClientOptions) {
    this.config = options.config;
    this.log = options.config.logger || noopLogger;
    this.appState = options.appState;
    this.createWebSocket = options.createWebSocket || defaultWebSocketFactory;
    this.policy = options.offlineSendPolicy || "drop";
    this.maxQueue = options.maxQueue ?? 100;
    this.pingIntervalMs = options.pingIntervalMs ?? 0;
    this.maxDelay = options.maxReconnectDelayMs ?? 30000;
    this.lastAppState = this.appState?.currentState;
  }

  // ---- state -------------------------------------------------------------

  get status(): StatusInfo {
    return this._status;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN && this._status.status === "open";
  }

  /** Current user id as resolved by `config.getUserId()` on the last connect. */
  get userId(): string | null {
    return this._userId;
  }

  /** Whether `send()` would currently succeed (open, or the policy queues). */
  canSend(message?: WireMessage): boolean {
    if (this.isOpen) return true;
    if (this.policy === "queue") return true;
    if (typeof this.policy === "function") return message ? this.policy(message) : false;
    return false;
  }

  /** Re-reads `config.getUserId()` (e.g. right after login, before connecting). */
  async refreshUserId(): Promise<string | null> {
    try {
      const id = await this.config.getUserId();
      this._userId = id ? String(id) : null;
    } catch (e) {
      this.log.warn("getUserId failed", e);
    }
    return this._userId;
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Starts (or restarts) the connection. Safe to call repeatedly. */
  connect(): Promise<void> {
    this.started = true;
    this.attachAppState();
    this.clearReconnect();
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) {
      return Promise.resolve();
    }
    return this.openSocket();
  }

  /** Stops for good (logout / unmount): closes the socket, no reconnect. */
  disconnect(): void {
    this.started = false;
    this.connectSeq += 1;
    this.clearReconnect();
    this.stopPing();
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.closeSocket();
    this.queue = [];
    this.attempt = 0;
    this.setStatus("idle");
  }

  /** Drops the current socket and connects again now (e.g. after a token change). */
  reconnect(): Promise<void> {
    this.started = true;
    this.attachAppState();
    this.clearReconnect();
    this.closeSocket();
    this.attempt = 0;
    return this.openSocket();
  }

  // ---- messaging ---------------------------------------------------------

  /** Typed send: `client.send("get_messages", {chat_id, offset: 0, limit: 10})`. */
  send<K extends keyof ClientEventMap>(type: K, payload: ClientEventMap[K]): boolean;
  send(type: string, payload?: Record<string, unknown>): boolean;
  send(type: string, payload: Record<string, unknown> = {}): boolean {
    return this.sendRaw({ ...payload, type });
  }

  sendRaw(message: WireMessage): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return true;
      } catch (e) {
        this.log.warn("send failed", message.type, e);
        return false;
      }
    }
    const shouldQueue =
      this.policy === "queue" || (typeof this.policy === "function" && this.policy(message));
    if (shouldQueue && this.started) {
      if (this.queue.length >= this.maxQueue) this.queue.shift();
      this.queue.push(message);
      return true;
    }
    this.log.debug("dropped while disconnected", message.type);
    return false;
  }

  /** Subscribe to a server event type (or "*" for every frame). Returns an unsubscribe fn. */
  on<K extends keyof ServerEventMap>(type: K, handler: MessageHandler<ServerEventMap[K]>): () => void;
  on(type: string, handler: MessageHandler<any>): () => void;
  on(type: string, handler: AnyHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type: string, handler: AnyHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  onStatus(listener: (info: StatusInfo) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Delivers a frame to local subscribers as if it came from the server.
   * Used for client-side fallbacks (e.g. the call provider's local `call_log`),
   * so features can talk without importing each other.
   */
  dispatchLocal(message: WireMessage): void {
    this.dispatch(message);
  }

  // ---- internals ---------------------------------------------------------

  private setStatus(status: ConnectionStatus, lastCloseCode?: number): void {
    const next: StatusInfo = { status, attempt: this.attempt };
    if (lastCloseCode !== undefined) next.lastCloseCode = lastCloseCode;
    else if (this._status.lastCloseCode !== undefined) next.lastCloseCode = this._status.lastCloseCode;
    const prev = this._status;
    this._status = next;
    if (prev.status === next.status && prev.attempt === next.attempt && prev.lastCloseCode === next.lastCloseCode) return;
    this.statusListeners.forEach((l) => {
      try {
        l(next);
      } catch (e) {
        this.log.error("status listener failed", e);
      }
    });
  }

  private dispatch(message: WireMessage): void {
    const deliver = (set?: Set<AnyHandler>) =>
      set &&
      Array.from(set).forEach((h) => {
        try {
          h(message);
        } catch (e) {
          this.log.error("handler failed for", message.type, e);
        }
      });
    deliver(this.handlers.get(message.type));
    deliver(this.handlers.get("*"));
  }

  private async openSocket(): Promise<void> {
    const seq = ++this.connectSeq;
    this.setStatus("connecting");
    let token: string | null | undefined;
    try {
      [token] = await Promise.all([this.config.getToken(), this.refreshUserId()]);
    } catch (e) {
      this.log.warn("getToken failed", e);
      token = null;
    }
    if (seq !== this.connectSeq || !this.started) return; // superseded / stopped
    if (!token) {
      this.setStatus("unauthenticated");
      return;
    }

    let ws: WebSocketLike;
    try {
      ws = this.createWebSocket(socketUrl(this.config, token));
    } catch (e) {
      this.log.error("WebSocket creation failed", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus("open");
      this.startPing();
      this.flushQueue();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let data: any;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        this.log.debug("non-JSON frame ignored");
        return;
      }
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      // Legacy quirk (PROTOCOL §6): `PONG` is upper case.
      if (data.type === "PONG") data = { ...data, type: "pong" };
      this.dispatch(data as WireMessage);
    };
    ws.onerror = (e) => {
      this.log.debug("socket error", e);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return; // replaced socket
      this.ws = null;
      this.stopPing();
      this.log.info("socket closed", event?.code, event?.reason);
      if (!this.started) {
        this.setStatus("idle", event?.code);
        return;
      }
      this.setStatus("reconnecting", event?.code);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.setStatus("reconnecting");
    // Background: wait for the AppState listener to reconnect on foreground.
    if (this.appState && this.appState.currentState && this.appState.currentState !== "active") return;
    const delay = backoffDelay(this.attempt, this.maxDelay);
    this.attempt += 1;
    this.log.info(`reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private flushQueue(): void {
    if (!this.queue.length) return;
    const pending = this.queue;
    this.queue = [];
    pending.forEach((m) => this.sendRaw(m));
  }

  private startPing(): void {
    this.stopPing();
    if (this.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.sendRaw({ type: "ping" }), this.pingIntervalMs);
    }
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private attachAppState(): void {
    if (!this.appState || this.appStateSub) return;
    this.appStateSub = this.appState.addEventListener("change", (state: string) => this.onAppState(state));
  }

  private onAppState(state: string): void {
    const prev = this.lastAppState;
    this.lastAppState = state;
    if (!this.started) return;
    if (state === "active") {
      const ws = this.ws;
      if (!ws || (ws.readyState !== WS_OPEN && ws.readyState !== WS_CONNECTING)) {
        // Socket died in the background: reconnect now instead of waiting on backoff.
        this.clearReconnect();
        this.attempt = 0;
        void this.openSocket();
        return;
      }
      if (prev !== "active") this.sendRaw({ type: "user_status", status: "online" });
      return;
    }
    // background / inactive: anything but "online" is "away" (PROTOCOL §2).
    if (prev === "active" || prev == null) {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.ws.send(JSON.stringify({ type: "user_status", status: "away" }));
      }
    }
  }
}
