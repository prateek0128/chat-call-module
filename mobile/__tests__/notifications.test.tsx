/**
 * commskit/notifications: payload parsing, routing decisions, registerDevice / unregisterDevice
 * (fetch + expo-notifications / expo-device mocked as virtual modules), and the routing hook.
 */
import { act } from "react";
import TestRenderer from "react-test-renderer";

const mockNotifications = {
  AndroidImportance: { DEFAULT: 3, MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  getPermissionsAsync: jest.fn(async () => ({ status: "undetermined", granted: false })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted", granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[abc]" })),
  setNotificationChannelAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn((_fn: any) => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async (): Promise<any> => null),
  setNotificationHandler: jest.fn(),
};
const mockDevice = { isDevice: true, osName: "Android", osVersion: "14", modelName: "Pixel 8" };
jest.mock("expo-notifications", () => mockNotifications, { virtual: true });
jest.mock("expo-device", () => mockDevice, { virtual: true });

import {
  notificationPresentation,
  notificationTapTarget,
  parseNotificationData,
  registerDevice,
  unregisterDevice,
  useNotificationRouting,
} from "../src/notifications";

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

const chatData = { type: "chat", cid: "messaging:42", chat_id: 7, sender_id: "42" };
const callData = { type: "incoming_call", call_id: "c1", chat_id: 7, caller_id: "42", caller_name: "Asha", caller_avatar: "a.png", call_type: "audio" };

describe("parseNotificationData", () => {
  it("parses the plain data object", () => {
    expect(parseNotificationData(chatData)).toMatchObject({ type: "chat", peerId: "42", chatId: "7", senderId: "42", cid: "messaging:42" });
  });

  it("parses an Expo Notification and NotificationResponse", () => {
    const notification = { request: { identifier: "n1", content: { title: "Asha", body: "hi", data: chatData } } };
    expect(parseNotificationData(notification)).toMatchObject({ type: "chat", peerId: "42" });
    expect(parseNotificationData({ notification, actionIdentifier: "expo.modules.notifications.actions.DEFAULT" })).toMatchObject({ type: "chat", peerId: "42" });
  });

  it("parses the stringified body variant (Android data-only / background task)", () => {
    expect(parseNotificationData({ data: { body: JSON.stringify(callData), title: "x" } })).toMatchObject({
      type: "incoming_call",
      callId: "c1",
      callerName: "Asha",
      callType: "audio",
    });
    expect(parseNotificationData({ data: { dataString: JSON.stringify(chatData) } })).toMatchObject({ type: "chat", peerId: "42" });
    expect(parseNotificationData(JSON.stringify(callData))).toMatchObject({ type: "incoming_call", callId: "c1" });
  });

  it("peer falls back to sender_id; missed calls, unknown types and junk", () => {
    expect(parseNotificationData({ type: "chat", sender_id: 9 })).toMatchObject({ type: "chat", peerId: "9" });
    expect(parseNotificationData({ type: "missed_call", call_id: "c2", caller_id: "5", call_type: "video" })).toMatchObject({
      type: "missed_call",
      callerId: "5",
      callType: "video",
    });
    expect(parseNotificationData({ type: "promo" })).toMatchObject({ type: "unknown" });
    expect(parseNotificationData(null)).toBeNull();
    expect(parseNotificationData({ request: { content: { body: "not json" } } })).toBeNull();
    expect(parseNotificationData({ type: "incoming_call" })).toMatchObject({ type: "unknown" });
  });

  it("keeps the CallKit uuid of a VoIP payload", () => {
    expect(parseNotificationData({ ...callData, uuid: "u-1" })).toMatchObject({ uuid: "u-1" });
  });
});

describe("routing decisions", () => {
  it("tap on a message opens the chat with the peer from cid", () => {
    expect(notificationTapTarget({ notification: { request: { content: { data: chatData } } } })).toEqual({ kind: "chat", peerId: "42" });
  });
  it("tap on a missed call opens the chat with the caller; incoming call goes to the call handler", () => {
    expect(notificationTapTarget({ type: "missed_call", call_id: "c", caller_id: "5" })).toEqual({ kind: "chat", peerId: "5" });
    expect(notificationTapTarget(callData)).toMatchObject({ kind: "call", call: { callId: "c1" } });
    expect(notificationTapTarget({ type: "promo" })).toBeNull();
  });
  it("suppresses banners for the open chat only, and calls when the host handles them", () => {
    expect(notificationPresentation(chatData, { activePeerId: "42" }).show).toBe(false);
    expect(notificationPresentation(chatData, { activePeerId: "43" }).show).toBe(true);
    expect(notificationPresentation(chatData).show).toBe(true);
    expect(notificationPresentation(callData, { handlesCalls: true }).show).toBe(false);
    expect(notificationPresentation(callData).show).toBe(true);
  });
});

describe("registerDevice / unregisterDevice", () => {
  const calls: Array<{ url: string; init: any }> = [];
  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"status":true}', json: async () => ({ status: true }) };
    });
  });
  const config = { baseUrl: "https://api.example.com/", getToken: () => "jwt" };

  it("asks permission, creates the Android channels and POSTs /devices per §8", async () => {
    const res = await registerDevice({ config, deviceId: "dev-1", appVersion: "1.2.3", getVoipToken: () => null });
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalled();
    const channels = mockNotifications.setNotificationChannelAsync.mock.calls as any[];
    expect(channels.map((c) => c[0])).toEqual(["messages", "call_ringtone"]);
    expect(channels[0][1]).toMatchObject({ importance: 3 });
    expect(channels[1][1]).toMatchObject({ importance: 5, bypassDnd: true });
    expect(res).toMatchObject({ registered: true, deviceId: "dev-1", permission: "granted", expoPushToken: "ExponentPushToken[abc]" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/devices");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      device_id: "dev-1",
      platform: "android",
      expo_push_token: "ExponentPushToken[abc]",
      app_version: "1.2.3",
      os_version: "14",
      model: "Pixel 8",
    });
  });

  it("includes the VoIP token and derives a stable device id when none is given", async () => {
    const a = await registerDevice({ config, platform: "ios", getVoipToken: async () => "voip-tok" });
    const b = await registerDevice({ config, platform: "ios", getVoipToken: async () => "voip-tok" });
    expect(a.deviceId).toMatch(/^ios-[0-9a-f]{16}$/);
    expect(a.deviceId).toBe(b.deviceId);
    expect(mockNotifications.setNotificationChannelAsync).not.toHaveBeenCalled(); // iOS: no channels
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ platform: "ios", voip_token: "voip-tok", expo_push_token: "ExponentPushToken[abc]" });
  });

  it("does not register when permission is denied and there is no VoIP token", async () => {
    mockNotifications.requestPermissionsAsync.mockResolvedValueOnce({ status: "denied", granted: false });
    const res = await registerDevice({ config, deviceId: "d" });
    expect(res).toMatchObject({ registered: false, reason: "permission_denied", permission: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("unregisterDevice DELETEs /devices/{id} (defaults to the last registered device)", async () => {
    await registerDevice({ config, deviceId: "dev 2" });
    expect(await unregisterDevice()).toBe(true);
    expect(calls[1].url).toBe("https://api.example.com/devices/dev%202");
    expect(calls[1].init.method).toBe("DELETE");
    expect(await unregisterDevice()).toBe(false); // nothing left
  });
});

describe("useNotificationRouting", () => {
  const Harness = (props: any) => {
    useNotificationRouting(props);
    return null;
  };
  beforeEach(() => jest.clearAllMocks());

  it("routes cold-start and warm taps once each, and suppresses the open chat's banners", async () => {
    const coldStart = { notification: { request: { identifier: "n1", content: { data: chatData } } } };
    mockNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce(coldStart);
    const onOpenChat = jest.fn();
    const onIncomingCall = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<Harness onOpenChat={onOpenChat} onIncomingCall={onIncomingCall} suppressFor={() => "42"} />);
    });
    expect(onOpenChat).toHaveBeenCalledWith("42");
    const listener = (mockNotifications.addNotificationResponseReceivedListener.mock.calls[0] as any[])[0];
    listener(coldStart); // same notification delivered again: ignored
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    listener({ notification: { request: { identifier: "n2", content: { data: { type: "missed_call", caller_id: "7" } } } } });
    expect(onOpenChat).toHaveBeenLastCalledWith("7");
    listener({ notification: { request: { identifier: "n3", content: { data: callData } } } });
    expect(onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ callId: "c1" }));

    const handler = (mockNotifications.setNotificationHandler.mock.calls[0] as any[])[0];
    const open = await handler.handleNotification({ request: { content: { data: chatData } } });
    expect(open).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });
    const other = await handler.handleNotification({ request: { content: { data: { ...chatData, cid: "messaging:9" } } } });
    expect(other).toMatchObject({ shouldShowBanner: true, shouldShowList: true });

    act(() => r.unmount());
    expect(mockNotifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });
});
