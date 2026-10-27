/**
 * commskit/call-native with mocked native libs (injected): CallKit notifier, VoIP push, notifee
 * notifier, background handler (decline while killed), UUIDv5, platform pick and the React glue.
 */
import { act } from "react";
import TestRenderer from "react-test-renderer";

const mockCall: any = {
  state: { callId: "c1", status: "ringing" },
  isMuted: false,
  accept: jest.fn(async () => {}),
  toggleMute: jest.fn(() => true),
  handleNotificationAction: jest.fn(),
};
jest.mock("../src/call/hooks", () => ({ useCall: () => mockCall }));

import {
  CALLKIT_UUID_NAMESPACE,
  callKitUuid,
  createAndroidCallNotifier,
  createCallKitNotifier,
  createPlatformCallNotifier,
  registerBackgroundCallHandler,
  registerVoipPush,
  saveCallSession,
  useNativeCallNotifier,
  uuidv5,
  type KeyValueStorage,
  type NativeCallNotifier,
} from "../src/call-native";
import { flush } from "./helpers";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const realError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("react-test-renderer is deprecated")) return;
    realError(...args);
  };
});
afterAll(() => {
  console.error = realError;
});

describe("CallKit UUID (UUIDv5)", () => {
  it("matches Python's uuid.uuid5 reference vectors", () => {
    expect(CALLKIT_UUID_NAMESPACE).toBe("6ba7b811-9dad-11d1-80b4-00c04fd430c8");
    // python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org'))"
    expect(uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    // uuid.uuid5(uuid.NAMESPACE_URL, "commskit:call:<call_id>")
    expect(callKitUuid("abc123")).toBe("e8620149-bc0b-5d99-a6d4-642cae934e67");
    expect(callKitUuid("3f1c2b9e-0d1a-4f7e-9a6b-2c8d5e4f1a00")).toBe("7a7ec9ed-a366-55cd-b6b1-f90b03a512c5");
    // Shared with the backend's test suite (both sides pinned to the same values).
    expect(callKitUuid("call-123")).toBe("e394bb1f-a663-5750-8664-4de655ce4bf3");
    expect(callKitUuid("3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c")).toBe("653579da-f398-55b8-9545-46885f1e073e");
  });
});

const makeCallKeep = () => {
  const listeners: Record<string, (data: any) => void> = {};
  return {
    listeners,
    initialEvents: [] as any[],
    setup: jest.fn(async () => {}),
    addEventListener: jest.fn((name: string, fn: any) => (listeners[name] = fn)),
    removeEventListener: jest.fn((name: string) => delete listeners[name]),
    getInitialEvents: jest.fn(async function (this: any) {
      return this.initialEvents;
    }),
    clearInitialEvents: jest.fn(),
    displayIncomingCall: jest.fn(),
    reportEndCallWithUUID: jest.fn(),
    endCall: jest.fn(),
    startCall: jest.fn(),
    reportConnectedOutgoingCallWithUUID: jest.fn(),
    setCurrentCallActive: jest.fn(),
    setMutedCall: jest.fn(),
  };
};

describe("createCallKitNotifier", () => {
  afterEach(() => jest.useRealTimers());
  const uuid = callKitUuid("c1");

  it("reports an incoming call and delivers answer once the audio session is active", async () => {
    const CK = makeCallKeep();
    const n = createCallKitNotifier({ appName: "Demo", callKeep: CK });
    expect(CK.setup).toHaveBeenCalledWith(expect.objectContaining({ ios: expect.objectContaining({ appName: "Demo" }) }));
    n.showIncoming({ callId: "c1", peerId: "42", peerName: "Asha", callType: "audio" });
    expect(CK.displayIncomingCall).toHaveBeenCalledWith(uuid, "42", "Asha", "generic", false);
    n.showIncoming({ callId: "c1", peerId: "42", peerName: "Asha", callType: "audio" }); // no duplicate
    expect(CK.displayIncomingCall).toHaveBeenCalledTimes(1);

    const actions: string[] = [];
    CK.listeners.answerCall({ callUUID: uuid.toUpperCase() }); // before a handler exists: queued
    CK.listeners.didActivateAudioSession({});
    n.setActionHandler((a, id) => actions.push(`${a}:${id}`));
    expect(actions).toEqual(["answer:c1"]);

    n.dismiss("c1"); // answered: CallKit keeps the call
    expect(CK.reportEndCallWithUUID).not.toHaveBeenCalled();
    n.startOngoing({ callId: "c1", peerId: "42", peerName: "Asha", connectedAt: 1 });
    expect(CK.setCurrentCallActive).toHaveBeenCalledWith(uuid);
    expect(CK.startCall).not.toHaveBeenCalled();

    n.setMuted("c1", true);
    expect(CK.setMutedCall).toHaveBeenCalledWith(uuid, true);
    CK.listeners.didPerformSetMutedCallAction({ muted: true, callUUID: uuid }); // our own echo
    CK.listeners.didPerformSetMutedCallAction({ muted: false, callUUID: uuid }); // user in CallKit UI
    expect(actions).toEqual(["answer:c1", "unmute:c1"]);

    n.stopOngoing();
    expect(CK.endCall).toHaveBeenCalledWith(uuid);
    CK.listeners.endCall({ callUUID: uuid }); // echo of our endCall: ignored
    expect(actions).toEqual(["answer:c1", "unmute:c1"]);
    n.dispose();
    expect(CK.removeEventListener).toHaveBeenCalledWith("answerCall");
  });

  it("answer falls back to a timeout; CallKit end maps to decline (ringing) or hangup (active)", () => {
    jest.useFakeTimers();
    const CK = makeCallKeep();
    const n = createCallKitNotifier({ appName: "Demo", callKeep: CK, setup: false, answerAudioTimeoutMs: 500 });
    const actions: string[] = [];
    n.setActionHandler((a, id) => actions.push(`${a}:${id}`));
    n.showIncoming({ callId: "c1", callType: "audio" });
    CK.listeners.answerCall({ callUUID: uuid });
    expect(actions).toEqual([]);
    jest.advanceTimersByTime(500);
    expect(actions).toEqual(["answer:c1"]);
    CK.listeners.endCall({ callUUID: uuid });
    expect(actions).toEqual(["answer:c1", "hangup:c1"]);

    n.showIncoming({ callId: "c2", callType: "video" });
    expect(CK.displayIncomingCall).toHaveBeenLastCalledWith(callKitUuid("c2"), "Unknown", "Unknown", "generic", true);
    CK.listeners.endCall({ callUUID: callKitUuid("c2") });
    expect(actions).toEqual(["answer:c1", "hangup:c1", "decline:c2"]);
    n.dispose();
  });

  it("keeps calls reported from a VoIP push until dismissed by id or the ring timeout", async () => {
    jest.useFakeTimers();
    const CK = makeCallKeep();
    CK.initialEvents = [{ name: "RNCallKeepDidDisplayIncomingCall", data: { callUUID: "AAAA-UUID", payload: { call_id: "p1" } } }];
    const n = createCallKitNotifier({ appName: "Demo", callKeep: CK, ringTimeoutMs: 1000 });
    await flush();
    expect(n.uuidFor("p1")).toBe("aaaa-uuid");
    n.dismiss(); // cold-start leftovers sweep: the push call is kept
    expect(CK.reportEndCallWithUUID).not.toHaveBeenCalled();
    n.showIncoming({ callId: "p1", callType: "audio" }); // already on screen
    expect(CK.displayIncomingCall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(CK.reportEndCallWithUUID).toHaveBeenCalledWith("aaaa-uuid", 3);

    n.showIncoming({ callId: "c3", callType: "audio" });
    n.dismiss("c3");
    expect(CK.reportEndCallWithUUID).toHaveBeenLastCalledWith(callKitUuid("c3"), 2);
    n.startOngoing({ callId: "out1", peerName: "Ravi", connectedAt: 1 }); // outgoing call
    expect(CK.startCall).toHaveBeenCalledWith(callKitUuid("out1"), "Ravi", "Ravi", "generic", false);
    n.dispose();
  });

  it("throws a clear error when react-native-callkeep is missing", () => {
    expect(() => createCallKitNotifier({ appName: "x" })).toThrow(/react-native-callkeep/);
  });
});

describe("registerVoipPush", () => {
  it("forwards the token (deduplicated, also from cold-start events) and maps pushes to CallKit UUIDs", () => {
    const listeners: Record<string, (d: any) => void> = {};
    const Voip = {
      addEventListener: jest.fn((name: string, fn: any) => (listeners[name] = fn)),
      removeEventListener: jest.fn(),
      registerVoipToken: jest.fn(),
      onVoipNotificationCompleted: jest.fn(),
    };
    const tokens: string[] = [];
    const remembered: any[] = [];
    const calls: any[] = [];
    const off = registerVoipPush((t) => tokens.push(t), {
      voipPush: Voip,
      notifier: { rememberCall: (...a: any[]) => remembered.push(a) },
      onIncomingCall: (c) => calls.push(c.callId),
    });
    expect(Voip.registerVoipToken).toHaveBeenCalled();
    listeners.didLoadWithEvents([
      { name: "RNVoipPushRemoteNotificationsRegisteredEvent", data: "tok-1" },
      { name: "RNVoipPushRemoteNotificationReceivedEvent", data: { type: "incoming_call", call_id: "c9", uuid: "u-9", caller_name: "Asha" } },
    ]);
    listeners.register("tok-1");
    listeners.register("tok-2");
    expect(tokens).toEqual(["tok-1", "tok-2"]);
    expect(remembered).toEqual([["c9", "u-9"]]);
    expect(calls).toEqual(["c9"]);
    expect(Voip.onVoipNotificationCompleted).toHaveBeenCalledWith("u-9");
    off();
    expect(Voip.removeEventListener).toHaveBeenCalledWith("notification");
  });
});

const makeNotifee = () => {
  let foreground: ((e: any) => void) | null = null;
  let background: ((e: any) => Promise<void>) | null = null;
  const api = {
    createChannel: jest.fn(async () => "id"),
    displayNotification: jest.fn(async () => "id"),
    cancelNotification: jest.fn(async () => {}),
    stopForegroundService: jest.fn(async () => {}),
    registerForegroundService: jest.fn(),
    onForegroundEvent: jest.fn((fn: any) => {
      foreground = fn;
      return () => (foreground = null);
    }),
    onBackgroundEvent: jest.fn((fn: any) => (background = fn)),
    getInitialNotification: jest.fn(async (): Promise<any> => null),
  };
  return {
    api,
    AndroidImportance: { HIGH: 4, LOW: 2 },
    AndroidCategory: { CALL: "call" },
    AndroidVisibility: { PUBLIC: 1 },
    AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_PHONE_CALL: 4, FOREGROUND_SERVICE_TYPE_MICROPHONE: 128 },
    EventType: { PRESS: 1, ACTION_PRESS: 2 },
    fireForeground: (e: any) => foreground?.(e),
    fireBackground: (e: any) => background?.(e),
  };
};

describe("createAndroidCallNotifier", () => {
  it("shows a full-screen CATEGORY_CALL notification and routes Answer / Decline / Hang up", async () => {
    const notifee = makeNotifee();
    const n = createAndroidCallNotifier({ notifee });
    const actions: string[] = [];
    n.setActionHandler((a, id) => actions.push(`${a}:${id}`));
    await n.showIncoming({ callId: "c1", peerId: "42", peerName: "Asha", callType: "audio" });
    const shown = (notifee.api.displayNotification.mock.calls as any[])[0][0];
    expect(shown).toMatchObject({
      id: "commskit-call-c1",
      title: "Asha",
      data: { call_id: "c1", caller_id: "42", commskit: "incoming_call" },
      android: { channelId: "call_ringtone", category: "call", fullScreenAction: { id: "default" }, ongoing: true },
    });
    expect(shown.android.actions.map((a: any) => a.pressAction.id)).toEqual(["decline", "answer"]);

    notifee.fireForeground({ type: 2, detail: { pressAction: { id: "answer" }, notification: { data: shown.data } } });
    notifee.fireForeground({ type: 1, detail: { notification: { data: shown.data } } });
    notifee.fireForeground({ type: 2, detail: { pressAction: { id: "answer" }, notification: { data: { other: "x" } } } });
    expect(actions).toEqual(["answer:c1", "open:c1"]);
    await flush();
    expect(notifee.api.cancelNotification).toHaveBeenCalledWith("commskit-call-c1");

    await n.dismiss("c1");
    await n.startOngoing({ callId: "c1", peerName: "Asha", connectedAt: 123 });
    const ongoing = (notifee.api.displayNotification.mock.calls as any[])[1][0];
    expect(ongoing.android).toMatchObject({ asForegroundService: true, foregroundServiceTypes: [4, 128], timestamp: 123, channelId: "call_ongoing" });
    notifee.fireForeground({ type: 2, detail: { pressAction: { id: "hangup" }, notification: { data: ongoing.data } } });
    expect(actions[2]).toBe("hangup:c1");
    await n.stopOngoing();
    expect(notifee.api.stopForegroundService).toHaveBeenCalled();
    n.dispose();
  });

  it("picks up the cold-start Answer from getInitialNotification", async () => {
    const notifee = makeNotifee();
    notifee.api.getInitialNotification.mockResolvedValueOnce({
      pressAction: { id: "answer" },
      notification: { data: { commskit: "incoming_call", call_id: "c7" } },
    });
    const n = createAndroidCallNotifier({ notifee });
    await flush(10);
    const actions: string[] = [];
    n.setActionHandler((a, id) => actions.push(`${a}:${id}`));
    expect(actions).toEqual(["answer:c7"]);
    n.dispose();
  });
});

describe("registerBackgroundCallHandler", () => {
  const memoryStorage = (): KeyValueStorage => {
    const m = new Map<string, string>();
    return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
  };

  it("shows the call notification for a data-only push and declines over REST while killed", async () => {
    const notifee = makeNotifee();
    const tasks: Record<string, (body: any) => Promise<void>> = {};
    const TaskManager = { defineTask: jest.fn((name: string, fn: any) => (tasks[name] = fn)) };
    const Notifications = { registerTaskAsync: jest.fn(async () => {}) };
    const storage = memoryStorage();
    await saveCallSession({ baseUrl: "https://api.example.com", token: "stored-jwt" }, storage);
    const fetchCalls: any[] = [];
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"status":true}', json: async () => ({}) };
    });

    const h = registerBackgroundCallHandler({ taskManager: TaskManager, notifications: Notifications, notifee, storage });
    expect(Notifications.registerTaskAsync).toHaveBeenCalledWith("commskit-background-call");

    // Android background task payload: JSON string in data.body
    await tasks[h.taskName]({
      data: { data: { body: JSON.stringify({ type: "incoming_call", call_id: "k1", caller_id: "42", caller_name: "Asha", call_type: "audio" }) } },
    });
    const shown = (notifee.api.displayNotification.mock.calls as any[])[0][0];
    expect(shown).toMatchObject({ id: "commskit-call-k1", title: "Asha", data: { source: "push", call_id: "k1" } });

    await notifee.fireBackground({ type: 2, detail: { pressAction: { id: "decline" }, notification: { data: shown.data } } });
    expect(notifee.api.cancelNotification).toHaveBeenCalledWith("commskit-call-k1");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.example.com/call/k1/reject");
    expect(fetchCalls[0].init.method).toBe("POST");
    expect(fetchCalls[0].init.headers.Authorization).toBe("Bearer stored-jwt");

    // A running app instance takes the action instead of REST.
    const live = createAndroidCallNotifier({ notifee });
    const actions: string[] = [];
    live.setActionHandler((a, id) => actions.push(`${a}:${id}`));
    await h.handleNotifeeEvent({ type: 2, detail: { pressAction: { id: "decline" }, notification: { data: shown.data } } });
    expect(actions).toEqual(["decline:k1"]);
    expect(fetchCalls).toHaveLength(1);
    live.dispose();

    // Missed call push clears a stale call notification.
    await h.handlePush({ type: "missed_call", call_id: "k1", caller_id: "42" });
    expect(notifee.api.cancelNotification).toHaveBeenLastCalledWith("commskit-call-k1");
  });

  it("errors clearly when expo-task-manager is missing", () => {
    expect(() => registerBackgroundCallHandler()).toThrow(/expo-task-manager/);
  });
});

describe("createPlatformCallNotifier + useNativeCallNotifier", () => {
  it("is a no-op off iOS / Android", () => {
    expect(createPlatformCallNotifier({ ios: { appName: "x" }, os: "web" }).kind).toBe("none");
    expect(createPlatformCallNotifier({ ios: { appName: "x", callKeep: makeCallKeep() }, os: "ios" }).kind).toBe("callkit");
  });

  it("feeds actions into useCall(): CallKit answers directly, mute syncs, others go to handleNotificationAction", () => {
    let handler: any = null;
    const notifier: NativeCallNotifier = {
      kind: "callkit",
      showIncoming: () => {},
      dismiss: () => {},
      startOngoing: () => {},
      stopOngoing: () => {},
      setActionHandler: (h) => (handler = h),
      setMuted: jest.fn(),
      dispose: () => {},
    };
    const Harness = () => {
      useNativeCallNotifier(notifier);
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<Harness />);
    });
    handler("answer", "c1");
    expect(mockCall.accept).toHaveBeenCalled();
    handler("answer", "other");
    expect(mockCall.handleNotificationAction).toHaveBeenCalledWith("answer", "other");
    handler("decline", "c1");
    expect(mockCall.handleNotificationAction).toHaveBeenLastCalledWith("decline", "c1");
    handler("mute", "c1");
    expect(mockCall.toggleMute).toHaveBeenCalledTimes(1);
    mockCall.state = { callId: "c1", status: "connected" };
    mockCall.isMuted = true;
    act(() => r.update(<Harness />));
    expect(notifier.setMuted).toHaveBeenCalledWith("c1", true);
    act(() => r.unmount());
    expect(handler).toBeNull();
  });
});
