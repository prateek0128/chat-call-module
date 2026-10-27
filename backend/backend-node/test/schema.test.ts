import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { KIT_TABLES, ensureSchema } from "../src/index.js";
import { chatDdl } from "../src/chat/models.js";
import { callDdl } from "../src/call/models.js";
import { devicesDdl } from "../src/core/devices.js";
import { moderationDdl } from "../src/moderation/models.js";

describe("schema", () => {
  it("creates every kit table with the Python column names, and is idempotent", async () => {
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureSchema(db);
    await ensureSchema(db);
    const tables = (await sql<{ name: string }>`select name from sqlite_master where type='table' and name not like 'sqlite_%'`.execute(db)).rows.map((r) => r.name);
    expect(tables.sort()).toEqual([...KIT_TABLES].sort());
    const cols = async (t: string) => (await sql<{ name: string }>`select name from pragma_table_info(${t})`.execute(db)).rows.map((r) => r.name);
    expect(await cols("chats")).toEqual(["id", "user1_id", "user2_id", "created_at", "updated_at"]);
    expect(await cols("messages")).toEqual([
      "id", "chat_id", "sender_id", "content", "message_type", "file_url", "file_name", "file_size", "file_type",
      "thumbnail_url", "duration", "is_read", "is_delivered", "is_call", "call_id", "reply_to_id", "created_at", "updated_at",
    ]);
    expect(await cols("calls")).toContain("end_reason");
    expect(await cols("comms_devices")).toContain("voip_token");
    expect(await cols("comms_blocks")).toEqual(["id", "blocker_id", "blocked_id", "created_at"]);
    expect(await cols("comms_reports")).toContain("resolved_by");
    expect(await cols("comms_message_hidden")).toEqual(["id", "user_id", "message_id", "created_at"]);
    expect(await cols("comms_chat_cleared")).toEqual(["id", "user_id", "chat_id", "cleared_at", "up_to_message_id"]);
    await db.destroy();
  });

  it("chats enforce user1_id < user2_id and uniqueness; messages.call_id is unique", async () => {
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureSchema(db);
    await db.insertInto("chats").values({ user1_id: "A", user2_id: "B" }).execute();
    await expect(db.insertInto("chats").values({ user1_id: "B", user2_id: "A" }).execute()).rejects.toThrow(/CHECK/i);
    await expect(db.insertInto("chats").values({ user1_id: "A", user2_id: "B" }).execute()).rejects.toThrow(/UNIQUE/i);
    await db.insertInto("messages").values({ chat_id: 1, sender_id: "A", call_id: "c1" }).execute();
    await expect(db.insertInto("messages").values({ chat_id: 1, sender_id: "A", call_id: "c1" }).execute()).rejects.toThrow(/UNIQUE/i);
    await db.insertInto("messages").values({ chat_id: 1, sender_id: "A" }).execute(); // NULL call_ids may repeat
    await db.destroy();
  });

  it("postgres DDL is generated for every table", () => {
    const all = [...chatDdl("postgres"), ...callDdl("postgres"), ...devicesDdl("postgres"), ...moderationDdl("postgres")].join("\n");
    for (const t of KIT_TABLES) expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${t} `);
    expect(all).toContain("SERIAL PRIMARY KEY");
    expect(all).toContain("TIMESTAMP WITH TIME ZONE");
    expect(all).not.toContain("AUTOINCREMENT");
  });
});
