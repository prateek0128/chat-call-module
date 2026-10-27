import { useCallContext, type CallContextValue } from "./CallProvider";

/**
 * Current call + controls:
 * `{state, startCall(peerId, {chatId?, peerName?, extra?}), accept, reject, end,
 *   toggleMute, toggleSpeaker, isMuted, isSpeakerOn, localStream, remoteStream,
 *   lastEnded, callAgain, openChat, handleNotificationAction}`
 */
export const useCall = (): CallContextValue => useCallContext();
