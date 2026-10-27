/**
 * Deterministic CallKit UUID for a call (RFC 4122 UUIDv5). Pure.
 *
 * Backend contract (PROTOCOL §8, `uuid` in the iOS VoIP push):
 *   uuid = uuid5(NAMESPACE_URL, "commskit:call:" + call_id)
 *   NAMESPACE_URL = 6ba7b811-9dad-11d1-80b4-00c04fd430c8
 * Python: `str(uuid.uuid5(uuid.NAMESPACE_URL, f"commskit:call:{call_id}"))`.
 * The app derives the same value, so CallKit actions map back to the call even when the
 * push payload is not available (e.g. the call was reported natively from AppDelegate).
 */

/** RFC 4122 URL namespace. */
export const CALLKIT_UUID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export const CALLKIT_UUID_PREFIX = "commskit:call:";

const utf8 = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
};

/** SHA-1 of a byte array (20 bytes). Small and dependency-free; used only for UUIDv5. */
export const sha1 = (bytes: number[]): number[] => {
  const ml = bytes.length * 8;
  const msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const hi = Math.floor(ml / 0x100000000);
  for (const word of [hi, ml >>> 0]) msg.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (msg[off + 4 * i] << 24) | (msg[off + 4 * i + 1] << 16) | (msg[off + 4 * i + 2] << 8) | msg[off + 4 * i + 3];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out: number[] = [];
  for (const h of [h0, h1, h2, h3, h4]) out.push((h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255);
  return out;
};

const parseUuid = (uuid: string): number[] => {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`[comms] invalid UUID "${uuid}"`);
  const out: number[] = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

const formatUuid = (b: number[]): string => {
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** RFC 4122 version-5 UUID (lower case). */
export const uuidv5 = (name: string, namespace: string): string => {
  const hash = sha1([...parseUuid(namespace), ...utf8(name)]).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
};

/** CallKit UUID for a call id (same value the backend puts in the VoIP push). */
export const callKitUuid = (callId: string): string => uuidv5(CALLKIT_UUID_PREFIX + callId, CALLKIT_UUID_NAMESPACE);
