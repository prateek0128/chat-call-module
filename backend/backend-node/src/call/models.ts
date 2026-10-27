/**
 * Call table (`calls`), same columns as the Python `commskit.call.models.Call`.
 * `chat_id` is nullable so calls work without the chat feature.
 * CallFeature / CallService / lifecycle build on this.
 */
import type { Generated } from "kysely";
import type { Dialect } from "../core/db.js";
import { ddlTypes } from "../core/ddl.js";

type Ts = string | Date;

export interface CallsTable {
  id: Generated<number>;
  call_id: string;
  chat_id: number | null;
  caller_id: string;
  receiver_id: string;
  recording_url: string | null;
  call_status: string; // ringing | answered | ended | missed | rejected
  is_video_call: boolean | number | null;
  offer_sdp: string | null;
  answer_sdp: string | null;
  ice_candidates: string | null;
  started_at: Ts;
  answered_at: Ts | null;
  ended_at: Ts | null;
  created_at: Ts | null;
  updated_at: Ts | null;
  duration: number | null;
  missed_at: Ts | null;
  end_reason: string | null;
}

export function callDdl(dialect: Dialect): string[] {
  const t = ddlTypes(dialect);
  return [
    `CREATE TABLE IF NOT EXISTS calls (
  id ${t.pk},
  call_id VARCHAR(100) NOT NULL,
  chat_id INTEGER,
  caller_id VARCHAR(50) NOT NULL,
  receiver_id VARCHAR(50) NOT NULL,
  recording_url TEXT,
  call_status VARCHAR(20) NOT NULL,
  is_video_call ${t.bool},
  offer_sdp TEXT,
  answer_sdp TEXT,
  ice_candidates TEXT,
  started_at ${t.ts} NOT NULL,
  answered_at ${t.ts},
  ended_at ${t.ts},
  created_at ${t.tsDefaultNow},
  updated_at ${t.ts},
  duration INTEGER,
  missed_at ${t.ts},
  end_reason VARCHAR(255),
  UNIQUE (call_id)
)`,
    "CREATE INDEX IF NOT EXISTS ix_calls_id ON calls (id)",
  ];
}
