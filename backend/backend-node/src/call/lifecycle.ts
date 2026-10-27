/** Call lifecycle: finishing calls, ring timeout, disconnect grace, re-ring, pushes (port of commskit.call.lifecycle). */
import type { SocketLike } from "../core/connections.js";
import type { Db } from "../core/db.js";
import { logger } from "../core/logger.js";
import { LRU } from "../core/util.js";
import type { CallFeature } from "./feature.js";
import { callPayload } from "./payloads.js";
import { ACTIVE_CALL_STATUSES, type CallInfo, CallService } from "./service.js";

/** (terminal status, end_reason) for a hangup/reject by `fromUser`. */
export function endStatus(call: CallInfo, fromUser: string): [string, string] {
  if (call.status === "answered") return ["ended", "hangup"];
  if (fromUser === call.callerId) return ["missed", "caller_cancelled"];
  return ["rejected", "declined"];
}

export class CallLifecycle {
  /** callId -> [callerId, receiverId]: participants never change, so this per-worker cache keeps ICE off the DB. */
  readonly parties = new LRU<string, [string, string]>(5000);
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(readonly feature: CallFeature) {}

  private get hub() {
    return this.feature.hub;
  }
  private get config() {
    return this.feature.config;
  }

  service(db: Db): CallService {
    return new CallService(db, this.config, this.feature.chatBridge, this.hub.dialect);
  }

  remember(info: CallInfo): void {
    this.parties.put(info.callId, [info.callerId, info.receiverId]);
  }

  /** Emit `call.finalized` (the chat integration sends `call_log` from it). */
  async finalized(info: CallInfo): Promise<void> {
    await this.hub.events.emit("call.finalized", info);
  }

  /** The call, only if `userId` is a participant. */
  async loadCallFor(db: Db, callId: string, userId: string): Promise<CallInfo | null> {
    const call = await this.service(db).getCallInfo(String(callId));
    if (!call || call.otherParty(userId) === null) return null;
    this.remember(call);
    return call;
  }

  // ----------------------------------------------------------- finishing

  /** Hangup / reject / cancel by `fromUser`; outcome decided from call state. */
  async finishCall(db: Db, callIn: CallInfo, fromUser: string): Promise<void> {
    const service = this.service(db);
    let call = callIn;
    let info: CallInfo | null = null;
    let reason = "";
    // Two attempts: if the call changed state underneath us (caller cancels as the receiver answers),
    // re-read it and end it from its real state.
    for (let i = 0; i < 2; i++) {
      if (!(ACTIVE_CALL_STATUSES as readonly string[]).includes(call.status)) break;
      let status: string;
      [status, reason] = endStatus(call, fromUser);
      info = await service.finalizeCall(call.callId, status, reason, [call.status]);
      if (info) break;
      call = (await service.getCallInfo(call.callId)) ?? call;
    }

    if (!info) {
      // Already over: just tell this user's sockets so their UI stops.
      await this.hub.send(
        fromUser,
        callPayload("call_ended", call, {
          status: "call_ended",
          end_reason: call.status,
          ended_by: fromUser,
          duration_seconds: call.duration,
          caller_name: call.callerId,
        }),
      );
      return;
    }

    const rejected = info.status === "rejected";
    // Legacy: caller_name carries the caller's id in these frames.
    const payload = callPayload(rejected ? "call_rejected" : "call_ended", info, {
      status: rejected ? "call_rejected" : "call_ended",
      end_reason: reason,
      duration_seconds: info.duration,
      caller_name: info.callerId,
      ...(rejected ? { rejector_id: fromUser } : { ended_by: fromUser }),
    });
    const other = info.otherParty(fromUser);
    if (other) await this.hub.send(other, payload);
    await this.hub.send(fromUser, payload);
    await this.finalized(info);
    if (info.status === "missed" && fromUser === info.callerId) {
      // Caller hung up while ringing: stop the ringing on a closed app.
      this.hub.spawn(this.pushMissedCall(info));
    }
  }

  /**
   * End every live call between two users with `endReason` (e.g. "blocked"). Answered calls become `ended`,
   * ringing ones `missed`. Both parties get `call_ended`; `call.finalized` is emitted.
   */
  async endCallsBetween(userA: string, userB: string, endReason: string, endedBy: string | null = null): Promise<CallInfo[]> {
    const ended: CallInfo[] = [];
    const service = this.service(this.hub.db);
    for (const call of await service.getActiveCallsForUsers(userA)) {
      if (call.otherParty(userA) !== userB) continue;
      const toStatus = call.status === "answered" ? "ended" : "missed";
      const info = await service.finalizeCall(call.callId, toStatus, endReason, [call.status]);
      if (info) ended.push(info);
    }
    for (const info of ended) {
      const payload = callPayload("call_ended", info, {
        status: "call_ended",
        end_reason: endReason,
        ended_by: endedBy ?? userA,
        duration_seconds: info.duration,
        caller_name: info.callerId,
      });
      await this.hub.send(info.callerId, payload);
      await this.hub.send(info.receiverId, payload);
      await this.finalized(info);
      if (info.status === "missed") this.hub.spawn(this.pushMissedCall(info));
    }
    return ended;
  }

  async rejectFromNotification(db: Db, callId: string, userId: string): Promise<boolean> {
    const call = await this.loadCallFor(db, callId, userId);
    if (!call) return false;
    await this.finishCall(db, call, userId);
    return true;
  }

  // -------------------------------------------------------------- timers

  private later(seconds: number, fn: () => Promise<void>): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.hub.spawn(fn());
    }, seconds * 1000);
    t.unref?.();
    this.timers.add(t);
  }

  /** Cancel every pending ring-timeout / disconnect-grace timer (hub shutdown). */
  cancelAll(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  scheduleRingTimeout(callId: string): void {
    this.later(this.config.ringTimeout, () => this.expireUnanswered(callId));
  }

  /** Ring timeout: ringing -> missed (no_answer). */
  async expireUnanswered(callId: string): Promise<void> {
    try {
      const info = await this.service(this.hub.db).finalizeCall(callId, "missed", "no_answer", ["ringing"]);
      if (!info) return;
      const payload = callPayload("call_missed", info, { status: "missed", end_reason: "no_answer" });
      await this.hub.send(info.callerId, payload);
      await this.hub.send(info.receiverId, payload);
      await this.finalized(info);
      await this.pushMissedCall(info);
    } catch (err) {
      logger.error(`Ring timeout handling failed for ${callId}`, err);
    }
  }

  private async endUserCalls(userId: string, fromStatus: string, toStatus: string): Promise<void> {
    const ended: CallInfo[] = [];
    const service = this.service(this.hub.db);
    for (const call of await service.getActiveCallsForUsers(userId)) {
      if (call.status !== fromStatus) continue;
      const info = await service.finalizeCall(call.callId, toStatus, "disconnected", [fromStatus]);
      if (info) ended.push(info);
    }
    for (const info of ended) {
      const other = info.otherParty(userId);
      if (other) {
        await this.hub.send(
          other,
          callPayload("call_ended", info, {
            status: "call_ended",
            ended_by: userId,
            end_reason: "disconnected",
            duration_seconds: info.duration,
          }),
        );
      }
      await this.finalized(info);
    }
  }

  /** Offline hook: after a grace period end calls the user is still in (answered ones get longer). */
  endCallsAfterDisconnect(userId: string): void {
    const cfg = this.config;
    this.later(cfg.ringingDisconnectGrace, async () => {
      try {
        if (await this.hub.connections.isConnected(userId)) return;
        await this.endUserCalls(userId, "ringing", "missed");
        this.later(Math.max(0, cfg.answeredDisconnectGrace - cfg.ringingDisconnectGrace), async () => {
          try {
            if (await this.hub.connections.isConnected(userId)) return;
            await this.endUserCalls(userId, "answered", "ended");
          } catch (err) {
            logger.error(`Ending calls for disconnected ${userId} failed`, err);
          }
        });
      } catch (err) {
        logger.error(`Ending calls for disconnected ${userId} failed`, err);
      }
    });
  }

  // ------------------------------------------------------------- connect

  /** Re-ring a call still waiting for this user, on the new socket only, with the stored offer SDP. */
  async onConnect(userId: string, ws: SocketLike): Promise<void> {
    const service = this.service(this.hub.db);
    const call = await service.getActiveCallForUser(userId);
    if (!call || call.status !== "ringing" || call.receiverId !== userId) return;
    const offerSdp = await service.getOfferSdp(call.callId);
    this.remember(call);
    const payload = await this.incomingPayload(call);
    if (offerSdp) {
      try {
        payload.sdp = JSON.parse(offerSdp);
      } catch {
        /* keep the frame without sdp */
      }
    }
    await this.hub.connections.sendToSocket(ws, payload);
  }

  async incomingPayload(info: CallInfo): Promise<Record<string, any>> {
    const profile = await this.hub.profile(info.callerId);
    return callPayload("incoming_call", info, {
      caller_name: profile?.name ? profile.name : "Someone",
      caller_avatar: profile ? (profile.avatar ?? null) : null,
    });
  }

  // --------------------------------------------------------------- push

  async pushIncoming(info: CallInfo, callerName: string, callerAvatar: string | null): Promise<void> {
    await this.hub.push(
      info.receiverId,
      callerName,
      `Incoming ${info.callType} call`,
      {
        type: "incoming_call",
        call_id: info.callId,
        chat_id: info.chatId,
        caller_id: info.callerId,
        caller_name: callerName,
        caller_avatar: callerAvatar,
        call_type: info.callType,
      },
      this.config.ringtoneChannel,
      Math.trunc(this.config.ringTimeout),
    );
  }

  /** Receiver's app is not in the foreground: leave a missed-call notification (also stops a ringing one). */
  async pushMissedCall(info: CallInfo): Promise<void> {
    if (await this.hub.connections.isOnline(info.receiverId)) return;
    const callerName = await this.hub.displayName(info.callerId);
    await this.hub.push(
      info.receiverId,
      callerName,
      `Missed ${info.callType} call`,
      { type: "missed_call", call_id: info.callId, chat_id: info.chatId, caller_id: info.callerId, call_type: info.callType },
      this.config.missedChannel,
    );
  }
}
