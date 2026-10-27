/** Aggregates every kit table (the only place besides `index.ts` allowed to import several features). */
import { sql } from "kysely";
import { callDdl } from "./call/models.js";
import type { CallsTable } from "./call/models.js";
import { chatDdl } from "./chat/models.js";
import type { ChatTables } from "./chat/models.js";
import { type Db, type Dialect, detectDialect } from "./core/db.js";
import { devicesDdl } from "./core/devices.js";
import type { DevicesTable } from "./core/devices.js";
import { moderationDdl } from "./moderation/models.js";
import type { BlocksTable, ReportsTable } from "./moderation/models.js";

/** Kysely table map for every kit table. */
export interface KitDatabase extends ChatTables {
  calls: CallsTable;
  comms_devices: DevicesTable;
  comms_blocks: BlocksTable;
  comms_reports: ReportsTable;
}

/** Tables created by `ensureSchema`, in dependency order. */
export const KIT_TABLES = [
  "chats", "messages", "calls", "comms_devices", "comms_blocks", "comms_reports",
  "comms_message_hidden", "comms_chat_cleared",
] as const;

/** Create every kit table (idempotent; same names/columns/constraints as the Python SQLAlchemy models). */
export async function ensureSchema(db: Db, opts: { dialect?: Dialect } = {}): Promise<void> {
  const dialect = opts.dialect ?? detectDialect(db);
  for (const stmt of [...chatDdl(dialect), ...callDdl(dialect), ...devicesDdl(dialect), ...moderationDdl(dialect)]) {
    await sql.raw(stmt).execute(db);
  }
}
