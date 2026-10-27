/** Call REST routes: notification decline and TURN credentials. */
import { HttpError, type RestRoute, ok } from "../core/rest.js";
import type { CallFeature } from "./feature.js";
import { turnCredentials } from "./turn.js";

export function buildCallRoutes(feature: CallFeature): RestRoute[] {
  const hub = feature.hub;
  return [
    {
      method: "POST",
      path: "/call/turn-credentials",
      handler() {
        const cfg = feature.config;
        if (!cfg.turnSecret) throw new HttpError(503, "TURN is not configured");
        return ok(turnCredentials(cfg.turnSecret, cfg.turnUris, cfg.turnTtl));
      },
    },
    {
      // Decline from the call notification while the app has no socket.
      method: "POST",
      path: "/call/:callId/reject",
      async handler(ctx) {
        const found = await feature.lifecycle.rejectFromNotification(hub.db, ctx.params.callId!, ctx.userId!);
        if (!found) return { status: 404, body: { status: false, message: "Call not found" } };
        return ok({ status: true });
      },
    },
  ];
}
