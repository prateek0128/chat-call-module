import type { Dialect } from "./db.js";

/** Portable column type fragments (same logical schema SQLAlchemy `create_all` produces). */
export function ddlTypes(dialect: Dialect): { pk: string; ts: string; tsDefaultNow: string; bool: string; big: string } {
  return dialect === "sqlite"
    ? {
        pk: "INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT",
        ts: "DATETIME",
        tsDefaultNow: "DATETIME DEFAULT (CURRENT_TIMESTAMP)",
        bool: "BOOLEAN",
        big: "BIGINT",
      }
    : {
        pk: "SERIAL PRIMARY KEY",
        ts: "TIMESTAMP WITH TIME ZONE",
        tsDefaultNow: "TIMESTAMP WITH TIME ZONE DEFAULT now()",
        bool: "BOOLEAN",
        big: "BIGINT",
      };
}
