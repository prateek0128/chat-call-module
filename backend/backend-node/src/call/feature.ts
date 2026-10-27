/** `hub.install(new CallFeature({...}))` (port of commskit.call.feature). */
import type { CommsHub, Feature } from "../core/hub.js";
import type { CallChatBridge } from "./bridge.js";
import { type CallConfig, defaultCallConfig } from "./config.js";
import { CallHandlers } from "./handlers.js";
import { CallLifecycle } from "./lifecycle.js";
import { AllowAllCallPolicy, type CallPolicy } from "./policy.js";
import { buildCallRoutes } from "./router.js";
import type { CallInfo } from "./service.js";

export interface CallFeatureOptions {
  policy?: CallPolicy;
  config?: Partial<CallConfig>;
}

/**
 * P2P WebRTC call signalling. Works standalone (chat_id null, no call_log); `linkChatAndCall` (integration)
 * sets `chatBridge`.
 */
export class CallFeature implements Feature {
  readonly name = "call";
  policy: CallPolicy;
  config: CallConfig;
  chatBridge: CallChatBridge | null = null;
  lifecycle!: CallLifecycle;
  handlers!: CallHandlers;
  private _hub: CommsHub | null = null;

  constructor(opts: CallFeatureOptions = {}) {
    this.policy = opts.policy ?? new AllowAllCallPolicy();
    this.config = { ...defaultCallConfig(), ...(opts.config ?? {}) };
  }

  get hub(): CommsHub {
    if (!this._hub) throw new Error("CallFeature is not installed; call hub.install(feature) first");
    return this._hub;
  }

  install(hub: CommsHub): this {
    hub.registerFeature(this.name, this);
    this._hub = hub;
    this.lifecycle = new CallLifecycle(this);
    this.handlers = new CallHandlers(this);
    this.handlers.register();
    hub.onConnect((uid, ws) => this.lifecycle.onConnect(uid, ws));
    hub.onDisconnect((uid) => this.lifecycle.endCallsAfterDisconnect(uid));
    hub.includeRoutes(buildCallRoutes(this));
    // Pending ring / grace timers must not outlive the hub.
    const shutdown = hub.shutdown.bind(hub);
    hub.shutdown = async () => {
      this.lifecycle.cancelAll();
      await shutdown();
    };
    return this;
  }

  /** End every live call between two users (e.g. on block). Both get `call_ended`; `call.finalized` is emitted. */
  endCallsBetween(userA: string, userB: string, endReason: string, endedBy: string | null = null): Promise<CallInfo[]> {
    return this.lifecycle.endCallsBetween(userA, userB, endReason, endedBy);
  }

  /**
   * Account deletion: remove every calls row where the user is caller or receiver. Live calls are not
   * signalled; disconnect the user first (or end their calls) if needed.
   */
  async deleteUserData(userId: string): Promise<{ calls: number }> {
    const uid = String(userId);
    const res = await this.hub.db
      .deleteFrom("calls")
      .where((eb: any) => eb.or([eb("caller_id", "=", uid), eb("receiver_id", "=", uid)]))
      .executeTakeFirst();
    return { calls: Number(res.numDeletedRows) };
  }
}
