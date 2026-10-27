/** Small shared helpers (port of commskit.core.util). */
import { logger } from "./logger.js";

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** Python-style naive UTC isoformat: no offset suffix, fraction only when non-zero (6 digits). */
export function formatIso(d: Date): string {
  const ms = d.getUTCMilliseconds();
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${base}.${pad(ms, 3)}000` : base;
}

export function utcnow(): Date {
  return new Date();
}

export function nowIso(): string {
  return formatIso(utcnow());
}

/**
 * ISO string for a value read from the database: a Date (pg), or a string
 * ("YYYY-MM-DD HH:MM:SS[.ffffff]" from sqlite, or an ISO string). Mirrors Python's `iso()`.
 */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatIso(value);
  if (typeof value === "number") return formatIso(new Date(value));
  let s = String(value).trim().replace(" ", "T");
  s = s.replace(/(Z|[+-]00:?00)$/i, "");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return /^0*$/.test(frac) ? m[1]! : `${m[1]}.${frac}`;
}

/** Parse a database timestamp (naive = UTC) to a Date. */
export function parseDbDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  let s = String(value).trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Python truthiness for JSON values (None, False, 0, "", [], {} are falsy). */
export function pyBool(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Python `str()` for the JSON scalars the protocol carries. */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Python len()/slicing work on code points; JS strings are UTF-16. */
export const codePointLength = (s: string): number => Array.from(s).length;
export const truncateCodePoints = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/** Bounded map; oldest entries are evicted first. */
export class LRU<K, V> {
  private data = new Map<K, V>();
  constructor(private limit: number) {}
  get(key: K): V | undefined {
    return this.data.get(key);
  }
  put(key: K, value: V): void {
    this.data.delete(key);
    this.data.set(key, value);
    while (this.data.size > this.limit) this.data.delete(this.data.keys().next().value as K);
  }
  pop(key: K): V | undefined {
    const v = this.data.get(key);
    this.data.delete(key);
    return v;
  }
  clear(): void {
    this.data.clear();
  }
  discardWhere(predicate: (key: K) => boolean): void {
    for (const k of [...this.data.keys()]) if (predicate(k)) this.data.delete(k);
  }
}

/** Keeps track of fire-and-forget promises so shutdown can wait for them. */
export class TaskSet {
  private tasks = new Set<Promise<unknown>>();

  spawn(task: Promise<unknown> | (() => Promise<unknown>)): void {
    const p = (typeof task === "function" ? Promise.resolve().then(task) : task).catch((err) =>
      logger.error("Background task failed", err),
    );
    this.tasks.add(p);
    void p.finally(() => this.tasks.delete(p));
  }

  async settle(timeoutMs = 2000): Promise<void> {
    if (!this.tasks.size) return;
    await Promise.race([Promise.allSettled([...this.tasks]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
}
