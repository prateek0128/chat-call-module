/** TURN REST-API credentials (coturn `use-auth-secret` scheme). */
import { createHmac } from "node:crypto";

export interface TurnCredentials {
  username: string;
  password: string;
  ttl: number;
  uris: string[];
}

/** username = "<expiry>[:<userId>]", password = base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(
  secret: string,
  uris: readonly string[],
  ttl = 3600,
  userId: string | null = null,
  now: number | null = null,
): TurnCredentials {
  const expiry = Math.trunc(now ?? Date.now() / 1000) + ttl;
  const username = userId ? `${expiry}:${userId}` : String(expiry);
  return {
    username,
    password: createHmac("sha1", secret).update(username).digest("base64"),
    ttl,
    uris: [...uris],
  };
}
