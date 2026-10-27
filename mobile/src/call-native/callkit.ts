/**
 * iOS CallKit notifier (react-native-callkeep, optional peer — lazily required only here).
 *
 * - showIncoming  -> displayIncomingCall (skipped when the call was already reported natively
 *                    from the VoIP push in AppDelegate, see app.plugin.js)
 * - startOngoing  -> setCurrentCallActive (answered in CallKit) or startCall + reportConnected
 * - stopOngoing   -> endCall;  dismiss -> reportEndCallWithUUID for a call that stopped ringing
 * - CallKit answer / end / mute and the audio-session activation come back as actions
 *   (answer is delivered once iOS activated the audio session, or after a short timeout).
 */
import type { Logger } from "../core/config";
import type { IncomingCallInfo, OngoingCallInfo } from "../call/adapters";
import { createActionQueue, type NativeCallNotifier } from "./types";
import { callKitUuid } from "./uuid";

export const loadCallKeep = (): any => {
  try {
    const mod = require("react-native-callkeep");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
};

export interface CallKitNotifierOptions {
  /** Shown by CallKit ("<appName> Audio"). */
  appName: string;
  supportsVideo?: boolean;
  /** Recents integration (default true). */
  includesCallsInRecents?: boolean;
  /** Ringtone file in the app bundle (default: system ringtone). */
  ringtoneSound?: string;
  /** Template image (PNG in the bundle) for the CallKit button. */
  imageName?: string;
  /** Call RNCallKeep.setup (default true). Set false if your app already did. */
  setup?: boolean;
  /**
   * A call reported from a VoIP push stops ringing after this long when the app never saw it
   * (e.g. the caller hung up before the socket reconnected). Default 45 s (server ring timeout).
   */
  ringTimeoutMs?: number;
  /** Deliver "answer" at the latest this long after the CallKit answer if no audio-session event came (default 1500 ms). */
  answerAudioTimeoutMs?: number;
  /** Inject the module (tests). Default: require("react-native-callkeep"). */
  callKeep?: any;
  logger?: Logger;
}

/** CallKeep end reasons (CXCallEndedReason + 1). */
export const CALLKEEP_END_REASON = { failed: 1, remoteEnded: 2, unanswered: 3, answeredElsewhere: 4, declinedElsewhere: 5, missed: 6 } as const;

type Entry = { callId: string; state: "ringing" | "answered" | "active"; fromPush?: boolean; timer?: any };

const EVENTS = ["answerCall", "endCall", "didPerformSetMutedCallAction", "didActivateAudioSession", "didDeactivateAudioSession", "didDisplayIncomingCall"] as const;

const INITIAL_EVENT_NAMES: Record<string, (typeof EVENTS)[number]> = {
  RNCallKeepPerformAnswerCallAction: "answerCall",
  RNCallKeepPerformEndCallAction: "endCall",
  RNCallKeepDidPerformSetMutedCallAction: "didPerformSetMutedCallAction",
  RNCallKeepDidActivateAudioSession: "didActivateAudioSession",
  RNCallKeepDidDisplayIncomingCall: "didDisplayIncomingCall",
};

export interface CallKitNotifier extends NativeCallNotifier {
  /** Map a push payload / call id to its CallKit UUID (VoIP pushes carry `uuid`). */
  rememberCall(callId: string, uuid?: string): void;
  uuidFor(callId: string): string;
}

export const createCallKitNotifier = (options: CallKitNotifierOptions): CallKitNotifier => {
  const CK = options.callKeep || loadCallKeep();
  if (!CK) throw new Error("[comms] createCallKitNotifier needs react-native-callkeep: npx expo install react-native-callkeep");
  const log = options.logger;
  const answerTimeout = options.answerAudioTimeoutMs ?? 1500;
  const ringTimeout = options.ringTimeoutMs ?? 45000;
  const actions = createActionQueue();
  const entries = new Map<string, Entry>(); // uuid (lower case) -> entry
  const uuids = new Map<string, string>(); // callId -> uuid
  const endedByUs = new Set<string>();
  const mutedByUs = new Map<string, boolean>();
  let audioActive = false;
  let pendingAnswer: { callId: string; timer: any } | null = null;

  const safe = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log?.warn(`CallKeep ${what} failed`, e);
    }
  };
  const norm = (uuid: unknown) => String(uuid || "").toLowerCase();
  const uuidFor = (callId: string) => uuids.get(callId) || callKitUuid(callId);
  const setEntry = (uuid: string, entry: Entry) => {
    const prev = entries.get(uuid);
    if (prev?.timer && prev.timer !== entry.timer) clearTimeout(prev.timer);
    entries.set(uuid, entry);
  };
  const removeEntry = (uuid: string) => {
    const prev = entries.get(uuid);
    if (prev?.timer) clearTimeout(prev.timer);
    entries.delete(uuid);
  };
  /** Known call. `fromPush`: reported natively from a VoIP push (ends itself after the ring timeout). */
  const rememberCall = (callId: string, uuid?: string, fromPush = true) => {
    const u = norm(uuid || callKitUuid(callId));
    uuids.set(callId, u);
    if (entries.has(u)) return;
    const timer = fromPush
      ? setTimeout(() => {
          if (entries.get(u)?.state !== "ringing") return;
          removeEntry(u);
          safe("reportEndCallWithUUID", () => CK.reportEndCallWithUUID(u, CALLKEEP_END_REASON.unanswered));
        }, ringTimeout)
      : undefined;
    setEntry(u, { callId, state: "ringing", fromPush, timer });
  };
  const callIdFor = (uuid: string): string | null => {
    const e = entries.get(uuid);
    if (e) return e.callId;
    for (const [callId, u] of uuids) if (u === uuid) return callId;
    return null;
  };

  if (options.setup !== false) {
    safe("setup", () =>
      void Promise.resolve(
        CK.setup({
          ios: {
            appName: options.appName,
            supportsVideo: !!options.supportsVideo,
            maximumCallGroups: "1",
            maximumCallsPerCallGroup: "1",
            includesCallsInRecents: options.includesCallsInRecents !== false,
            ...(options.ringtoneSound ? { ringtoneSound: options.ringtoneSound } : {}),
            ...(options.imageName ? { imageName: options.imageName } : {}),
          },
          android: { alertTitle: "Permissions required", alertDescription: "This app needs to access your phone accounts", cancelButton: "Cancel", okButton: "OK", additionalPermissions: [] },
        }),
      ).catch((e: unknown) => log?.warn("CallKeep setup failed", e)),
    );
  }

  const deliverAnswer = () => {
    if (!pendingAnswer) return;
    clearTimeout(pendingAnswer.timer);
    const { callId } = pendingAnswer;
    pendingAnswer = null;
    actions.emit("answer", callId);
  };

  const handlers: Record<(typeof EVENTS)[number], (data: any) => void> = {
    answerCall: ({ callUUID }) => {
      const uuid = norm(callUUID);
      const callId = callIdFor(uuid);
      if (!callId) return log?.warn("CallKit answer for unknown call", callUUID);
      setEntry(uuid, { callId, state: "answered" });
      if (pendingAnswer) clearTimeout(pendingAnswer.timer);
      pendingAnswer = { callId, timer: setTimeout(deliverAnswer, answerTimeout) };
      if (audioActive) deliverAnswer();
    },
    endCall: ({ callUUID }) => {
      const uuid = norm(callUUID);
      if (endedByUs.delete(uuid)) return; // our own endCall() transaction
      const entry = entries.get(uuid);
      const callId = entry?.callId || callIdFor(uuid);
      removeEntry(uuid);
      if (!callId) return;
      if (pendingAnswer?.callId === callId) {
        clearTimeout(pendingAnswer.timer);
        pendingAnswer = null;
      }
      actions.emit(entry && entry.state !== "ringing" ? "hangup" : "decline", callId);
    },
    didPerformSetMutedCallAction: ({ muted, callUUID }) => {
      const uuid = norm(callUUID);
      if (mutedByUs.has(uuid) && mutedByUs.get(uuid) === !!muted) {
        mutedByUs.delete(uuid);
        return;
      }
      const callId = callIdFor(uuid);
      if (callId) actions.emit(muted ? "mute" : "unmute", callId);
    },
    didActivateAudioSession: () => {
      audioActive = true;
      deliverAnswer();
    },
    didDeactivateAudioSession: () => {
      audioActive = false;
    },
    didDisplayIncomingCall: ({ callUUID, payload, error }) => {
      if (error) return log?.warn("CallKit could not display the call", error);
      const callId = payload?.call_id ?? payload?.data?.call_id;
      if (callId) rememberCall(String(callId), callUUID);
    },
  };

  for (const name of EVENTS) safe(`addEventListener(${name})`, () => CK.addEventListener(name, handlers[name]));

  // Cold start: events CallKit delivered before JS was listening.
  safe("getInitialEvents", () => {
    const initial = CK.getInitialEvents?.();
    void Promise.resolve(initial)
      .then((events: any) => {
        if (!Array.isArray(events)) return;
        for (const ev of events) {
          const name = INITIAL_EVENT_NAMES[ev?.name] || (EVENTS as readonly string[]).find((n) => n === ev?.name);
          if (name) handlers[name as (typeof EVENTS)[number]](ev.data || {});
        }
        CK.clearInitialEvents?.();
      })
      .catch(() => {});
  });

  const endRinging = (uuid: string) => {
    removeEntry(uuid);
    safe("reportEndCallWithUUID", () => CK.reportEndCallWithUUID(uuid, CALLKEEP_END_REASON.remoteEnded));
  };

  return {
    kind: "callkit",
    rememberCall,
    uuidFor,
    setActionHandler: (handler) => actions.set(handler),
    showIncoming: (call: IncomingCallInfo) => {
      const uuid = uuidFor(call.callId);
      if (entries.has(uuid)) return; // already reported (VoIP push / earlier show)
      rememberCall(call.callId, uuid, false);
      const handle = String(call.peerId || call.peerName || "Unknown");
      safe("displayIncomingCall", () => CK.displayIncomingCall(uuid, handle, call.peerName || handle, "generic", call.callType === "video"));
    },
    dismiss: (callId?: string) => {
      if (callId) {
        const uuid = uuidFor(callId);
        if (entries.get(uuid)?.state === "ringing") endRinging(uuid);
        return;
      }
      // Leftovers shown by the app. Calls reported from a VoIP push are kept: the socket may not
      // have delivered them yet (cold start); they end with dismiss(callId) or the ring timeout.
      for (const [uuid, e] of Array.from(entries)) if (e.state === "ringing" && !e.fromPush) endRinging(uuid);
    },
    startOngoing: (call: OngoingCallInfo) => {
      const uuid = uuidFor(call.callId);
      const entry = entries.get(uuid);
      if (entry && entry.state !== "ringing") {
        safe("setCurrentCallActive", () => CK.setCurrentCallActive?.(uuid));
      } else {
        // Outgoing call, or answered in the app: register it with CallKit for the system UI.
        const handle = String(call.peerId || call.peerName || "Unknown");
        safe("startCall", () => CK.startCall(uuid, handle, call.peerName || handle, "generic", false));
        safe("reportConnectedOutgoingCallWithUUID", () => CK.reportConnectedOutgoingCallWithUUID?.(uuid));
      }
      uuids.set(call.callId, uuid);
      setEntry(uuid, { callId: call.callId, state: "active" });
    },
    stopOngoing: () => {
      for (const [uuid, e] of Array.from(entries)) {
        if (e.state === "ringing") continue;
        removeEntry(uuid);
        endedByUs.add(uuid);
        safe("endCall", () => CK.endCall(uuid));
      }
    },
    setMuted: (callId: string, muted: boolean) => {
      const uuid = uuidFor(callId);
      if (!entries.has(uuid) || entries.get(uuid)?.state === "ringing") return;
      mutedByUs.set(uuid, muted);
      safe("setMutedCall", () => CK.setMutedCall(uuid, muted));
    },
    dispose: () => {
      if (pendingAnswer) clearTimeout(pendingAnswer.timer);
      for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
      for (const name of EVENTS) safe(`removeEventListener(${name})`, () => CK.removeEventListener(name));
    },
  };
};
