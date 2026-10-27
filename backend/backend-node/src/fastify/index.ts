/**
 * Fastify adapter: `app.register(commskitPlugin, { hub })` registers the hub's REST routes and the
 * `/ws/:token` upgrade on Fastify's http server. `fastify` is an optional peer dependency.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { CommsHub } from "../core/hub.js";

export interface CommskitFastifyOptions {
  hub: CommsHub;
  /** Close sockets when Fastify closes (default true). */
  shutdownOnClose?: boolean;
}

export const commskitPlugin: FastifyPluginAsync<CommskitFastifyOptions> = async (app: FastifyInstance, opts) => {
  const { hub } = opts;
  // Python/FastAPI accepts a JSON content-type with an empty body (e.g. POST /chats/start); so do we.
  if (app.hasContentTypeParser("application/json")) app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  for (const route of hub.restRoutes()) {
    app.route({
      method: route.method,
      url: route.path,
      async handler(request, reply) {
        const result = await route.handler({
          method: request.method,
          path: route.path,
          params: (request.params ?? {}) as Record<string, string>,
          query: (request.query ?? {}) as Record<string, string | string[] | undefined>,
          headers: request.headers,
          body: request.body ?? undefined,
          userId: null,
        });
        for (const [k, v] of Object.entries(result.headers ?? {})) void reply.header(k, v);
        return reply.status(result.status).send(result.body);
      },
    });
  }
  hub.attach(app.server);
  if (opts.shutdownOnClose !== false) app.addHook("onClose", async () => hub.shutdown());
};

export default commskitPlugin;
