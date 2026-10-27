/**
 * Moderation tables `comms_blocks` and `comms_reports` (same columns as the Python models; no FK to a users table).
 * ModerationFeature / service / policy wrappers build on these.
 */
import type { Generated } from "kysely";
import type { Dialect } from "../core/db.js";
import { ddlTypes } from "../core/ddl.js";

type Ts = string | Date;

export interface BlocksTable {
  id: Generated<number>;
  blocker_id: string;
  blocked_id: string;
  created_at: Ts;
}

export interface ReportsTable {
  id: Generated<number>;
  reporter_id: string | null;
  reported_id: string | null;
  reason: string | null;
  category: string | null;
  message_id: number | null;
  status: string; // open | resolved | dismissed
  created_at: Ts;
  resolved_at: Ts | null;
  resolved_by: string | null;
  note: string | null;
}

export function moderationDdl(dialect: Dialect): string[] {
  const t = ddlTypes(dialect);
  return [
    `CREATE TABLE IF NOT EXISTS comms_blocks (
  id ${t.pk},
  blocker_id VARCHAR(50) NOT NULL,
  blocked_id VARCHAR(50) NOT NULL,
  created_at ${t.ts} NOT NULL,
  CONSTRAINT uq_comms_blocks_pair UNIQUE (blocker_id, blocked_id)
)`,
    `CREATE TABLE IF NOT EXISTS comms_reports (
  id ${t.pk},
  reporter_id VARCHAR(50),
  reported_id VARCHAR(50),
  reason TEXT,
  category VARCHAR(64),
  message_id INTEGER,
  status VARCHAR(20) NOT NULL,
  created_at ${t.ts} NOT NULL,
  resolved_at ${t.ts},
  resolved_by VARCHAR(50),
  note TEXT
)`,
    "CREATE INDEX IF NOT EXISTS ix_comms_blocks_blocker_id ON comms_blocks (blocker_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_blocks_blocked_id ON comms_blocks (blocked_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_reports_reporter_id ON comms_reports (reporter_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_reports_reported_id ON comms_reports (reported_id)",
  ];
}
