/**
 * commskit/call-ui — themeable React Native call screens on top of commskit/call.
 * Imports theme, core and call only. Never imports chat or chat-ui: "Message" goes through
 * `onOpenChat` (CallOverlay prop or CallProvider.onOpenChat).
 */

export { CallOverlay, type CallOverlayProps } from "./CallOverlay";
export { CallScreen, type CallScreenProps } from "./CallScreen";
export { CallControls, type CallControlsProps } from "./CallControls";
export { CallButton, type CallButtonProps, type CallButtonVariant } from "./CallButton";
export { PulseAvatar, type PulseAvatarProps } from "./PulseAvatar";
export { ReturnToCallPill, type ReturnToCallPillProps } from "./ReturnToCallPill";
export { CallBackground, type CallBackgroundProps } from "./CallBackground";
export { useCallTimer } from "./hooks";
export {
  controlCaption,
  controlLabel,
  ENDED_AUTO_DISMISS_MS,
  failureCopy,
  mapEndedCall,
  mapLiveCall,
  type CallControlId,
  type CallScreenModel,
  type CallScreenPhase,
  type EndedCallInput,
  type FailureCopy,
  type LiveCallInput,
} from "./callScreenState";
