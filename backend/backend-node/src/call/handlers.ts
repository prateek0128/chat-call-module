/** Call WebSocket handlers (PROTOCOL.md section 4). Port of commskit.call.handlers. */
import type { Db } from "../core/db.js";
import type { Handler } from "../core/hub.js";
import { logger } from "../core/logger.js";
import { retryAfterSeconds } from "../core/ratelimit.js";
import { nowIso, pyBool, pyStr } from "../core/util.js";
import type { CallFeature } from "./feature.js";
import { busyPayload, callError, callPayload, callerView } from "./payloads.js";
import { ACTIVE_CALL_STATUSES } from "./service.js";

export class CallHandlers {
  constructor(private feature: CallFeature) {}

  private get hub() {
    return this.feature.hub;
  }
  private get lifecycle() {
    return this.feature.lifecycle;
  }

  register(): void {
    const on = this.hub.on.bind(this.hub);
    on("call_initiate", this.guard((u, m, d) => this.callInitiate(u, m, d), "Failed to initiate call"));
    on("answer_call", this.guard((u, m, d) => this.answerCall(u, m, d), "Failed to answer call"));
    // reject_call and end_call are equivalent: the outcome comes from call state.
    on("reject_call", this.guard((u, m, d) => this.endCall(u, m, d), "Failed to reject call"));
    on("end_call", this.guard((u, m, d) => this.endCall(u, m, d), "Failed to end call"));
    on("sdp_offer", this.guard((u, m, d) => this.relaySdp(u, m, d, "sdp_offer"), null));
    on("sdp_answer", this.guard((u, m, d) => this.relaySdp(u, m, d, "sdp_answer"), null));
    on("ice_candidate", this.guard((u, m, d) => this.iceCandidate(u, m, d), null));
    on("start_recording", async () => undefined); // accepted and ignored (PROTOCOL.md)
  }

  /** Crash -> call-tagged error (label) or logged only (signalling relays). */
  private guard(fn: Handler, label: string | null): Handler {
    return async (userId, message, db) => {
      try {
        await fn(userId, message, db);
      } catch (err) {
        logger.error(`${message.type} handler failed`, err);
        await this.hub.reportHandlerError(userId, message, err);
        if (label) await this.error(userId, `${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  private async error(userId: string, error: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.hub.send(userId, callError(error, extra));
  }

  // ------------------------------------------------------------ initiate

  async callInitiate(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    const lifecycle = this.lifecycle;
    const connections = this.hub.connections;
    const rawReceiver = message.receiver_id;
    const callType = message.call_type === "video" ? "video" : "audio";
    if (!pyBool(rawReceiver)) {
      await this.error(userId, "Missing required fields: receiver_id");
      return;
    }
    const receiverId = pyStr(rawReceiver);
    if (receiverId === userId) {
      await this.error(userId, "You cannot call yourself.");
      return;
    }
    const limit = this.feature.config.initiateRate;
    const wait = limit ? await this.hub.rateLimiter.hit(`call.initiate:${userId}`, limit) : 0;
    if (wait) {
      const seconds = retryAfterSeconds(wait);
      await this.error(userId, `Too many calls. Try again in ${seconds} s.`, { code: "rate_limited", retry_after: seconds });
      return;
    }

    const service = lifecycle.service(db);
    const ownCall = await service.getActiveCallForUser(userId);
    if (ownCall && ownCall.status === "ringing") {
      await this.error(userId, "You are already in a call.");
      return;
    }
    if (ownCall) {
      // Starting a new call means they left their answered one; its hangup was lost. Close it out.
      await lifecycle.finishCall(db, ownCall, userId);
    }

    let receiverCall = await service.getActiveCallForUser(receiverId);
    if (
      receiverCall &&
      !((await connections.isConnected(receiverCall.callerId)) || (await connections.isConnected(receiverCall.receiverId)))
    ) {
      // Nobody on that call has a socket anywhere: a leftover, not a real call.
      const stale = await service.finalizeCall(
        receiverCall.callId,
        receiverCall.status === "answered" ? "ended" : "missed",
        "stale",
        [receiverCall.status],
      );
      if (stale) await lifecycle.finalized(stale);
      receiverCall = await service.getActiveCallForUser(receiverId);
    }
    if (receiverCall) {
      await this.hub.send(userId, busyPayload(userId, receiverId, callType));
      return;
    }

    const decision = await this.feature.policy.authorize(db, userId, receiverId, message);
    if (!decision.allowed) {
      const error: Record<string, unknown> = { ...(decision.error ?? { error: "Call not allowed." }) };
      if (!("error" in error)) error.error = "Call not allowed.";
      await this.hub.send(userId, { type: "error", ...error, context: "call" });
      return;
    }

    const bridge = this.feature.chatBridge;
    const chatId = bridge ? await bridge.resolveChatId(db, userId, receiverId, message.chat_id) : null;
    const info = await service.createCall(chatId, userId, receiverId, callType === "video");
    lifecycle.scheduleRingTimeout(info.callId);
    if (bridge) await bridge.onCallCreated(db, info);
    lifecycle.remember(info);

    await this.hub.send(userId, callPayload("call_initiated", info, { status: "calling", ...callerView(info) }));

    const incoming = await lifecycle.incomingPayload(info);
    const delivered = await this.hub.send(receiverId, incoming);
    if (delivered) {
      await this.hub.send(userId, callPayload("call_ringing", info, { status: "ringing", ...callerView(info) }));
    } else {
      // Push only when no socket got it: a connected app rings by itself and a push on top would ring twice.
      this.hub.spawn(lifecycle.pushIncoming(info, incoming.caller_name, incoming.caller_avatar));
    }
    logger.info(`Call ${info.callId} initiated ${userId} -> ${receiverId}`);
  }

  // -------------------------------------------------------------- answer

  async answerCall(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    if (!pyBool(message.call_id)) {
      await this.error(userId, "Missing required fields: call_id");
      return;
    }
    const callId = pyStr(message.call_id);
    const lifecycle = this.lifecycle;
    const info = await lifecycle.service(db).markAnswered(callId, userId);
    if (!info) {
      const call = await lifecycle.loadCallFor(db, callId, userId);
      if (!call) {
        await this.error(userId, "Call not found", { call_id: callId });
        return;
      }
      if (call.status === "answered") return; // duplicate answer (double tap / second socket)
      // Cancelled or timed out meanwhile: stop ringing on every socket.
      await this.hub.send(
        userId,
        callPayload("call_ended", call, { status: "call_ended", end_reason: call.status, duration_seconds: call.duration }),
      );
      return;
    }
    lifecycle.remember(info);
    const payload = callPayload("call_answered", info, { status: "answered", answerer_id: userId });
    await this.hub.send(info.callerId, payload);
    // Also the answerer: stops ringing on their other devices ("answered elsewhere").
    await this.hub.send(userId, payload);
  }

  // ------------------------------------------------------- reject / end

  async endCall(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    if (!pyBool(message.call_id)) {
      await this.error(userId, "Missing required fields: call_id");
      return;
    }
    const call = await this.lifecycle.loadCallFor(db, pyStr(message.call_id), userId);
    if (!call) {
      await this.error(userId, "Call not found", { call_id: message.call_id });
      return;
    }
    await this.lifecycle.finishCall(db, call, userId);
  }

  // ---------------------------------------------------------- signalling

  private async relaySdp(userId: string, message: Record<string, any>, db: Db, event: string): Promise<void> {
    if (!pyBool(message.call_id) || !pyBool(message.sdp)) {
      await this.error(userId, "Missing required fields: sdp, call_id");
      return;
    }
    const callId = pyStr(message.call_id);
    const sdp = message.sdp;
    const call = await this.lifecycle.loadCallFor(db, callId, userId);
    if (!call || !(ACTIVE_CALL_STATUSES as readonly string[]).includes(call.status)) {
      await this.error(userId, "No active call found.", { call_id: callId });
      return;
    }
    if (event === "sdp_offer" && userId === call.callerId) {
      // Kept so a receiver who connects later (e.g. from the push) still gets it.
      await this.lifecycle.service(db).saveOfferSdp(callId, JSON.stringify(sdp));
    }
    const other = call.otherParty(userId);
    if (other) await this.hub.send(other, { type: event, call_id: callId, from_user_id: userId, sdp, timestamp: nowIso() });
  }

  private async iceCandidate(userId: string, message: Record<string, any>, db: Db): Promise<void> {
    if (!pyBool(message.call_id) || !pyBool(message.candidate)) return;
    const callId = pyStr(message.call_id);
    let parties = this.lifecycle.parties.get(callId);
    if (!parties) {
      const call = await this.lifecycle.loadCallFor(db, callId, userId);
      if (!call) return;
      parties = [call.callerId, call.receiverId];
    }
    const [callerId, receiverId] = parties;
    if (!parties.includes(userId)) return;
    await this.hub.send(userId === callerId ? receiverId : callerId, {
      type: "ice_candidate",
      call_id: callId,
      from_user_id: userId,
      candidate: message.candidate,
      timestamp: nowIso(),
    });
  }
}
