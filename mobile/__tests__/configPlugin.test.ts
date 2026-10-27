/** Expo config plugin (app.plugin.js): pure transforms on sample manifest / plist / AppDelegate. Idempotent, marker-guarded. */
const plugin = require("../app.plugin.js");
const { transforms, constants } = plugin;

const SDK54_APP_DELEGATE = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    window = UIWindow(frame: UIScreen.main.bounds)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
}
`;

const sampleManifest = () => ({
  manifest: {
    $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
    "uses-permission": [{ $: { "android:name": "android.permission.INTERNET" } }, { $: { "android:name": "android.permission.VIBRATE" } }],
    application: [{ $: { "android:name": ".MainApplication" }, activity: [] }],
  },
});

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("config plugin", () => {
  it("exports a plugin function and its transforms", () => {
    expect(typeof plugin).toBe("function");
    expect(Object.keys(transforms).sort()).toEqual(
      ["addAndroidPermissions", "addBridgingHeaderImports", "addCallServices", "addVoipToAppDelegate", "applyAndroidManifest", "applyInfoPlist"].sort(),
    );
  });

  it("adds Android permissions and services once", () => {
    const m = transforms.applyAndroidManifest(transforms.applyAndroidManifest(sampleManifest(), {}), {});
    const perms = m.manifest["uses-permission"].map((p: any) => p.$["android:name"]);
    for (const p of constants.ANDROID_PERMISSIONS) expect(perms.filter((x: string) => x === p)).toHaveLength(1);
    expect(perms).toContain("android.permission.INTERNET");
    const services = m.manifest.application[0].service;
    const names = services.map((s: any) => s.$["android:name"]);
    expect(names).toEqual([
      "io.wazo.callkeep.VoiceConnectionService",
      "io.wazo.callkeep.RNCallKeepBackgroundMessagingService",
      "app.notifee.core.ForegroundService",
    ]);
    expect(services[0].$["android:permission"]).toBe("android.permission.BIND_TELECOM_CONNECTION_SERVICE");
    expect(services[0]["intent-filter"][0].action[0].$["android:name"]).toBe("android.telecom.ConnectionService");
    expect(services[2].$["tools:replace"]).toBe("android:foregroundServiceType");
    expect(m.manifest.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
    const bare = transforms.applyAndroidManifest(sampleManifest(), { callKeepService: false, notifeeForegroundService: false, androidPermissions: ["x.EXTRA"] });
    expect(bare.manifest.application[0].service).toEqual([]);
    expect(bare.manifest["uses-permission"].map((p: any) => p.$["android:name"])).toContain("x.EXTRA");
  });

  it("merges iOS background modes and the microphone string", () => {
    const plist = transforms.applyInfoPlist({ UIBackgroundModes: ["fetch", "audio"] }, {});
    expect(plist.UIBackgroundModes).toEqual(["fetch", "audio", "voip", "remote-notification"]);
    expect(plist.NSMicrophoneUsageDescription).toMatch(/microphone/);
    expect(transforms.applyInfoPlist({ NSMicrophoneUsageDescription: "keep" }, {}).NSMicrophoneUsageDescription).toBe("keep");
    expect(transforms.applyInfoPlist({}, { microphonePermission: "Calls need the mic" }).NSMicrophoneUsageDescription).toBe("Calls need the mic");
    expect(transforms.applyInfoPlist({}, { voip: false }).UIBackgroundModes).toEqual(["audio", "remote-notification"]);
  });

  it("patches the Swift AppDelegate with PushKit -> CallKit, idempotently", () => {
    const once = transforms.addVoipToAppDelegate(SDK54_APP_DELEGATE, "swift");
    const twice = transforms.addVoipToAppDelegate(once, "swift");
    expect(twice).toBe(once);
    expect(once).toMatch(/^import Expo\nimport PushKit \/\/ @commskit-voip-import$/m);
    expect(once).toMatch(/RNVoipPushNotificationManager\.voipRegistration\(\) \/\/ @commskit-voip-register\n\s+return super\.application/);
    expect(count(once, "extension AppDelegate: PKPushRegistryDelegate")).toBe(1);
    expect(once).toContain("RNCallKeep.reportNewIncomingCall(");
    expect(once).toContain("withCompletionHandler: completion");
    expect(once).toContain('data["uuid"]');
    expect(once).toContain(constants.MARK.begin);
    expect(once).toContain(constants.MARK.end);
    // The block between markers is regenerated (updates apply), the rest is untouched.
    const edited = once.replace("supportsDTMF: false", "supportsDTMF: true");
    expect(transforms.addVoipToAppDelegate(edited, "swift")).toBe(once);
    expect(() => transforms.addVoipToAppDelegate("@implementation AppDelegate", "objc")).toThrow(/Swift/);
    expect(() => transforms.addVoipToAppDelegate("import Expo\nclass X {}", "swift")).toThrow(/return super.application/);
  });

  it("adds the bridging header imports once", () => {
    const once = transforms.addBridgingHeaderImports("//\n// Use this file to import your target's public headers.\n//\n");
    expect(transforms.addBridgingHeaderImports(once)).toBe(once);
    expect(once).toContain('#import "RNCallKeep.h"');
    expect(once).toContain('#import "RNVoipPushNotificationManager.h"');
  });
});
