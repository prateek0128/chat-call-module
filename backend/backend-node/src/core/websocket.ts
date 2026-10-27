/** The single `/ws/:token` endpoint (port of commskit.core.websocket). */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { resolveUserId } from "./adapters.js";
import type { CommsHub } from "./hub.js";
import { logger } from "./logger.js";

export class WsEndpoint {
  readonly wss = new WebSocketServer({ noServer: true });

  constructor(private hub: CommsHub) {}

  /** Token from `/ws/<token>` (query string ignored), or null. */
  match(url: string | undefined): string | null {
    if (!url) return null;
    const pathOnly = url.split("?", 1)[0]!;
    const m = /^\/ws\/([^/]+)$/.exec(pathOnly);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = this.match(req.url);
    if (token === null) {
      socket.destroy();
      return;
    }
    // Accept first, then authenticate: clients expect close code 1008 on a bad token.
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, token));
  }

  closeAll(): void {
    for (const ws of this.wss.clients) ws.terminate();
  }

  private onSocket(ws: WebSocket, token: string): void {
    const hub = this.hub;
    let userId: string | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    // Frames are processed one at a time, in arrival order (like the Python receive loop).
    let chain: Promise<void> = (async () => {
      try {
        userId = await resolveUserId(hub.auth, token);
      } catch (err) {
        logger.info(`WS auth failed: ${(err as Error).message}`);
        ws.close(1008, "Invalid token");
        return;
      }
      try {
        const role = await hub.roleOf(userId);
        const cameOnline = await hub.connections.register(userId, ws, role);
        await hub.runConnectHooks(userId, ws, role, cameOnline);
        const bridge = hub.connections.bridge;
        if (bridge) {
          const uid = userId;
          heartbeat = setInterval(() => void hub.connections.heartbeat(uid).catch(() => undefined), bridge.heartbeatSeconds * 1000);
          heartbeat.unref();
        }
      } catch (err) {
        logger.error(`WS setup for ${userId} crashed`, err);
        ws.close(1011, "Internal server error");
      }
    })();

    ws.on("message", (data: RawData) => {
      chain = chain.then(async () => {
        if (userId !== null) await this.handleFrame(userId, ws, rawToString(data));
      });
    });
    ws.on("error", (err) => logger.warn(`WS error: ${err.message}`));
    ws.on("close", () => {
      chain = chain.then(() => {
        if (heartbeat) clearInterval(heartbeat);
        if (userId !== null) hub.connections.disconnect(userId, ws);
      });
    });
  }

  private async handleFrame(userId: string, ws: WebSocket, raw: string): Promise<void> {
    const hub = this.hub;
    const reply = (payload: unknown): Promise<void> => hub.connections.sendToSocket(ws, payload).catch(() => undefined);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      await hub.reportHandlerError(userId, raw, err);
      await reply({ type: "error", error: "Invalid JSON" });
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      await hub.reportHandlerError(userId, message, new TypeError("Message must be a JSON object"));
      await reply({ type: "error", error: "Message must be a JSON object" });
      return;
    }
    const frame = message as Record<string, any>;
    try {
      await hub.dispatch(userId, frame);
    } catch (err) {
      logger.error(`Handler for ${JSON.stringify(frame.type)} failed`, err);
      await hub.reportHandlerError(userId, frame, err);
      const text = err instanceof Error ? err.message : String(err);
      await hub.send(userId, { type: "error", error: `Message processing failed: ${text}` }).catch(() => undefined);
    }
  }
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
