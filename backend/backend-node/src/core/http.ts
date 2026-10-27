/** Built-in `node:http` request listener for the hub's REST routes (no framework needed; used by tests/demo). */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommsHub } from "./hub.js";
import { type RestContext, matchPath } from "./rest.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Returns `(req, res) => Promise<boolean>`: true when a route matched and the response was written,
 * false when nothing matched (the caller may serve other things or answer 404).
 */
export function restListener(hub: CommsHub): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes = hub.restRoutes();
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, url.pathname);
      if (!params) continue;
      const query: RestContext["query"] = {};
      for (const key of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(key);
        query[key] = all.length > 1 ? all : all[0];
      }
      const result = await route.handler({
        method,
        path: route.path,
        params,
        query,
        headers: req.headers,
        body: await readBody(req),
        userId: null,
      });
      res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
      res.end(JSON.stringify(result.body));
      return true;
    }
    return false;
  };
}
