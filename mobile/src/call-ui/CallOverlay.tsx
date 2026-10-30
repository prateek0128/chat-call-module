/**
 * CallOverlay — drop-in call UI. Render it once inside <CallProvider>, after your navigator.
 * It reads useCall(), shows CallScreen as a full-screen Modal while a call is active (and
 * the ended / failed screen afterwards), and supports minimising to a "Return to call" pill.
 */
import { slot } from "../theme";
import { memo, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { useComms } from "../core";
import { useCall } from "../call";
import type { CallAttempt, CallError, CallSummary } from "../call/types";
import { useOptionalBlocking } from "../moderation/hooks";
import { useReducedMotion, useSafeInsets, type EdgeInsets } from "../theme";
import { CallScreen } from "./CallScreen";
import { mapEndedCall, mapLiveCall, type CallScreenModel } from "./callScreenState";
import { ReturnToCallPill } from "./ReturnToCallPill";

export interface CallOverlayProps {
  /**
   * "Message" on ended / failed screens. Default: `useCall().openChat(peerId)`, which calls
   * CallProvider's `onOpenChat`. The button shows when this prop is set or `showMessageAction`.
   */
  onOpenChat?: (peerId: string) => void;
  /** Show "Message" while relying on CallProvider.onOpenChat (default: !!onOpenChat). */
  showMessageAction?: boolean;
  /** The platform can switch audio output (InCallManager installed). Default true. */
  speakerAvailable?: boolean;
  /** Allow minimising to the Return-to-call pill (native back / minimise button). Default true. */
  allowMinimise?: boolean;
  /** Where the pill floats while minimised. Default "top". "none": render <ReturnToCallPill> yourself via `onMinimisedChange`. */
  pillPlacement?: "top" | "bottom" | "none";
  /** Extra distance from the safe-area edge for the pill (e.g. your header height). */
  pillOffset?: number;
  /** Replace the default gradient (render absolute-fill). */
  renderBackground?: () => ReactNode;
  insets?: Partial<EdgeInsets>;
  /** The full-screen call UI became visible / hidden (e.g. switch your StatusBar to light content). */
  onVisibleChange?: (visible: boolean) => void;
  /** The call was minimised / restored. */
  onMinimisedChange?: (minimised: boolean) => void;
}

interface PendingError {
  error: CallError;
  attempt: CallAttempt | null;
  /** Call that was on screen when the error was reported. */
  callId?: string;
}

export const DefaultCallOverlay = memo(function CallOverlay({
  onOpenChat,
  showMessageAction,
  speakerAvailable = true,
  allowMinimise = true,
  pillPlacement = "top",
  pillOffset = 0,
  renderBackground,
  insets,
  onVisibleChange,
  onMinimisedChange,
}: CallOverlayProps) {
  const call = useCall();
  const { client, users } = useComms();
  const reduced = useReducedMotion();
  const safe = useSafeInsets(insets);
  const { state, lastEnded, engine } = call;
  const canOpenChat = showMessageAction ?? !!onOpenChat;
  // Moderation (optional <ModerationProvider>): no "Call again" for a blocked pair.
  const blocking = useOptionalBlocking();

  const [accepted, setAccepted] = useState(false);
  const [ringingFor, setRingingFor] = useState<string | null>(null);
  const [minimised, setMinimised] = useState(false);
  const [outcome, setOutcome] = useState<{ model: CallScreenModel; summary: CallSummary | null } | null>(null);

  // ---- remember peer details while live (for the ended screen) ----------------------
  const lastPeerRef = useRef<{ avatar?: string; name?: string }>({});
  if (state.isActive) lastPeerRef.current = { avatar: state.peerAvatar, name: state.peerName };

  // ---- "Ringing…" once call_ringing arrives for our outgoing call ---------------------
  useEffect(() => client.on("call_ringing", (msg: { call_id?: unknown }) => msg.call_id != null && setRingingFor(String(msg.call_id))), [client]);

  // ---- new call: reset local flags -------------------------------------------------------
  useEffect(() => {
    setAccepted(false);
    if (state.isActive) {
      setOutcome(null);
      setMinimised(false);
    }
  }, [state.callId, state.isActive]);

  // ---- end summaries + errors -> ended / failed screen -----------------------------
  const pendingErrorRef = useRef<PendingError | null>(null);
  const handledSummaryRef = useRef<CallSummary | null>(lastEnded);
  const minimisedRef = useRef(minimised);
  minimisedRef.current = minimised;

  const show = useCallback((model: CallScreenModel | null, summary: CallSummary | null) => {
    if (!model) return setOutcome(null);
    // A plain "Call ended" while minimised needs no attention; failures do.
    if (minimisedRef.current && model.phase === "ended") {
      setMinimised(false);
      return setOutcome(null);
    }
    setMinimised(false);
    setOutcome({ model, summary });
  }, []);

  useEffect(() => {
    if (!call.subscribeErrors) return;
    return call.subscribeErrors((error, attempt) => {
      // Placing a second call while one is active: the current call screen stays as is.
      if (error.kind === "already_in_call") return;
      if (engine.state.isActive) {
        // The engine ends the call right after reporting: the summary effect picks this up.
        pendingErrorRef.current = { error, attempt, callId: engine.state.callId };
        return;
      }
      // No call on screen (startCall refused: microphone, busy, offline, ...).
      const peerId = error.peerId || attempt?.peerId;
      show(
        mapEndedCall({
          summary: null,
          error: { ...error, peerId },
          peerName: attempt?.peerName || users.getName(peerId) || undefined,
          peerAvatar: users.getAvatar(peerId) || undefined,
          canOpenChat,
        }),
        null,
      );
    });
  }, [call.subscribeErrors, engine, users, show, canOpenChat]);

  useEffect(() => {
    if (!lastEnded || lastEnded === handledSummaryRef.current) return;
    handledSummaryRef.current = lastEnded;
    const stored = pendingErrorRef.current;
    pendingErrorRef.current = null;
    const pending = stored && (!stored.callId || !lastEnded.callId || stored.callId === lastEnded.callId) ? stored : null;
    show(
      mapEndedCall({
        summary: lastEnded,
        error: pending ? pending.error : null,
        peerName: lastPeerRef.current.name,
        peerAvatar: lastPeerRef.current.avatar,
        canOpenChat,
      }),
      lastEnded,
    );
  }, [lastEnded, show, canOpenChat]);

  // ---- auto-dismiss the ended summary ------------------------------------------------
  const close = useCallback(() => {
    setOutcome(null);
    call.clearLastEnded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.clearLastEnded]);
  useEffect(() => {
    const ms = outcome?.model.autoDismissMs;
    if (!ms) return;
    const t = setTimeout(close, ms);
    return () => clearTimeout(t);
  }, [outcome, close]);

  // ---- current screen ----------------------------------------------------------------
  const live = useMemo(
    () => mapLiveCall({ call: state, accepted, ringingReceived: !!state.callId && ringingFor === state.callId, speakerAvailable }),
    [state, accepted, ringingFor, speakerAvailable],
  );
  const model = live || outcome?.model || null;
  const visible = !!model && !(live && minimised);

  const visibleRef = useRef(false);
  useEffect(() => {
    if (visibleRef.current === visible) return;
    visibleRef.current = visible;
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);
  useEffect(() => onMinimisedChange?.(minimised && !!live), [minimised, live, onMinimisedChange]);

  // ---- actions ---------------------------------------------------------------------
  const accept = useCallback(() => {
    setAccepted(true);
    void call.accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.accept]);
  const minimise = useCallback(() => setMinimised(true), []);
  const callAgain = useCallback(() => {
    const current = outcome;
    setOutcome(null);
    if (current?.summary && lastEnded === current.summary) {
      void call.callAgain();
    } else if (current?.model.peerId) {
      call.clearLastEnded();
      void call.startCall(current.model.peerId, { peerName: current.model.peerName });
    }
  }, [outcome, lastEnded, call]);
  const message = useCallback(() => {
    const peerId = outcome?.model.peerId;
    close();
    if (!peerId) return;
    if (onOpenChat) onOpenChat(peerId);
    else call.openChat(peerId);
  }, [outcome, close, onOpenChat, call]);

  const onRequestClose = useCallback(() => {
    if (!model) return;
    if (live) {
      if (allowMinimise && model.canMinimise) setMinimised(true);
      return; // incoming: decline / accept explicitly
    }
    close();
  }, [model, live, allowMinimise, close]);

  const pill =
    live && minimised && pillPlacement !== "none" ? (
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          zIndex: 1000,
          elevation: 1000,
          ...(pillPlacement === "top" ? { top: safe.top + pillOffset + 8 } : { bottom: safe.bottom + pillOffset + 8 }),
        }}
      >
        <ReturnToCallPill
          onPress={() => setMinimised(false)}
          peerName={live.peerName}
          connectedAt={state.status === "connected" ? state.connectedAt : null}
          status={live.status}
        />
      </View>
    ) : null;

  if (!model) return null;
  return (
    <>
      {pill}
      <Modal
        visible={visible}
        animationType={reduced ? "none" : "fade"}
        presentationStyle="overFullScreen"
        transparent
        statusBarTranslucent
        onRequestClose={onRequestClose}
        supportedOrientations={["portrait", "landscape"]}
      >
        <CallScreen
          model={model}
          connectedAt={state.connectedAt}
          isMuted={call.isMuted}
          isSpeakerOn={call.isSpeakerOn}
          onAccept={accept}
          onDecline={call.reject}
          onHangup={call.end}
          onToggleMute={call.toggleMute}
          onToggleSpeaker={speakerAvailable ? call.toggleSpeaker : undefined}
          onClose={close}
          onCallAgain={blocking?.isBlockedPair(model.peerId) ? undefined : callAgain}
          onMessage={canOpenChat ? message : undefined}
          onMinimise={allowMinimise ? minimise : undefined}
          insets={insets}
          renderBackground={renderBackground}
        />
      </Modal>
    </>
  );
});

// Host-replaceable (see theme/slots.tsx): the exported name renders `components.<Name>` when given, else the Default one.
export const CallOverlay = slot("CallOverlay", DefaultCallOverlay);
