/** UUIDv5 and the CallKit UUID of a call (matches Python `uuid.uuid5` and the mobile kit). */
import { createHash } from "node:crypto";

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export function uuidv5(name: string, namespace: string = NAMESPACE_URL): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** CallKit UUID for a call: UUIDv5(NAMESPACE_URL, "commskit:call:<callId>"). */
export const callkitUuid = (callId: string): string => uuidv5(`commskit:call:${callId}`);
