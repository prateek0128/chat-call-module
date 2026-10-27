import { Platform } from "react-native";
import { registerRootComponent } from "expo";
import { registerBackgroundCallHandler } from "commskit/call-native";

import App from "./App";

// Module scope, BEFORE registerRootComponent: the background task must exist when Android starts the
// app (killed) for a data-only `incoming_call` push. It shows the notifee full-screen call notification;
// Decline while killed calls POST /call/{id}/reject with the session saved by saveCallSession().
if (Platform.OS === "android") {
  try {
    registerBackgroundCallHandler();
  } catch (e) {
    console.warn("[demo] background call handler not registered", e);
  }
}

registerRootComponent(App);
