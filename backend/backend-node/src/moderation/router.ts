/** Moderation REST routes (PROTOCOL.md sections 7 and 9). Port of commskit.moderation.router. */
import { HttpError, type RestContext, type RestRoute, firstQuery, ok, validationError } from "../core/rest.js";
import { iso, pyBool } from "../core/util.js";
import type { ModerationFeature } from "./feature.js";
import { ModerationError, targetId } from "./handlers.js";
import { REPORT_STATUSES, ModerationService } from "./service.js";

function bodyObject(ctx: RestContext): Record<string, any> {
  const b = ctx.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
  }
  return b as Record<string, any>;
}

function intParam(where: "path" | "query", name: string, raw: string | undefined, def?: number, min?: number, max?: number): number {
  if (raw === undefined) {
    if (def === undefined) throw validationError(where, name, "missing", "Field required");
    return def;
  }
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    throw validationError(where, name, "int_parsing", "Input should be a valid integer, unable to parse string as an integer", raw);
  }
  const n = Number(raw);
  if (min !== undefined && n < min) throw validationError(where, name, "greater_than_equal", `Input should be greater than or equal to ${min}`, raw);
  if (max !== undefined && n > max) throw validationError(where, name, "less_than_equal", `Input should be less than or equal to ${max}`, raw);
  return n;
}

export function buildModerationRoutes(feature: ModerationFeature): RestRoute[] {
  const hub = feature.hub;
  const actions = feature.actions;

  const targetOr422 = (userId: string, value: unknown): string => {
    try {
      return targetId(userId, value);
    } catch (err) {
      if (err instanceof ModerationError) throw new HttpError(422, err.message);
      throw err;
    }
  };

  const routes: RestRoute[] = [
    {
      method: "GET",
      path: "/moderation/blocks",
      handler: async (ctx) => {
        const rows = await new ModerationService(hub.db, hub.dialect).listBlocked(ctx.userId!);
        const profiles = await hub.profiles(rows.map((r) => r[0]));
        return ok(
          rows.map(([blockedId, blockedAt]) => {
            const p = profiles[blockedId];
            return { user_id: blockedId, username: p?.name ? p.name : blockedId, avatar: p ? (p.avatar ?? null) : null, blocked_at: iso(blockedAt) };
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/moderation/blocks",
      handler: async (ctx) => {
        const target = targetOr422(ctx.userId!, bodyObject(ctx).user_id);
        await actions.block(hub.db, ctx.userId!, target);
        return ok({ status: true });
      },
    },
    {
      method: "DELETE",
      path: "/moderation/blocks/:blockedId",
      handler: async (ctx) => {
        await actions.unblock(hub.db, ctx.userId!, targetOr422(ctx.userId!, ctx.params.blockedId));
        return ok({ status: true });
      },
    },
    {
      method: "POST",
      path: "/moderation/reports",
      handler: async (ctx) => {
        const p = bodyObject(ctx);
        const target = targetOr422(ctx.userId!, p.user_id);
        if (p.reason === null || p.reason === undefined || !String(p.reason).trim()) throw new HttpError(422, "reason is required");
        try {
          const info = await actions.report(hub.db, ctx.userId!, target, {
            reason: p.reason,
            category: p.category,
            messageId: p.message_id,
            block: pyBool(p.block ?? false),
          });
          return ok({ report_id: info.id });
        } catch (err) {
          if (err instanceof ModerationError) throw new HttpError(422, err.message);
          throw err;
        }
      },
    },
  ];

  const admin = feature.adminDependency;
  if (admin) {
    // The host's dependency authenticates the moderator itself (throw HttpError 401/403), hence auth: false.
    routes.push(
      {
        method: "GET",
        path: "/moderation/admin/reports",
        auth: false,
        handler: async (ctx) => {
          await admin(ctx);
          const status = firstQuery(ctx.query, "status");
          if (status !== undefined && !(REPORT_STATUSES as readonly string[]).includes(status)) {
            throw new HttpError(422, `status must be one of: ${REPORT_STATUSES.join(", ")}`);
          }
          const limit = intParam("query", "limit", firstQuery(ctx.query, "limit"), 50, 1, 200);
          const offset = intParam("query", "offset", firstQuery(ctx.query, "offset"), 0, 0);
          return ok(await feature.listReports(status ?? null, { limit, offset }));
        },
      },
      {
        method: "POST",
        path: "/moderation/admin/reports/:reportId",
        auth: false,
        handler: async (ctx) => {
          const adminId = await admin(ctx);
          const reportId = intParam("path", "report_id", ctx.params.reportId);
          const p = bodyObject(ctx);
          if (!["resolved", "dismissed", "open"].includes(p.status)) throw new HttpError(422, "status must be resolved or dismissed");
          const report = await feature.resolveReport(reportId, p.status, {
            resolvedBy: adminId === null || adminId === undefined ? null : String(adminId),
            note: p.note === null || p.note === undefined ? null : String(p.note),
          });
          if (!report) throw new HttpError(404, "Report not found");
          return ok(report);
        },
      },
      {
        method: "GET",
        path: "/moderation/admin/reports/:reportId/context",
        auth: false,
        handler: async (ctx) => {
          await admin(ctx);
          const reportId = intParam("path", "report_id", ctx.params.reportId);
          const before = intParam("query", "before", firstQuery(ctx.query, "before"), 20, 0, 200);
          const after = intParam("query", "after", firstQuery(ctx.query, "after"), 20, 0, 200);
          const context = await feature.reportContext(reportId, { before, after });
          if (!context) throw new HttpError(404, "Report not found");
          return ok(context);
        },
      },
    );
  }
  return routes;
}
