/** CallConfig: timings (seconds), push channels and TURN settings (port of commskit.call.config). */
import { RateLimit } from "../core/ratelimit.js";

export interface CallConfig {
  ringTimeout: number; // ringing -> missed (no_answer)
  ringingDisconnectGrace: number; // socket loss while ringing -> missed (disconnected)
  answeredDisconnectGrace: number; // socket loss while answered -> ended (disconnected)
  maxCallHours: number; // answered calls older than this no longer count as live
  ringWindowSlack: number; // extra seconds a ringing row still counts as live
  ringtoneChannel: string; // Android channel for incoming-call pushes
  missedChannel: string;
  /** coturn REST-API credentials; the route answers 503 while turnSecret is unset. */
  turnSecret: string | null;
  turnUris: string[];
  turnTtl: number;
  /** call_initiate per caller (PROTOCOL.md section 9 "Limits"); null disables it. */
  initiateRate: RateLimit | null;
}

export const defaultCallConfig = (): CallConfig => ({
  ringTimeout: 45,
  ringingDisconnectGrace: 20,
  answeredDisconnectGrace: 90,
  maxCallHours: 4,
  ringWindowSlack: 15,
  ringtoneChannel: "call_ringtone",
  missedChannel: "messages",
  turnSecret: null,
  turnUris: [],
  turnTtl: 3600,
  initiateRate: new RateLimit(5, 60),
});
