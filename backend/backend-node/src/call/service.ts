/**
 * CallService: call rows and their state machine (port of commskit.call.service).
 * State changes are conditional UPDATEs (`WHERE call_status = <expected>`) so hangup / timeout / disconnect
 * racing on different workers finalize a call once. Timestamps come from the app clock (`dbNow`).
 */
import { randomUUID } from "node:crypto";
import { type Db, type Dialect, dbBool, dbNow, dbTimestamp, detectDialect } from "../core/db.js";
import { parseDbDate } from "../core/util.js";
import type { CallChatBridge } from "./bridge.js";
import { type CallConfig, defaultCallConfig } from "./config.js";

export const ACTIVE_CALL_STATUSES = ["ringing", "answered"] as const;

export class CallInfo {
  /** Filled by a chat bridge during finalize: the call's chat entry. */
  messageId: number | null = null;
  logText: string | null = null;

  constructor(
    public callId: string,
    public chatId: number | null,
    public callerId: string,
    public receiverId: string,
    public isVideoCall: boolean,
    public status: string,
    public duration = 0,
    public endReason: string | null = null,
  ) {}

  static fromRow(row: Record<string, any>): CallInfo {
    return new CallInfo(
      row.call_id, row.chat_id === null || row.chat_id === undefined ? null : Number(row.chat_id), row.caller_id,
      row.receiver_id, Boolean(row.is_video_call), row.call_status, row.duration ?? 0, row.end_reason ?? null,
    );
  }

  get callType(): "video" | "audio" {
    return this.isVideoCall ? "video" : "audio";
  }

  otherParty(userId: string): string | null {
    if (userId === this.callerId) return this.receiverId;
    if (userId === this.receiverId) return this.callerId;
    return null;
  }

  clone(patch: Partial<CallInfo> = {}): CallInfo {
    return Object.assign(Object.create(CallInfo.prototype), this, patch);
  }
}

/** "Voice call · 05:42", "Missed voice call", "Declined voice call" (caller-cancelled is logged as Missed). */
export function callLogText(status: string, isVideoCall: boolean, duration: number, _endReason: string | null = null): string {
  const kind = isVideoCall ? "Video call" : "Voice call";
  if (status === "missed") return `Missed ${kind.toLowerCase()}`;
  if (status === "rejected") return `Declined ${kind.toLowerCase()}`;
  const total = Math.max(0, Math.trunc(duration));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${kind} · ${hours ? `${hours}:${p(mins)}:${p(secs)}` : `${p(mins)}:${p(secs)}`}`;
}

export class CallService {
  private dialect: Dialect;
  config: CallConfig;

  constructor(
    private db: Db,
    config?: CallConfig,
    private bridge: CallChatBridge | null = null,
    dialect?: Dialect,
  ) {
    this.config = config ?? defaultCallConfig();
    this.dialect = dialect ?? detectDialect(db);
  }

  private ts(d: Date = dbNow()): string | Date {
    return dbTimestamp(this.dialect, d);
  }

  async createCall(chatId: number | null, callerId: string, receiverId: string, isVideoCall = false): Promise<CallInfo> {
    const callId = randomUUID();
    await this.db
      .insertInto("calls")
      .values({
        call_id: callId, chat_id: chatId, caller_id: callerId, receiver_id: receiverId, call_status: "ringing",
        is_video_call: dbBool(this.dialect, isVideoCall), started_at: this.ts(),
      })
      .execute();
    return new CallInfo(callId, chatId, callerId, receiverId, isVideoCall, "ringing");
  }

  async getCallById(callId: string): Promise<Record<string, any> | undefined> {
    return this.db.selectFrom("calls").selectAll().where("call_id", "=", callId).executeTakeFirst();
  }

  async getCallInfo(callId: string): Promise<CallInfo | null> {
    const row = await this.getCallById(callId);
    return row ? CallInfo.fromRow(row) : null;
  }

  async saveOfferSdp(callId: string, offerSdp: string): Promise<void> {
    await this.db.updateTable("calls").set({ offer_sdp: offerSdp }).where("call_id", "=", callId).execute();
  }

  async getOfferSdp(callId: string): Promise<string | null> {
    const r = await this.db.selectFrom("calls").select("offer_sdp").where("call_id", "=", callId).executeTakeFirst();
    return r?.offer_sdp ?? null;
  }

  private liveCallsQuery(userId: string) {
    const now = dbNow();
    const cfg = this.config;
    const ringCutoff = this.ts(new Date(now.getTime() - (cfg.ringTimeout + cfg.ringWindowSlack) * 1000));
    const answeredCutoff = this.ts(new Date(now.getTime() - cfg.maxCallHours * 3600 * 1000));
    return this.db
      .selectFrom("calls")
      .selectAll()
      .where((eb: any) =>
        eb.and([
          eb.or([eb("caller_id", "=", userId), eb("receiver_id", "=", userId)]),
          eb.or([
            eb.and([eb("call_status", "=", "ringing"), eb("started_at", ">=", ringCutoff)]),
            eb.and([eb("call_status", "=", "answered"), eb("answered_at", ">=", answeredCutoff)]),
          ]),
        ]),
      )
      .orderBy("started_at", "desc")
      .orderBy("id", "desc");
  }

  async getActiveCallForUser(userId: string): Promise<CallInfo | null> {
    const row = await this.liveCallsQuery(userId).limit(1).executeTakeFirst();
    return row ? CallInfo.fromRow(row) : null;
  }

  async getActiveCallsForUsers(userId: string): Promise<CallInfo[]> {
    return (await this.liveCallsQuery(userId).execute()).map((r: any) => CallInfo.fromRow(r));
  }

  /** ringing -> answered. Only the receiver can answer, and only once. */
  async markAnswered(callId: string, receiverId: string): Promise<CallInfo | null> {
    const res = await this.db
      .updateTable("calls")
      .set({ call_status: "answered", answered_at: this.ts() })
      .where("call_id", "=", callId)
      .where("receiver_id", "=", receiverId)
      .where("call_status", "=", "ringing")
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) return null;
    return this.getCallInfo(callId);
  }

  /** Move a live call to a terminal status. null if another path already did. */
  async finalizeCall(
    callId: string,
    status: string,
    endReason: string,
    onlyFrom: readonly string[] = ACTIVE_CALL_STATUSES,
  ): Promise<CallInfo | null> {
    const call = await this.getCallById(callId);
    if (!call || !onlyFrom.includes(call.call_status)) return null;
    const fromStatus: string = call.call_status;
    const snapshot = CallInfo.fromRow(call);
    const now = dbNow();
    let duration = 0;
    const answeredAt = parseDbDate(call.answered_at);
    if (fromStatus === "answered" && answeredAt) duration = Math.max(0, Math.trunc((now.getTime() - answeredAt.getTime()) / 1000));

    const values: Record<string, unknown> = { call_status: status, end_reason: endReason, ended_at: this.ts(now), duration };
    if (status === "missed") values.missed_at = this.ts(now);
    const info = snapshot.clone({ status, duration, endReason });
    const bridge = this.bridge;
    const done = await this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable("calls")
        .set(values)
        .where("call_id", "=", callId)
        .where("call_status", "=", fromStatus)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) return false;
      // Same transaction: the chat entry flips to the log text with the status.
      if (bridge) await bridge.onCallFinalizing(trx, info);
      return true;
    });
    return done ? info : null;
  }
}
