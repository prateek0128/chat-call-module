/**
 * Express adapter: `app.use(commskitRouter(hub))` for the REST routes, `attach(server, hub)` for `/ws/:token`.
 * `express` is an optional peer dependency.
 */
import type { Server } from "node:http";
import express, { type Router } from "express";
import type { CommsHub } from "../core/hub.js";

export function commskitRouter(hub: CommsHub): Router {
  const router = express.Router();
  router.use(express.json({ limit: "20mb" }));
  for (const route of hub.restRoutes()) {
    const method = route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    router[method](route.path, async (req, res, next) => {
      try {
        const result = await route.handler({
          method: req.method,
          path: route.path,
          params: req.params,
          query: req.query as Record<string, string | string[] | undefined>,
          headers: req.headers,
          body: req.body && Object.keys(req.body).length === 0 && req.method === "GET" ? undefined : req.body,
          userId: null,
        });
        res.status(result.status).set(result.headers ?? {}).json(result.body);
      } catch (err) {
        next(err);
      }
    });
  }
  return router;
}

/** Handle `/ws/:token` upgrades on the http.Server that runs the Express app. */
export function attach(server: Server, hub: CommsHub): void {
  hub.attach(server);
}
