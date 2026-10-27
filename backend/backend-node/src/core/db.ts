/** Database helpers shared by all features (Kysely; sqlite for tests/demo, postgres for production). */
import type { Kysely } from "kysely";

export type Dialect = "sqlite" | "postgres";
/** The per-frame "session": the hub's Kysely instance (queries autocommit; use `db.transaction()`). */
export type Db = Kysely<any>;

export function detectDialect(db: Db): Dialect {
  const name: string = (db.getExecutor() as any).adapter?.constructor?.name ?? "";
  if (/postgres/i.test(name)) return "postgres";
  if (/sqlite/i.test(name)) return "sqlite";
  throw new Error(`Cannot detect the SQL dialect (adapter ${name}); pass { dialect } to the hub`);
}

const p2 = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A UTC timestamp value to write: "YYYY-MM-DD HH:MM:SS.ffffff" (sqlite, as SQLAlchemy stores it) or a Date (pg). */
export function dbTimestamp(dialect: Dialect, d: Date = new Date()): string | Date {
  if (dialect === "postgres") return d;
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p2(d.getUTCMilliseconds(), 3)}000`
  );
}

/** Boolean column value: sqlite stores 0/1, postgres wants real booleans. */
export const dbBool = (dialect: Dialect, v: boolean): boolean | number => (dialect === "sqlite" ? (v ? 1 : 0) : v);

/** Current time (the app clock; the Python kit reads the database clock). */
export const dbNow = (): Date => new Date();
