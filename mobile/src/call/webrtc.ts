/**
 * Default WebRTC factory: lazily requires @stream-io/react-native-webrtc (optional peer
 * dependency). Returns null when it is not installed, so the engine reports
 * `{kind:"unavailable"}` instead of crashing.
 */
import type { WebRTCFactory } from "./types";

let cached: WebRTCFactory | null | undefined;

export const loadStreamWebRTC = (): WebRTCFactory | null => {
  if (cached !== undefined) return cached;
  let webrtc: any;
  try {
    webrtc = require("@stream-io/react-native-webrtc");
  } catch {
    webrtc = null;
  }
  if (!webrtc?.RTCPeerConnection || !webrtc?.mediaDevices) {
    cached = null;
    return cached;
  }
  cached = {
    createPeerConnection: (configuration) => new webrtc.RTCPeerConnection(configuration),
    getUserMedia: (constraints) => webrtc.mediaDevices.getUserMedia(constraints),
    sessionDescription: (init) => new webrtc.RTCSessionDescription(init),
    iceCandidate: (init) => new webrtc.RTCIceCandidate(init),
  };
  return cached;
};
