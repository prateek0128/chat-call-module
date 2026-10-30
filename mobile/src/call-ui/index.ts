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

// Built-in implementations, for host replacements that wrap them.
export { DefaultCallBackground } from "./CallBackground";
export { DefaultCallButton } from "./CallButton";
export { DefaultCallControls } from "./CallControls";
export { DefaultCallOverlay } from "./CallOverlay";
export { DefaultCallScreen } from "./CallScreen";
export { DefaultPulseAvatar } from "./PulseAvatar";
export { DefaultReturnToCallPill } from "./ReturnToCallPill";

import type { ComponentProps, ComponentType } from "react";
import type { CallBackground } from "./CallBackground";
import type { CallButton } from "./CallButton";
import type { CallControls } from "./CallControls";
import type { CallOverlay } from "./CallOverlay";
import type { CallScreen } from "./CallScreen";
import type { PulseAvatar } from "./PulseAvatar";
import type { ReturnToCallPill } from "./ReturnToCallPill";

/** Every call-ui component a host can replace (`satisfies CallUiSlots` on your `components` object). */
export interface CallUiSlots {
  CallBackground?: ComponentType<ComponentProps<typeof CallBackground>>;
  CallButton?: ComponentType<ComponentProps<typeof CallButton>>;
  CallControls?: ComponentType<ComponentProps<typeof CallControls>>;
  CallOverlay?: ComponentType<ComponentProps<typeof CallOverlay>>;
  CallScreen?: ComponentType<ComponentProps<typeof CallScreen>>;
  PulseAvatar?: ComponentType<ComponentProps<typeof PulseAvatar>>;
  ReturnToCallPill?: ComponentType<ComponentProps<typeof ReturnToCallPill>>;
}
