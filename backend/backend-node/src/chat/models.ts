/**
 * Chat tables: same table/column names as the Python `commskit.chat.models` (and matrimonial-backend-v2).
 * No foreign key to a users table, so the kit does not depend on the host's user model.
 */
import type { Generated } from "kysely";
import type { Dialect } from "../core/db.js";
import { ddlTypes } from "../core/ddl.js";

type Ts = string | Date;

export interface ChatsTable {
  id: Generated<number>;
  user1_id: string;
  user2_id: string;
  created_at: Ts | null;
  updated_at: Ts | null;
}

export interface MessagesTable {
  id: Generated<number>;
  chat_id: number;
  sender_id: string;
  content: string | null;
  message_type: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | string | null; // BIGINT: pg returns a string
  file_type: string | null;
  thumbnail_url: string | null;
  duration: number | null;
  is_read: boolean | number | null;
  is_delivered: boolean | number | null;
  is_call: boolean | number | null;
  call_id: string | null;
  reply_to_id: number | null;
  created_at: Ts | null;
  updated_at: Ts | null;
}

export interface MessageHiddenTable {
  id: Generated<number>;
  user_id: string;
  message_id: number;
  created_at: Ts | null;
}

export interface ChatClearedTable {
  id: Generated<number>;
  user_id: string;
  chat_id: number;
  cleared_at: Ts;
  up_to_message_id: number;
}

export interface ChatTables {
  chats: ChatsTable;
  messages: MessagesTable;
  comms_message_hidden: MessageHiddenTable;
  comms_chat_cleared: ChatClearedTable;
}

export function chatDdl(dialect: Dialect): string[] {
  const t = ddlTypes(dialect);
  return [
    `CREATE TABLE IF NOT EXISTS chats (
  id ${t.pk},
  user1_id VARCHAR(50) NOT NULL,
  user2_id VARCHAR(50) NOT NULL,
  created_at ${t.tsDefaultNow},
  updated_at ${t.ts},
  CONSTRAINT check_user_order CHECK (user1_id < user2_id),
  CONSTRAINT unique_chat_users UNIQUE (user1_id, user2_id)
)`,
    `CREATE TABLE IF NOT EXISTS messages (
  id ${t.pk},
  chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  sender_id VARCHAR(50) NOT NULL,
  content TEXT,
  message_type VARCHAR(20),
  file_url VARCHAR(500),
  file_name VARCHAR(255),
  file_size ${t.big},
  file_type VARCHAR(50),
  thumbnail_url VARCHAR(500),
  duration INTEGER,
  is_read ${t.bool},
  is_delivered ${t.bool},
  is_call ${t.bool},
  call_id VARCHAR(100),
  reply_to_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  created_at ${t.tsDefaultNow},
  updated_at ${t.ts},
  UNIQUE (call_id)
)`,
    `CREATE TABLE IF NOT EXISTS comms_message_hidden (
  id ${t.pk},
  user_id VARCHAR(50) NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  created_at ${t.tsDefaultNow},
  CONSTRAINT uq_comms_message_hidden UNIQUE (user_id, message_id)
)`,
    `CREATE TABLE IF NOT EXISTS comms_chat_cleared (
  id ${t.pk},
  user_id VARCHAR(50) NOT NULL,
  chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  cleared_at ${t.ts} NOT NULL,
  up_to_message_id INTEGER NOT NULL,
  CONSTRAINT uq_comms_chat_cleared UNIQUE (user_id, chat_id)
)`,
    "CREATE INDEX IF NOT EXISTS ix_chats_id ON chats (id)",
    "CREATE INDEX IF NOT EXISTS ix_messages_id ON messages (id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_message_hidden_user_id ON comms_message_hidden (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_message_hidden_message_id ON comms_message_hidden (message_id)",
    "CREATE INDEX IF NOT EXISTS ix_comms_chat_cleared_user_id ON comms_chat_cleared (user_id)",
  ];
}
