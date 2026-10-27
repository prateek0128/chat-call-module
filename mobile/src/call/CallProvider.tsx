/**
 * CallProvider — binds a VoiceCallEngine to the CommsClient from <CommsProvider>.
 * Headless: it renders no UI. The host renders its own incoming / in-call / ended
 * screens from `useCall()`.
 *
 * App-specific concerns are kept out and exposed as hooks/adapters:
 * credit modals -> onCallError(err, retry); navigation -> onOpenChat(peerId);
 * native Android CallNotification -> CallNotifier adapter; InCallManager -> CallAudio adapter;
 * DeviceEventEmitter CALL_LOG_EVENT -> client.dispatchLocal({type:"call_log", local:true}).
 */
import React, { createContext, ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { authFetch } from "../core/config";
import { callLogText } from "../core/callLog";
import { useComms } from "../core/CommsProvider";
import type { UserId } from "../core/types";
import { CallAudio, CallNotifier, createInCallManagerAudio, NotificationAction, noopNotifier } from "./adapters";
import type {
  CallAttempt,
  CallEngineSnapshot,
  CallError,
  CallState,
  CallSummary,
  IceServersOption,
  StartCallOptions,
  WebRTCFactory,
} from "./types";
import { CALL_EVENT_TYPES, VoiceCallEngine } from "./VoiceCallEngine";
import { loadStreamWebRTC } from "./webrtc";

/** Retry the failed call; `extra` is merged into call_initiate (default `{credit_acknowledged: true}`). */
export type RetryCall = (extra?: Record<string, unknown>) => Promise<boolean>;

export interface CallContextValue {
  /** Peer name / avatar already resolved from the shared user directory. */
  state: CallState;
  startCall: (peerId: UserId, options?: StartCallOptions) => Promise<boolean>;
  accept: () => Promise<void>;
  reject: () => void;
  end: () => void;
  toggleMute: () => boolean;
  toggleSpeaker: () => boolean;
  isMuted: boolean;
  isSpeakerOn: boolean;
  localStream: CallEngineSnapshot["localStream"];
  remoteStream: CallEngineSnapshot["remoteStream"];
  /** Last finished call (for an "ended" screen: Message / Call again). */
  lastEnded: CallSummary | null;
  clearLastEnded: () => void;
  /** Calls `startCall` again with the last ended call's peer. */
  callAgain: () => Promise<boolean>;
  /** Calls `onOpenChat` with `peerId` (default: current / last peer). */
  openChat: (peerId?: UserId) => void;
  /** Feed notification buttons here (works before the call reached the app, e.g. cold start). */
  handleNotificationAction: (action: NotificationAction, callId: string) => void;
  engine: VoiceCallEngine;
  /**
   * Listen to call errors in addition to `onCallError` (used by commskit/call-ui to show
   * the failure reason). Returns an unsubscribe function. Added in 0.1.x; optional for
   * backwards compatibility with hand-built context values.
   */
  subscribeErrors?: (listener: CallErrorListener) => () => void;
}

/** Receives every call error (busy, microphone, policy, ...) and the attempt it belongs to. */
export type CallErrorListener = (error: CallError, attempt: CallAttempt | null) => void;

const CallContext = createContext<CallContextValue | null>(null);

export interface CallProviderProps {
  children?: ReactNode;
  /** Static list or async provider (see `turnCredentialsIceServers`). Default: public STUN only. */
  iceServers?: IceServersOption;
  /** Default: react-native-incall-manager (lazily required; no-op when missing). */
  audio?: CallAudio;
  /** Default: no-op. */
  notifier?: CallNotifier;
  /** Default: @stream-io/react-native-webrtc (lazily required). */
  webrtc?: WebRTCFactory | (() => WebRTCFactory | null);
  /**
   * Call failed / refused. For host-policy errors (`err.kind === "policy"`, e.g. paid credits 402/403;
   * credit info in `err.raw.info`) show your prompt and call `retry()` to place it again with
   * `{credit_acknowledged: true}` (or `retry({...})` with your own fields).
   */
  onCallError?: (error: CallError, retry: RetryCall) => void;
  onCallEnded?: (summary: CallSummary) => void;
  onIncomingCall?: (call: CallState) => void;
  /** "Message" from a call screen / ended screen. Navigate to your chat screen here. */
  onOpenChat?: (peerId: UserId) => void;
  /** Notification "open" action: bring your call screen to front. */
  onShowCall?: (call: CallState) => void;
  /**
   * Dispatch a local `call_log` when a call ends, so a mounted ChatProvider shows the
   * outcome before (or without) the server's call_log. Default true.
   */
  emitLocalCallLog?: boolean;
  /** Ask the server for the user list when an unknown caller rings (to learn the name). Default true. */
  requestUnknownCallerNames?: boolean;
  /** Bring your own engine (tests). */
  engine?: VoiceCallEngine;
}

export const CallProvider: React.FC<CallProviderProps> = (props) => {
  const { children, iceServers, audio, notifier = noopNotifier, webrtc, requestUnknownCallerNames = true } = props;
  const { client, users, config } = useComms();
  const propsRef = useRef(props);
  propsRef.current = props;

  const errorListenersRef = useRef<Set<CallErrorListener>>(new Set());
  const engineRef = useRef<VoiceCallEngine | null>(null);
  const retryRef = useRef<(attempt: CallAttempt | null) => RetryCall>(() => async () => false);
  if (!engineRef.current) {
    engineRef.current =
      props.engine ||
      new VoiceCallEngine({
        send: (type, payload) => client.send(type, payload),
        isConnected: () => client.isOpen,
        getUserId: () => client.userId,
        webrtc: webrtc || loadStreamWebRTC,
        iceServers,
        audio: audio || createInCallManagerAudio({ logger: config.logger }),
        logger: config.logger,
        onError: (error, attempt) => {
          errorListenersRef.current.forEach((listener) => {
            try {
              listener(error, attempt);
            } catch (e) {
              config.logger?.warn("call error listener failed", e);
            }
          });
          const handler = propsRef.current.onCallError;
          if (handler) handler(error, retryRef.current(attempt));
          else config.logger?.warn("call error", error);
        },
        onCallEnded: (summary) => {
          if (summary.callId && propsRef.current.emitLocalCallLog !== false && summary.endReason !== "answered_elsewhere") {
            client.dispatchLocal({
              type: "call_log",
              local: true,
              call_id: summary.callId,
              chat_id: summary.chatId ?? null,
              content: callLogText(summary.endReason === "ended" ? "connected" : summary.endReason, summary.durationSeconds, summary.callType),
              duration_seconds: summary.durationSeconds,
            });
          }
          propsRef.current.onCallEnded?.(summary);
        },
        onIncomingCall: (call) => propsRef.current.onIncomingCall?.(call),
      });
  }
  const engine = engineRef.current;

  // Keep adapters current if the host swaps them.
  useEffect(() => {
    if (audio) engine.setAudio(audio);
  }, [engine, audio]);
  useEffect(() => {
    engine.setIceServers(iceServers);
  }, [engine, iceServers]);

  const startCall = useCallback(
    (peerId: UserId, options?: StartCallOptions) => engine.startCall(peerId, options),
    [engine],
  );
  retryRef.current = (attempt) => (extra = { credit_acknowledged: true }) =>
    attempt
      ? engine.startCall(attempt.peerId, {
          chatId: attempt.chatId,
          peerName: attempt.peerName,
          callType: attempt.callType,
          extra: { ...(attempt.extra || {}), ...extra },
        })
      : Promise.resolve(false);

  // ---- socket wiring -----------------------------------------------------
  useEffect(() => {
    const offs = CALL_EVENT_TYPES.map((type) => client.on(type, (msg) => void engine.handle(msg)));
    // Shared directory: names from the user list and from incoming calls.
    offs.push(client.on("res_users", (msg) => Array.isArray(msg.users) && users.remember(msg.users)));
    offs.push(
      client.on("incoming_call", (msg) => {
        const callerId = msg.caller_id ? String(msg.caller_id) : undefined;
        if (!callerId) return;
        users.remember([{ user_id: callerId, username: msg.caller_name, avatar: msg.caller_avatar }]);
        // New chat partner not in our list yet: ask for it so we can show a name.
        if (requestUnknownCallerNames && !users.getName(callerId)) client.send("req_users", {});
      }),
    );
    return () => offs.forEach((off) => off());
  }, [client, engine, users, requestUnknownCallerNames]);

  useEffect(() => () => engine.dispose(), [engine]);

  // ---- state -------------------------------------------------------------
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  useSyncExternalStore(users.subscribe, users.getVersion, users.getVersion);

  const raw = snap.call;
  const state = useMemo<CallState>(() => {
    if (!raw.isActive) return raw;
    const peerName = users.getName(raw.peerId) || raw.peerName;
    const peerAvatar = users.getAvatar(raw.peerId) || raw.peerAvatar;
    return peerName === raw.peerName && peerAvatar === raw.peerAvatar ? raw : { ...raw, peerName, peerAvatar };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, users, users.getVersion()]);

  // ---- app state (foreground) -------------------------------------------
  const [appActive, setAppActive] = useState(AppState.currentState === "active" || AppState.currentState == null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);

  // ---- notifier: ringing in background, ongoing call ---------------------
  const isRinging = state.isIncoming && state.status === "ringing";
  const ringingCallId = isRinging ? state.callId : undefined;
  const shownRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownRef.current;
    if (previous && previous !== ringingCallId) {
      void notifier.dismiss(previous); // answered / ended / timed out
      shownRef.current = null;
    }
    if (!ringingCallId) {
      void notifier.dismiss(); // leftovers (e.g. push for a call that already ended)
      return;
    }
    if (appActive) {
      // The in-app ringing screen is visible: no system notification.
      void notifier.dismiss(ringingCallId);
      shownRef.current = null;
    } else {
      shownRef.current = ringingCallId;
      void notifier.showIncoming({
        callId: ringingCallId,
        peerId: state.peerId,
        peerName: state.peerName,
        peerAvatar: state.peerAvatar,
        callType: state.callType,
      });
    }
  }, [notifier, ringingCallId, appActive, state.peerName]);

  const ongoingCallId = state.isActive && state.status === "connected" ? state.callId : undefined;
  useEffect(() => {
    if (!ongoingCallId) return;
    const s = engine.state;
    void notifier.startOngoing({
      callId: ongoingCallId,
      peerId: s.peerId,
      peerName: users.getName(s.peerId) || s.peerName,
      peerAvatar: users.getAvatar(s.peerId) || s.peerAvatar,
      connectedAt: s.connectedAt || Date.now(),
    });
    return () => void notifier.stopOngoing();
  }, [engine, notifier, users, ongoingCallId]);

  // ---- notification actions ---------------------------------------------
  // "Answer" tapped before the call reached this app instance (cold start):
  // accept as soon as it rings here.
  const pendingAnswerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isRinging || !state.callId || pendingAnswerRef.current !== state.callId) return;
    pendingAnswerRef.current = null;
    void engine.accept();
  }, [engine, isRinging, state.callId]);

  const handleNotificationAction = useCallback(
    (action: NotificationAction, callId: string) => {
      const current = engine.state.callId;
      // The mic can only be opened in the foreground.
      const whenActive = (run: () => void) => {
        if (AppState.currentState === "active") return run();
        const sub = AppState.addEventListener("change", (s) => {
          if (s === "active") {
            sub.remove();
            run();
          }
        });
        setTimeout(() => sub.remove(), 10000);
      };
      switch (action) {
        case "answer":
          if (callId !== current) {
            pendingAnswerRef.current = callId;
            return;
          }
          whenActive(() => void engine.accept());
          return;
        case "decline":
          if (callId === current) engine.reject();
          else
            // App not connected yet: decline over REST (PROTOCOL §4).
            void authFetch(config, `/call/${encodeURIComponent(callId)}/reject`, { method: "POST" }).catch((e) =>
              config.logger?.warn("REST reject failed", e),
            );
          return;
        case "hangup":
          if (callId === current) engine.end();
          return;
        case "open":
          if (callId === current) propsRef.current.onShowCall?.(engine.state);
          return;
      }
    },
    [engine, config],
  );

  const openChat = useCallback(
    (peerId?: UserId) => {
      const target = peerId || engine.state.peerId || engine.getSnapshot().lastEnded?.peerId;
      if (target) propsRef.current.onOpenChat?.(target);
    },
    [engine],
  );

  const callAgain = useCallback(async () => {
    const last = engine.getSnapshot().lastEnded;
    engine.clearLastEnded();
    if (!last?.peerId) return false;
    const attempt = engine.lastCallAttempt;
    const same = attempt?.peerId === last.peerId;
    return engine.startCall(last.peerId, {
      chatId: same ? attempt?.chatId : last.chatId,
      peerName: users.getName(last.peerId) || last.peerName,
      callType: last.callType,
    });
  }, [engine, users]);

  const subscribeErrors = useCallback((listener: CallErrorListener) => {
    errorListenersRef.current.add(listener);
    return () => {
      errorListenersRef.current.delete(listener);
    };
  }, []);

  const value = useMemo<CallContextValue>(
    () => ({
      state,
      startCall,
      accept: () => engine.accept(),
      reject: () => engine.reject(),
      end: () => engine.end(),
      toggleMute: () => engine.toggleMute(),
      toggleSpeaker: () => engine.toggleSpeaker(),
      isMuted: snap.isMuted,
      isSpeakerOn: snap.isSpeakerOn,
      localStream: snap.localStream,
      remoteStream: snap.remoteStream,
      lastEnded: snap.lastEnded,
      clearLastEnded: () => engine.clearLastEnded(),
      callAgain,
      openChat,
      handleNotificationAction,
      engine,
      subscribeErrors,
    }),
    [state, snap, startCall, engine, callAgain, openChat, handleNotificationAction, subscribeErrors],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
};

export const useCallContext = (): CallContextValue => {
  const ctx = React.useContext(CallContext);
  if (!ctx) throw new Error("[comms] useCall() must be used inside <CallProvider>");
  return ctx;
};
