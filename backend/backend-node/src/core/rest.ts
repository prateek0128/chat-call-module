/** Framework-neutral REST routes (adapters: fastify, express, or the built-in node:http listener). */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestContext {
  method: string;
  /** Route pattern with `:param` segments, e.g. `/chats/:chatId/messages`. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (undefined when there is none). */
  body: unknown;
  /** Set by the hub for routes with `auth !== false` (Bearer token through the AuthAdapter). */
  userId: string | null;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RestRoute {
  method: HttpMethod;
  path: string;
  /** Require `Authorization: Bearer <token>` (default true). */
  auth?: boolean;
  handler(ctx: RestContext): Promise<RestResult> | RestResult;
}

/** Thrown by handlers to answer with FastAPI's error shape `{"detail": ...}`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    public headers?: Record<string, string>,
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

/** FastAPI-style 422 body for a bad parameter. */
export function validationError(where: "query" | "path" | "body", name: string, type: string, msg: string, input: unknown = null): HttpError {
  return new HttpError(422, [{ type, loc: [where, name], msg, input }]);
}

export const ok = (body: unknown, status = 200): RestResult => ({ status, body });

export function firstQuery(q: RestContext["query"], name: string): string | undefined {
  const v = q[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Match a request path against `:param` patterns. Returns the params or null. */
export function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = actual.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) {
      try {
        params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}
