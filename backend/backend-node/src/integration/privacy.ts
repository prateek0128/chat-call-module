/**
 * Account deletion across every installed feature (port of commskit.integration.privacy). Works through `hub.features` (any
 * feature with an async `deleteUserData(userId)`), so it imports no feature package.
 */
import type { CommsHub } from "../core/hub.js";
import { logger } from "../core/logger.js";

// Chat first: its messages may reference calls (call-log entries); devices last.
const ORDER = ["chat", "call", "moderation", "devices"];

/**
 * Call `deleteUserData(userId)` on every installed feature (chat, call, moderation, devices, then any others), then emit
 * `user.deleted(userId)`. Returns `{featureName: result}`. A failing feature is logged and reported as `{error}` (or
 * re-thrown with `raiseErrors`); the others still run.
 */
export async function deleteUserEverywhere(hub: CommsHub, userId: string, opts: { raiseErrors?: boolean } = {}): Promise<Record<string, unknown>> {
  const uid = String(userId);
  const rank = (n: string): number => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
  const names = Object.keys(hub.features).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const results: Record<string, unknown> = {};
  for (const name of names) {
    const feature = hub.features[name] as { deleteUserData?: (id: string) => Promise<unknown> } | undefined;
    if (typeof feature?.deleteUserData !== "function") continue;
    try {
      results[name] = await feature.deleteUserData(uid);
    } catch (err) {
      if (opts.raiseErrors) throw err;
      logger.error(`deleteUserData failed in feature ${name}`, err);
      results[name] = { error: String((err as Error)?.message ?? err) };
    }
  }
  await hub.events.emit("user.deleted", uid);
  return results;
}
